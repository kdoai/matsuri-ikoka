import { expect, test } from "@playwright/test";
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
  await page.goto("/?speed=1");
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

  await sendSampleMessage(page);
  const bubble = page.locator('[data-bubble="researcher"]');
  await expect(bubble).toBeVisible({ timeout: 10_000 });
  await expect(bubble).toContainText("祭りを探しています");
  // 3D の吹き出しと同じ文は、スタッフの一覧でも文字で読める
  await expect(page.getByTestId("staff-list")).toContainText("祭りを探しています");
  await snap(page, info, "42-shop-3d-working");
  await waitForReply(page);
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
  await page.goto("/?speed=4");
  await expect(page.getByTestId("storefront-scene")).toHaveCount(0);
  await enterShop(page, "?speed=4");
  await expect(page.getByTestId("staff-floor")).toBeVisible();
  await expect(page.getByTestId("shop-scene")).toHaveCount(0);
  await sendSampleMessage(page);
  await expect(page.getByTestId("staff-researcher")).toHaveAttribute(
    "data-phase",
    /walking|working/,
  );
});

test("動きを減らす設定では、3D を出さずに 2D の見取り図を主にする", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?speed=4");
  await expect(page.getByTestId("storefront-scene")).toHaveCount(0);
  await enterShop(page, "?speed=4");
  await expect(page.getByTestId("staff-floor")).toBeVisible();
  await expect(page.getByTestId("shop-scene")).toHaveCount(0);
});
