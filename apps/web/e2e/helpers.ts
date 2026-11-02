import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, type TestInfo } from "@playwright/test";

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

/** 店に入り、相談を始められる状態にする */
export async function enterShop(page: Page, query = "?speed=4"): Promise<void> {
  await page.goto(`/${query}`);
  await page.getByRole("button", { name: "入店する" }).click();
  await expect(page.getByRole("textbox", { name: "相談の発言" })).toBeEnabled();
}

/** 記録の次の発言を入れて送る */
export async function sendSampleMessage(page: Page): Promise<void> {
  await page.getByRole("button", { name: "記録の発言を入れる" }).click();
  const input = page.getByRole("textbox", { name: "相談の発言" });
  await expect(input).not.toHaveValue("");
  await input.press("Enter");
}

/** 返答が終わるまで待つ（送るボタンが「返答を待っています」から戻る） */
export async function waitForReply(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "返答を待っています" })).toHaveCount(0, {
    timeout: 20_000,
  });
}

/** スマートフォンでは、旅程・地図・出典のパネルを開く */
export async function openPanel(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: "旅程・地図・出典を開く" });
  if (await toggle.isVisible()) {
    await toggle.click();
  }
}
