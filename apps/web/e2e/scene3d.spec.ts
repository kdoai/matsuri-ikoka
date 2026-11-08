import { expect, type Page, test } from "@playwright/test";
import {
  blockMapTiles,
  recordTexts,
  seenTexts,
  sendSampleMessage,
  snap,
  talkToConcierge,
  waitForReply,
  withoutWebgl,
} from "./helpers";

// 3D の店：外観から入店し、店内でスタッフがストアの状態どおりに動く。
// 動きを減らす設定でも 3D を出す。WebGL が使えないときは 2D に切り替えず、その知らせを出して相談を続けられる。

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
  await blockMapTiles(page);
});

test("店の外観を見せてから入店し、店内のスタッフが持ち場へ向かって吹き出しを出す", async ({
  page,
}, info) => {
  // GPU のない環境では 3D の読み込みと描画が遅いので、余裕を持たせる
  test.setTimeout(300_000);
  await page.goto("/");
  await expect(page.locator('[data-testid="storefront-scene"][data-ready="true"]')).toBeVisible({
    timeout: 60_000,
  });
  await snap(page, info, "40-storefront-3d");

  // 店内を読み込む間は、店の外観のまま待つ
  await page.getByRole("button", { name: "入店する" }).click();
  await expect(page.getByTestId("shop-entering")).toBeVisible();
  const scene = page.locator('[data-testid="shop-scene"]');
  await expect(scene).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  // 入店のカメラが終わると、コンシェルジュが「話しかけてね」と案内する。会話の窓はまだ出さない
  await expect(page.getByTestId("greeting-bubble")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("dialogue")).toBeHidden();
  await snap(page, info, "41-shop-3d");
  await talkToConcierge(page);

  // 吹き出しは作業の間だけ出るので、出たときに書き留めて、返答のあとで確かめる
  const bubble = '[data-testid="speech-bubble"][data-bubble="researcher"]';
  const dialogue = '[data-testid="dialogue"]';
  const activity = '[data-testid="staff-activity"]';
  await recordTexts(page, [bubble, dialogue, activity]);
  await sendSampleMessage(page, 0);
  await snap(page, info, "42-shop-3d-working");
  await waitForReply(page);
  // 3D の吹き出しと同じ文は、会話の窓と店内のようすでも文字で読める
  for (const selector of [bubble, dialogue, activity]) {
    expect((await seenTexts(page, selector)).join()).toContain("祭りを探しています");
  }
  // コンシェルジュの頼みと、頭の上のようすも、店内のようすで文字として読める
  const activities = (await seenTexts(page, activity)).join();
  expect(activities).toContain("コンシェルジュ → 祭り調査係");
  expect(activities).toContain("調べている");
});

/** 旅人の床の上の位置（店の要素の data-player） */
async function playerAt(page: Page): Promise<{ x: number; z: number }> {
  const value = (await page.getByTestId("shop-scene").getAttribute("data-player")) ?? "0,0";
  const [x, z] = value.split(",").map(Number);
  return { x: x ?? 0, z: z ?? 0 };
}

/** その条件になるまでキーを押し続ける（描画が遅い環境でも同じところまで歩く） */
async function holdUntil(
  page: Page,
  key: string,
  done: (at: { x: number; z: number }) => boolean,
  timeout = 20_000,
): Promise<{ x: number; z: number }> {
  await page.keyboard.down(key);
  const until = Date.now() + timeout;
  let at = await playerAt(page);
  while (!done(at) && Date.now() < until) {
    await page.waitForTimeout(100);
    at = await playerAt(page);
  }
  await page.keyboard.up(key);
  return at;
}

test("旅人を歩かせ、仕掛けを使い、カメラを回し、柵で止まり、カウンターで話しかける", async ({
  page,
}, info) => {
  // 描画の遅い環境（GPU のない CI）では歩くのにも時間がかかるので、長めにとる
  test.setTimeout(300_000);
  await page.goto("/");
  await page.getByRole("button", { name: "入店する" }).click();
  const scene = page.getByTestId("shop-scene");
  await expect(scene).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  // 操作の案内と、近くにあるものが文字で読める。描画の遅い環境でも待てるよう長めに待つ
  await expect(page.getByTestId("play-guide")).toContainText("WASD", { timeout: 60_000 });
  const prompt = page.getByTestId("play-prompt");
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  const label = (await prompt.textContent())?.replace(/^E/, "") ?? "";
  await expect(page.getByTestId("play-status")).toContainText(label);
  await page.keyboard.press("e");
  await expect(page.getByTestId("play-notice")).toBeVisible();

  // カメラ：Q で回すと、カメラの位置が変わる。旅人は動かない
  const camera = async () => (await scene.getAttribute("data-camera")) ?? "";
  const before = await camera();
  const startAt = await playerAt(page);
  await page.keyboard.down("q");
  await page.waitForTimeout(800);
  await page.keyboard.up("q");
  await expect.poll(camera, { timeout: 10_000 }).not.toBe(before);
  expect(await playerAt(page)).toEqual(startAt);
  // ドラッグでも回り、タップにはならない（旅人は歩き出さない）
  const box = await scene.boundingBox();
  if (box !== null) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 3, { steps: 8 });
    await page.mouse.up();
  }
  await page.waitForTimeout(500);
  expect(await playerAt(page)).toEqual(startAt);
  // V でいつもの見え方に戻してから歩く（WASD は画面の向きに合わせて進む）
  await page.keyboard.press("v");
  await page.waitForTimeout(1_000);

  // 奥へ、それから右へ歩いてカウンターの前へ
  const start = await playerAt(page);
  await holdUntil(page, "w", (at) => at.z < start.z - 0.6);
  const front = await holdUntil(page, "d", (at) => at.x > 0);
  expect(front.x).toBeGreaterThan(start.x + 1);
  await snap(page, info, "43-player-walk");

  // 奥へ進み続けても、従業員の区域（カウンターの裏）には入れない
  const stopped = await holdUntil(page, "w", () => false, 2_500);
  expect(stopped.z).toBeGreaterThan(1);

  await expect(prompt).toContainText("コンシェルジュと話す");
  await page.keyboard.press("e");
  await expect(page.getByTestId("dialogue")).toBeVisible();
  await expect(page.getByTestId("consult-choice").first()).toBeFocused();
  // 会話の窓をしまうと、また歩ける
  await page.getByTestId("dialogue-close").click();
  await expect(page.getByTestId("dialogue")).toBeHidden();
  const atCounter = await playerAt(page);
  const back = await holdUntil(page, "s", (at) => at.z > atCounter.z + 0.2, 10_000);
  expect(back.z).toBeGreaterThan(atCounter.z);
});

test("入口で通りへ向かって進むと、のれんをくぐって店の外へ出て、また入れる", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/");
  await page.getByRole("button", { name: "入店する" }).click();
  await expect(page.getByTestId("greeting-bar")).toBeVisible({ timeout: 90_000 });
  // 入店して立つ位置は入口のすぐ内側。通り（画面の手前）へ向かって進む
  await page.keyboard.down("s");
  await expect(page.getByRole("button", { name: "入店する" })).toBeVisible({ timeout: 60_000 });
  await page.keyboard.up("s");
  await expect(page.getByTestId("shop-scene")).toHaveCount(0);
  // また入ると、相談はそのまま続き、もう一度「話しかけてね」と案内する
  await page.getByRole("button", { name: "入店する" }).click();
  await expect(page.getByTestId("greeting-bar")).toBeVisible({ timeout: 90_000 });
});

test("聞き取りの入力欄の段階で窓のどこをクリックしても入力欄に入り、打った文字で旅人は動かない", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto("/");
  await page.getByRole("button", { name: "入店する" }).click();
  // 入店の直後（相談を始める途中でも）に話しかける
  await talkToConcierge(page);
  const scene = page.getByTestId("shop-scene");
  const start = await playerAt(page);
  // 出発の駅の段階まで答え、会話の窓の、入力欄でないところ（話し手の一言のあたり）をクリックしてから打つ
  const consult = page.getByTestId("consult");
  for (const name of ["旅行計画から探す", "ひとりで", "今週末", "日帰り"]) {
    await consult.getByRole("button", { name, exact: true }).click();
  }
  await page.getByTestId("dialogue-line").click();
  const input = consult.getByRole("textbox", { name: "最寄りの駅" });
  await expect(input).toBeFocused();
  await page.keyboard.type("wasd sawd");
  await expect(input).toHaveValue("wasd sawd");
  await page.waitForTimeout(800);
  expect(await playerAt(page)).toEqual(start);
  await expect(scene).toHaveAttribute("data-player", `${start.x.toFixed(2)},${start.z.toFixed(2)}`);
});

test("WebGL が使えないときは、2D に切り替えずに知らせを出し、相談は続けられる", async ({
  page,
}) => {
  await withoutWebgl(page);
  await page.goto("/");
  await expect(page.getByTestId("storefront-scene")).toHaveCount(0);
  await expect(page.getByTestId("no-3d")).toBeVisible();
  await page.getByRole("button", { name: "入店する" }).click();
  await talkToConcierge(page);
  await expect(page.getByTestId("shop-scene")).toHaveCount(0);
  await expect(page.getByTestId("no-3d")).toBeVisible();
  await sendSampleMessage(page, 0);
  await expect(page.getByTestId("staff-activity")).toContainText("祭り調査係");
  await waitForReply(page);
});

test("動きを減らす設定でも、3D の店の外観を出す", async ({ page }) => {
  // GPU のない環境では 3D の読み込みと描画が遅いので、余裕を持たせる
  test.setTimeout(180_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator('[data-testid="storefront-scene"][data-ready="true"]')).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId("no-3d")).toHaveCount(0);
});
