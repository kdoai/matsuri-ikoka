import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SampleConversationSchema } from "@matsuri-ikoka/schema";
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));

/** 見直し用のスクリーンショットの置き場所（Git の対象外） */
export const SCREENSHOT_DIR =
  process.env.E2E_SCREENSHOT_DIR ?? join(here, "../test-results/screens");

/** 地図のタイルは取りに行かない（E2E_ALLOW_TILES=1 のときだけ取る） */
export async function blockMapTiles(page: Page): Promise<void> {
  if (process.env.E2E_ALLOW_TILES === "1") {
    return;
  }
  await page.route("https://tile.openstreetmap.org/**", (route) => route.abort());
}

export async function snap(page: Page, info: TestInfo, name: string, fullPage = false) {
  const dir = join(SCREENSHOT_DIR, info.project.name);
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage });
}

/** 接客サーバー（mock）が再生する記録した相談。発言は記録のとおりに送る */
export const SAMPLE = SampleConversationSchema.parse(
  JSON.parse(
    readFileSync(join(here, "../../../data/samples/conversations/suzunari-day-trip.json"), "utf8"),
  ),
);

/** 店に入り、相談を始められる状態にする */
export async function enterShop(page: Page, query = "?scene=2d"): Promise<void> {
  await page.goto(`/${query}`);
  await page.getByRole("button", { name: "入店する" }).click();
  await expect(page.getByRole("textbox", { name: "相談の発言" })).toBeEnabled();
}

/** 記録の index 番目の発言を入れて送る */
export async function sendSampleMessage(page: Page, index: number): Promise<void> {
  const message = SAMPLE.turns[index]?.request.message;
  if (message === undefined) throw new Error(`記録に ${index} 番目の発言がありません`);
  const input = page.getByRole("textbox", { name: "相談の発言" });
  await expect(input).toBeEnabled();
  await input.fill(message);
  await input.press("Enter");
}

/** 返答が終わるまで待つ（送るボタンが「返答を待っています」から戻る） */
export async function waitForReply(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "返答を待っています" })).toHaveCount(0, {
    timeout: 20_000,
  });
}

/** 旅程・地図・出典のパネルが閉じていれば、旅程詳細から開く（狭い画面ではメニューから） */
export async function openPanel(page: Page): Promise<void> {
  if (await page.getByTestId("itinerary-panel").isVisible()) {
    return;
  }
  const hint = page.getByTestId("button-hints").getByRole("button", { name: "旅程詳細" });
  if (await hint.isVisible()) {
    await hint.click();
  } else {
    await page.getByRole("button", { name: "メニュー", exact: true }).click();
    await page.getByTestId("game-menu").getByRole("button", { name: "旅程詳細" }).click();
  }
  await expect(page.getByTestId("itinerary-panel")).toBeVisible();
}

/** 旅のこだわりの板を開く（条件と、こだわりの切り替え） */
export async function openPreferences(page: Page): Promise<void> {
  await page.getByRole("button", { name: "旅のこだわり" }).click();
  await expect(page.locator("#hud-preferences")).toBeVisible();
}

/** 会話の記録を開く（これまでのやりとりと、スタッフ全員のようす） */
export async function openLog(page: Page): Promise<void> {
  // 候補カードが開いていれば、閉じてから
  if (await page.getByTestId("candidates").isVisible()) {
    await page.keyboard.press("Escape");
  }
  await page.getByRole("button", { name: "お知らせ（会話の記録）" }).click();
  await expect(page.getByTestId("backlog")).toBeVisible();
}

export async function closeLog(page: Page): Promise<void> {
  await page.getByTestId("backlog").getByRole("button", { name: "閉じる" }).click();
  await expect(page.getByTestId("backlog")).toHaveCount(0);
}

/** Tab だけで、その部品に焦点を移す（キーボードだけで操作できるかを確かめる） */
export async function tabTo(page: Page, target: Locator, limit = 80): Promise<void> {
  for (let i = 0; i < limit; i++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Tab で焦点を移せませんでした");
}

/**
 * 返答を待つ間だけ出る文（スタッフの吹き出し・豆知識係など）を、出たときに書き留める。
 * 記録の再生が速い・描画が遅い環境でも、出たかどうかをあとから確かめられる。
 * 発言を送る前に呼び、返答のあとで seenTexts で読む。
 */
export async function recordTexts(page: Page, selectors: readonly string[]): Promise<void> {
  await page.evaluate((list) => {
    const seen: Record<string, string[]> = {};
    for (const selector of list) seen[selector] = [];
    const read = () => {
      for (const selector of list) {
        for (const element of document.querySelectorAll(selector)) {
          const text = element.textContent ?? "";
          const bucket = seen[selector];
          if (text !== "" && bucket !== undefined && !bucket.includes(text)) bucket.push(text);
        }
      }
    };
    read();
    new MutationObserver(read).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    (window as unknown as { __seenTexts: Record<string, string[]> }).__seenTexts = seen;
  }, selectors);
}

/** recordTexts で書き留めた文（出た順） */
export async function seenTexts(page: Page, selector: string): Promise<string[]> {
  return page.evaluate(
    (key) =>
      (window as unknown as { __seenTexts?: Record<string, string[]> }).__seenTexts?.[key] ?? [],
    selector,
  );
}
