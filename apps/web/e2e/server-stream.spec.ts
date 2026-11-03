import { expect, test } from "@playwright/test";
import { blockMapTiles, openLog, talkToConcierge } from "./helpers";

// 接客サーバーにつなぐときの受け取り方。サーバーの代わりに、SSE の返答をテストの中で返す。

const PREFERENCES = { party: "adults", spot: "auto", food: "stalls", move: "train" };

function sse(events: { type: string; data: unknown }[]): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
}

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
  await blockMapTiles(page);
  await page.route("**/api/session", (route) => route.fulfill({ json: { sessionId: "s-test" } }));
});

test("done の前に接続が切れたら「もう一度送る」を出し、送り直せる", async ({ page }) => {
  let calls = 0;
  const bodies: unknown[] = [];
  await page.route("**/api/chat", async (route) => {
    calls += 1;
    bodies.push(route.request().postDataJSON());
    const delta = {
      type: "message.delta",
      data: { messageId: `m-${calls}`, text: "少々お待ちください。" },
    };
    const body =
      calls === 1
        ? // 1回目は done を送らずに切れる（空のコメント行も混ぜる）
          `: keep-alive\n\n${sse([delta])}`
        : sse([
            delta,
            {
              type: "done",
              data: {
                stage: "hearing",
                conditions: { origin: "みなと中央駅" },
                preferences: PREFERENCES,
              },
            },
          ]);
    await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body });
  });

  await page.goto("/?scene=2d");
  await page.getByRole("button", { name: "入店する" }).click();
  await talkToConcierge(page);
  const input = page.getByRole("textbox", { name: "相談の発言" });
  await input.fill("みなと中央駅から行ける祭りはありますか");
  await input.press("Enter");

  const retry = page.getByRole("button", { name: "もう一度送る" });
  await expect(retry).toBeVisible();
  await expect(page.getByTestId("dialogue-error")).toContainText("接続が切れました");
  await retry.click();

  // 読み取れた条件は、左下の旅の日と出発の駅に出る
  await expect(page.getByTestId("date-badge")).toContainText("みなと中央駅から");
  await expect(retry).toHaveCount(0);
  expect(calls).toBe(2);
  expect(bodies[1]).toMatchObject({
    sessionId: "s-test",
    message: "みなと中央駅から行ける祭りはありますか",
    preferences: PREFERENCES,
  });
  await openLog(page);
  await expect(page.getByTestId("chat-user")).toHaveCount(1);
});

test("サーバーのエラーは一文だけを出し、HTML として埋め込まない", async ({ page }) => {
  await page.route("**/api/chat", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: sse([
        {
          type: "message.delta",
          data: { messageId: "m-1", text: "<img src=x onerror=alert(1)><b>太字</b>" },
        },
        {
          type: "error",
          data: { code: "rate_limited", message: "今日の相談はここまでです", retryable: false },
        },
        {
          type: "done",
          data: { stage: "hearing", conditions: {}, preferences: PREFERENCES },
        },
      ]),
    }),
  );
  await page.goto("/?scene=2d");
  await page.getByRole("button", { name: "入店する" }).click();
  await talkToConcierge(page);
  const input = page.getByRole("textbox", { name: "相談の発言" });
  await input.fill("こんにちは");
  await input.press("Enter");

  await expect(page.getByTestId("dialogue-error")).toHaveText("今日の相談はここまでです");
  await expect(page.getByRole("button", { name: "もう一度送る" })).toHaveCount(0);
  // 文字列として出す（タグは解釈されない）
  await openLog(page);
  await expect(page.getByTestId("chat-concierge")).toContainText("<b>太字</b>");
  await expect(page.getByTestId("chat-concierge").locator("img, b")).toHaveCount(0);
});

test("英語の画面では、サーバーの日本語の一文ではなく辞書の文言を出す", async ({ page }) => {
  await page.route("**/api/chat", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: sse([
        {
          type: "error",
          data: { code: "rate_limited", message: "今日の相談はここまでです", retryable: false },
        },
        { type: "done", data: { stage: "hearing", conditions: {}, preferences: PREFERENCES } },
      ]),
    }),
  );
  await page.goto("/?scene=2d");
  await page.getByRole("button", { name: /English/ }).click();
  await page.getByRole("button", { name: "Come in" }).click();
  await talkToConcierge(page, "Talk to the concierge");
  const input = page.getByRole("textbox", { name: "Your message" });
  await input.fill("Hello");
  await input.press("Enter");
  await expect(page.getByTestId("dialogue-error")).toHaveText(
    "Today's conversation limit has been reached.",
  );
});
