import { expect, type Page, test } from "@playwright/test";
import { blockMapTiles, enterShop, sendSampleMessage, snap, waitForReply } from "./helpers";

// 3D の店：外観から入店し、店内でスタッフがストアの状態どおりに動く。
// WebGL が使えないとき・動きを減らす設定のときは、2D の見取り図に落ちる。

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
  await blockMapTiles(page);
});

test("店の外観を見せてから入店し、店内のスタッフが持ち場へ向かって吹き出しを出す", async ({
  page,
}, info) => {
  // GPU のない環境では 3D の読み込みと描画が遅いので、余裕を持たせる
  test.setTimeout(180_000);
  await page.goto("/");
  await expect(page.locator('[data-testid="storefront-scene"][data-ready="true"]')).toBeVisible({
    timeout: 60_000,
  });
  await snap(page, info, "40-storefront-3d");

  await page.getByRole("button", { name: "入店する" }).click();
  const scene = page.locator('[data-testid="shop-scene"]');
  await expect(scene).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  // 入店のカメラが cam.main に着くまで待つ
  await page.waitForTimeout(5_000);
  await snap(page, info, "41-shop-3d");

  await sendSampleMessage(page, 0);
  // 3D の吹き出しと同じ文は、会話の窓と店内のようすでも文字で読める（作業の間だけ出るので、同時に待つ）
  await Promise.all([
    expect(page.locator('p[data-bubble="researcher"]')).toContainText("祭りを探しています"),
    expect(page.getByTestId("dialogue")).toContainText("祭りを探しています"),
    expect(page.getByTestId("staff-activity")).toContainText("祭りを探しています"),
  ]);
  await snap(page, info, "42-shop-3d-working");
  await waitForReply(page);
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

test("旅人を歩かせ、仕掛けを使い、柵で止まり、カウンターでコンシェルジュに話しかける", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await page.getByRole("button", { name: "入店する" }).click();
  const scene = page.getByTestId("shop-scene");
  await expect(scene).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  await page.waitForTimeout(6_000);
  // 操作の案内と、近くにあるもの（入口ののれん）が文字で読める
  await expect(page.getByTestId("play-guide")).toContainText("WASD");
  const prompt = page.getByTestId("play-prompt");
  await expect(prompt).toContainText("のれん");
  await expect(page.getByTestId("play-status")).toContainText("のれん");
  await page.keyboard.press("e");
  await expect(page.getByTestId("play-notice")).toContainText("のれん");

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
  await expect(page.getByRole("textbox", { name: "相談の発言" })).toBeFocused();
  // Esc で入力欄を離れると、また歩ける
  await page.keyboard.press("Escape");
  const before = await playerAt(page);
  const after = await holdUntil(page, "s", (at) => at.z > before.z + 0.2, 5_000);
  expect(after.z).toBeGreaterThan(before.z);
});

test("WebGL が使えないときは、店の外観も店内も 2D で出す", async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args) {
      const [kind] = args as [string];
      if (kind === "webgl" || kind === "webgl2") return null;
      return (original as (...a: unknown[]) => RenderingContext | null).apply(this, args);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
  await page.goto("/");
  await expect(page.getByTestId("storefront-scene")).toHaveCount(0);
  await enterShop(page, "");
  await expect(page.getByTestId("staff-floor")).toBeVisible();
  await expect(page.getByTestId("shop-scene")).toHaveCount(0);
  await sendSampleMessage(page, 0);
  await expect(page.getByTestId("staff-researcher")).toHaveAttribute(
    "data-phase",
    /walking|working/,
  );
});

test("動きを減らす設定では、3D を出さずに 2D の見取り図を主にする", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByTestId("storefront-scene")).toHaveCount(0);
  await enterShop(page, "");
  await expect(page.getByTestId("staff-floor")).toBeVisible();
  await expect(page.getByTestId("shop-scene")).toHaveCount(0);
});
