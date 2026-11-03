import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { blockMapTiles, openLog, waitForReply } from "./helpers";

// 接客サーバーとのつなぎ：合言葉、SSE の前の断り、相談の作り直し、記録の名前、祭りのデータ、しおりの共有。
// サーバーの代わりに、記録した架空の相談のイベントをテストの中で SSE として返す。

const here = dirname(fileURLToPath(import.meta.url));
const sample = JSON.parse(
  readFileSync(join(here, "../../../data/samples/conversations/suzunari-day-trip.json"), "utf8"),
) as {
  turns: { request: { message: string }; events: { event: { type: string; data: unknown } }[] }[];
};

const PASSCODE = "matsuri";
const firstMessage = sample.turns[0]?.request.message ?? "";

function sse(events: { type: string; data: unknown }[]): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
}

function apiError(code: string, message: string, retryable: boolean) {
  return { code, message, retryable };
}

interface FakeServer {
  sessionBodies: unknown[];
  chatBodies: { sessionId: string; message: string }[];
}

/** 合言葉を確かめ、発言ごとに記録の次の返答を流す、テスト用の接客サーバー */
async function fakeServer(
  page: Page,
  options: { passcode?: string | null; loseFirstSession?: boolean } = {},
): Promise<FakeServer> {
  const passcode = options.passcode === undefined ? null : options.passcode;
  const server: FakeServer = { sessionBodies: [], chatBodies: [] };
  let turn = 0;
  let sessions = 0;
  const authorized = (header: string | undefined) => passcode === null || header === passcode;

  await page.route("**/api/session", (route) => {
    if (!authorized(route.request().headers()["x-access-passcode"])) {
      return route.fulfill({
        status: 401,
        json: apiError("unauthorized", "合言葉が違います。", false),
      });
    }
    sessions += 1;
    server.sessionBodies.push(route.request().postDataJSON());
    return route.fulfill({ status: 201, json: { sessionId: `s-${sessions}` } });
  });

  await page.route("**/api/chat", (route) => {
    if (!authorized(route.request().headers()["x-access-passcode"])) {
      return route.fulfill({
        status: 401,
        json: apiError("unauthorized", "合言葉が違います。", false),
      });
    }
    const body = route.request().postDataJSON() as { sessionId: string; message: string };
    server.chatBodies.push(body);
    if (options.loseFirstSession && body.sessionId === "s-1") {
      return route.fulfill({
        status: 404,
        json: apiError("bad_request", "相談が見つかりません。新しく始めてください。", false),
      });
    }
    const events = sample.turns[turn]?.events.map((recorded) => recorded.event) ?? [];
    turn += 1;
    return route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: sse(events),
    });
  });

  // 祭りのデータは、まだない（一覧は空、1件は掲載停止や見つからないときと同じ 404）
  await page.route("**/api/festivals", (route) => route.fulfill({ json: { festivals: [] } }));
  await page.route("**/api/festivals/**", (route) =>
    route.fulfill({ status: 404, json: apiError("bad_request", "祭りが見つかりません。", false) }),
  );
  return server;
}

async function send(page: Page, message: string) {
  const input = page.getByRole("textbox", { name: "相談の発言" });
  await input.fill(message);
  await input.press("Enter");
  await waitForReply(page);
}

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
  await blockMapTiles(page);
});

test("合言葉の要る店では、入口で聞き、すべての /api の呼び出しにヘッダーで付ける", async ({
  page,
}) => {
  const server = await fakeServer(page, { passcode: PASSCODE });
  await page.goto("/?sample=suzunari-day-trip&scene=2d");
  await page.getByRole("button", { name: "入店する" }).click();

  const form = page.getByTestId("passcode-form");
  await expect(form).toBeVisible();
  // ヘッダーで送れない文字は、送る前に入力欄で知らせる
  await form.getByLabel("合言葉").fill("まつり");
  await form.getByRole("button", { name: "入る" }).click();
  await expect(form).toContainText("半角の英数字と記号で");
  expect(server.sessionBodies).toEqual([]);

  await form.getByLabel("合言葉").fill("wrong");
  await form.getByRole("button", { name: "入る" }).click();
  await expect(page.getByTestId("passcode-form")).toContainText("合言葉が違います。");

  await form.getByLabel("合言葉").fill(PASSCODE);
  await form.getByRole("button", { name: "入る" }).click();
  await expect(page.getByRole("textbox", { name: "相談の発言" })).toBeEnabled();
  // 合言葉は URL に入れない。記録の名前は、相談を始める本文で渡す
  expect(page.url()).not.toContain(PASSCODE);
  expect(server.sessionBodies).toEqual([{ sample: "suzunari-day-trip" }]);

  await send(page, firstMessage);
  await expect(page.getByTestId("candidate-card")).toHaveCount(2);
  expect(server.chatBodies).toHaveLength(1);
});

test("相談の途中で合言葉を求められたら聞き直し、入れ直すと同じ発言を送り直す", async ({ page }) => {
  let required = false;
  let chats = 0;
  await page.route("**/api/session", (route) =>
    route.fulfill({ status: 201, json: { sessionId: "s-1" } }),
  );
  await page.route("**/api/chat", (route) => {
    chats += 1;
    if (route.request().headers()["x-access-passcode"] !== PASSCODE) {
      required = true;
      return route.fulfill({
        status: 401,
        json: apiError("unauthorized", "合言葉が違います。", false),
      });
    }
    return route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: sse(sample.turns[0]?.events.map((recorded) => recorded.event) ?? []),
    });
  });
  await page.goto("/?scene=2d");
  await page.getByRole("button", { name: "入店する" }).click();
  await send(page, "8月16日に行ける祭り");

  const dialog = page.getByRole("dialog", { name: "合言葉" });
  await expect(dialog).toBeVisible();
  expect(required).toBe(true);
  await dialog.getByLabel("合言葉").fill(PASSCODE);
  await dialog.getByRole("button", { name: "入れて送り直す" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("candidate-card")).toHaveCount(2);
  expect(chats).toBe(2);
  await openLog(page);
  await expect(page.getByTestId("chat-user")).toHaveCount(1);
});

test("相談が見つからない（404）ときは、新しい相談を自動で始め、送り直すと新しい相談に送る", async ({
  page,
}) => {
  const server = await fakeServer(page, { loseFirstSession: true });
  await page.goto("/?scene=2d");
  await page.getByRole("button", { name: "入店する" }).click();
  await send(page, firstMessage);

  await expect(page.getByTestId("dialogue-error")).toContainText("新しい相談を始めました");
  await page.getByRole("button", { name: "もう一度送る" }).click();
  await waitForReply(page);
  await expect(page.getByTestId("candidate-card")).toHaveCount(2);
  expect(server.chatBodies.map((body) => body.sessionId)).toEqual(["s-1", "s-2"]);
});

test("接客サーバーとしおりまで進むと、しおりの URL を出し、祭りのデータがなくても旅程は読める", async ({
  page,
}) => {
  await fakeServer(page);
  await page.goto("/?scene=2d");
  await page.getByRole("button", { name: "入店する" }).click();
  for (const turn of sample.turns) {
    if (await page.getByTestId("candidates").isVisible()) {
      await page.getByRole("button", { name: "この祭りにする" }).first().click();
      await waitForReply(page);
      continue;
    }
    await send(page, turn.request.message);
  }
  await expect(page.getByTestId("verification")).toContainText("予定どおり開催されます");

  await page.getByRole("tab", { name: "地図" }).click();
  // 動かせる地図は、画像ではなく領域として読ませる
  await expect(page.getByRole("region", { name: "旅程の地図" })).toBeVisible();
  await expect(page.getByRole("img", { name: "旅程の地図" })).toHaveCount(0);

  await page.getByRole("button", { name: "旅のしおりを開く" }).first().click();
  const share = page.getByTestId("shiori-share");
  await expect(share.getByRole("link")).toHaveAttribute("href", /\/shiori\/trip-suzunari-sample$/);
  await expect(page.getByTestId("shiori-main")).toContainText(
    "祭りの詳しい情報は、いまはお出しできません。",
  );
  await expect(page.getByTestId("shiori-flow")).toContainText("鈴鳴灯籠まつり");
  await expect(page.getByTestId("shiori-share-printed")).toContainText(
    "/shiori/trip-suzunari-sample",
  );
});
