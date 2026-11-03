import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { blockMapTiles, openPanel, waitForReply } from "./helpers";

// 接客サーバーをモック（MATSURI_AGENT_MODE=mock）で動かし、画面から本物の通信（SSE）で相談を通す。
// サーバーは別に起動しておき（CI の e2e のジョブ）、E2E_MOCK_SERVER=1 のときだけ走らせる。
// 画面の開発サーバーは /api と /shiori を MATSURI_SERVER_ORIGIN（既定は :8787）へ中継する。

const here = dirname(fileURLToPath(import.meta.url));
const sample = JSON.parse(
  readFileSync(join(here, "../../../data/samples/conversations/suzunari-day-trip.json"), "utf8"),
) as { id: string; turns: { request: { message: string } }[] };

test.beforeEach(async ({ page }, info) => {
  test.skip(process.env.E2E_MOCK_SERVER !== "1", "接客サーバーのモックが動いているときだけ");
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
  await blockMapTiles(page);
});

async function send(page: import("@playwright/test").Page, message: string) {
  if (await page.getByTestId("candidates").isVisible()) {
    await page.keyboard.press("Escape");
  }
  const input = page.getByRole("textbox", { name: "相談の発言" });
  await expect(input).toBeEnabled();
  await input.fill(message);
  await input.press("Enter");
  await waitForReply(page);
}

test("接客サーバーのモックと SSE でつながり、候補から旅程まで進める", async ({ page }) => {
  const chats: number[] = [];
  page.on("response", (res) => {
    if (res.url().endsWith("/api/chat")) chats.push(res.status());
  });

  await page.goto(`/?transport=server&sample=${sample.id}&scene=2d`);
  await page.getByRole("button", { name: "入店する" }).click();
  // 画面だけのモックの注意書きは出ない
  await expect(page.getByTestId("mock-note")).toHaveCount(0);

  const [first, second] = sample.turns;
  await send(page, first?.request.message ?? "");
  await expect(page.getByTestId("candidate-card").first()).toBeVisible();

  await send(page, second?.request.message ?? "");
  await openPanel(page);
  await expect(page.getByTestId("itinerary-panel")).toBeVisible();

  expect(chats).toEqual([200, 200]);
});
