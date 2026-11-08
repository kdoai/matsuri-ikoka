import { expect, type Page, test } from "@playwright/test";
import {
  fakeSpeechRecognition as fakeRecognition,
  FAKE_HEARD as HEARD,
  talkToConcierge,
  withoutWebgl,
} from "./helpers";

// 声で話すボタン。ブラウザの音声認識の代わりを差し込み、押し方・焦点の移り方・送る前に確かめられることを見る。
// 実際の声やマイクの許可は使わない。

async function open(page: Page) {
  await withoutWebgl(page);
  await page.goto("/");
  await page.getByRole("button", { name: "入店する" }).click();
  await talkToConcierge(page);
}

const stopped = (page: Page) =>
  page.evaluate(() => (window as unknown as { __voice: { stopped: number } }).__voice.stopped);

test("はじめてキーで押すと説明が出て、選んだあとは押している間だけ聞き、入力欄で確かめてから送れる", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
  await fakeRecognition(page);
  await open(page);
  const mic = page.getByTestId("voice-input");
  const input = page.getByRole("textbox", { name: "相談の発言" });
  await mic.focus();
  await page.keyboard.down("Enter");
  await expect(page.getByRole("heading", { name: "声で話す前に" })).toBeFocused();
  await page.keyboard.up("Enter");
  await page.getByRole("button", { name: "声で話す", exact: true }).click();
  // 説明の欄は消え、焦点はマイクのボタンへ戻る
  await expect(page.getByTestId("voice-notice")).toHaveCount(0);
  await expect(mic).toBeFocused();

  await page.keyboard.down("Enter");
  await expect(page.getByTestId("voice-status")).toHaveText("聞いています。離すと止まります");
  await expect(mic).toHaveAttribute("title", "押している間だけ、声で話す");
  await page.keyboard.up("Enter");
  // 聞き取った文は送らずに入力欄へ入れ、焦点も入力欄へ移る
  await expect(input).toHaveValue(HEARD);
  await expect(input).toBeFocused();
  await expect(page.getByTestId("composer").getByRole("button", { name: "送る" })).toBeEnabled();
  await expect(page.getByTestId("consult")).toBeVisible();
});

test("マウスで短くクリックしたときは、離したら止める", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
  await fakeRecognition(page, { accepted: true });
  await open(page);
  await page.getByTestId("voice-input").click();
  await expect.poll(() => stopped(page)).toBe(1);
  await expect(page.getByRole("textbox", { name: "相談の発言" })).toHaveValue(HEARD);
});

test("押したことだけが届く操作では、押すと聞き続け、ボタンの外を押すと止める", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
  await fakeRecognition(page, { accepted: true });
  await open(page);
  const mic = page.getByTestId("voice-input");
  // スクリーンリーダーの決定のように、pointer を伴わない click だけを送る
  await mic.evaluate((element) => (element as HTMLButtonElement).click());
  await expect(page.getByTestId("voice-status")).toHaveText(
    "聞いています。もう一度押すと止まります",
  );
  await expect(mic).toHaveAttribute("title", "声で話す（もう一度押すと止まります）");
  expect(await stopped(page)).toBe(0);
  // 聞いたまま入力欄を押したら止める
  const input = page.getByRole("textbox", { name: "相談の発言" });
  await input.click();
  await expect.poll(() => stopped(page)).toBe(1);
  await expect(input).toHaveValue(HEARD);
});

test("声の機能がないブラウザでは、声のボタンを出さず、すべて文字で相談できる", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
  await page.addInitScript(() => {
    for (const name of [
      "SpeechRecognition",
      "webkitSpeechRecognition",
      "speechSynthesis",
      "SpeechSynthesisUtterance",
    ]) {
      Object.defineProperty(window, name, { value: undefined, configurable: true });
    }
  });
  await open(page);
  await expect(page.getByTestId("voice-input")).toHaveCount(0);
  await page.getByRole("button", { name: "設定" }).click();
  await expect(page.getByTestId("read-aloud-toggle")).toHaveCount(0);
  await page.keyboard.press("Escape");
  const input = page.getByRole("textbox", { name: "相談の発言" });
  await input.fill("みなと中央駅から行ける祭りはありますか");
  await input.press("Enter");
  await expect(page.getByTestId("consult")).toHaveCount(0);
});

test("マイクの許可を断っても、わけを出して、文字で相談を続けられる", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
  await fakeRecognition(page, { accepted: true, error: "not-allowed" });
  await open(page);
  await page.getByTestId("voice-input").click();
  await expect(page.getByTestId("voice-status")).toHaveText(
    "マイクを使えませんでした。文字で相談を続けられます。",
  );
  const input = page.getByRole("textbox", { name: "相談の発言" });
  await input.fill("みなと中央駅から行ける祭りはありますか");
  await input.press("Enter");
  await expect(page.getByTestId("consult")).toHaveCount(0);
});
