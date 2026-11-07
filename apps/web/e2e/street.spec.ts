import { expect, type Page, test } from "@playwright/test";
import { blockMapTiles, enterShop, sendSampleMessage, snap, waitForReply } from "./helpers";

// しおりのあと、店の外の縁日の通りへ出て、屋台を読み、ガイドに相談し、通知から屋台へ案内してもらう。
// 接客サーバー（mock）が再生する架空の相談とガイドの相談を使う。

test.beforeEach(async ({ page }) => {
  await blockMapTiles(page);
});

/** 記録した相談を、しおりができるところまで進める */
async function untilShiori(page: Page): Promise<void> {
  await sendSampleMessage(page, 0);
  await page.getByTestId("candidate-card").first().waitFor({ timeout: 20_000 });
  await waitForReply(page);
  await page
    .getByTestId("candidate-card")
    .first()
    .getByRole("button", { name: "この祭りにする" })
    .click();
  await waitForReply(page);
  // 狭い画面では、旅程のパネルが会話の窓に重なって開く
  const closePanel = page.getByRole("button", { name: "パネルを閉じる" });
  if (await closePanel.isVisible()) await closePanel.click();
  await sendSampleMessage(page, 2);
  await waitForReply(page);
  if (await closePanel.isVisible()) await closePanel.click();
  await sendSampleMessage(page, 3);
  await expect(page.getByTestId("celebration")).toBeVisible({ timeout: 10_000 });
  await waitForReply(page);
  await expect(page.getByTestId("celebration")).toHaveCount(0, { timeout: 5_000 });
  if (await closePanel.isVisible()) await closePanel.click();
}

async function goOutside(page: Page): Promise<void> {
  await page
    .getByTestId("reply-choices")
    .getByRole("button", { name: "ガイドと店の外へ出る" })
    .click();
  await expect(page.getByTestId("street")).toBeVisible({ timeout: 10_000 });
}

test("2D だけで、屋台の情報・通知・相談がすべて使え、店内へ戻れる", async ({ page }, info) => {
  test.setTimeout(180_000);
  await enterShop(page);
  await untilShiori(page);
  await goOutside(page);
  await expect(page.getByTestId("street")).toHaveAttribute("data-mode", "2d");

  // 屋台の一覧が主役。6つの屋台を文字で読める
  await expect(page.getByTestId("stall-list").getByRole("button")).toHaveCount(6);

  // 留守の間の変化があれば、本部のテントの提灯が灯り、ガイドが会話の窓で報告する
  const dialogue = page.getByTestId("guide-dialogue");
  await expect(dialogue).toContainText("コンシェルジュ（旅のガイド）");
  await expect(page.getByTestId("guide-line")).toHaveAttribute("data-line", "report");
  await expect(page.getByTestId("guide-line")).toContainText("鈴鳴灯籠まつりの開始");
  await expect(page.getByTestId("guide-line")).toContainText("調べました");
  await expect(page.getByTestId("stall-headquarters")).toHaveAttribute("data-lit", "true");
  await expect(page.getByTestId("street-lit")).toContainText("本部のテント");
  await snap(page, info, "60-guide-report-2d");

  // 案内してもらうと、その屋台が開き、読むと提灯が消える。旅程はまだ変わらない
  await page.getByTestId("guide-lead").click();
  const stall = page.getByTestId("stall-window");
  await expect(stall).toHaveAttribute("data-stall", "headquarters");
  await expect(page.getByTestId("stall-notices")).toContainText("鈴鳴灯籠まつりの開始");
  await expect(stall).toContainText("開催の日時");
  await snap(page, info, "61-stall-notice-2d");
  await stall.getByRole("button", { name: "屋台を閉じる" }).click();
  await expect(page.getByTestId("stall-headquarters")).toHaveAttribute("data-lit", "false");

  // ログインなしの旅は相談の間だけ続くと分かる
  await expect(page.getByTestId("guest-note")).toContainText("6時間");
  await snap(page, info, "62-street-2d");

  // 屋台を開くと、旅程と祭りのデータから読める。Esc で閉じる
  await page.getByTestId("stall-etiquette").click();
  await expect(stall).toContainText("作法の屋台");
  await expect(stall).toContainText("見学か、加われるか");
  await expect(stall.getByRole("link").first()).toHaveAttribute(
    "href",
    /^https:\/\/example\.com\//,
  );
  await snap(page, info, "63-stall-etiquette-2d");
  await page.keyboard.press("Escape");
  await expect(stall).toHaveCount(0);

  // ガイドに話しかけて、選択肢から聞ける。もう読んだ知らせは灯り直さない
  await page.getByRole("button", { name: "ガイドに話しかける" }).click();
  await dialogue.getByRole("button", { name: "変わったことは？" }).click();
  await expect(page.getByTestId("guide-line")).toHaveAttribute("data-line", "guide", {
    timeout: 20_000,
  });
  await expect(dialogue.getByRole("button", { name: "変わったことは？" })).toBeEnabled({
    timeout: 20_000,
  });
  await expect(page.getByTestId("stall-headquarters")).toHaveAttribute("data-lit", "false");

  // 自分の言葉で聞いて、緊急のときは連絡先が先に出る
  const input = dialogue.getByRole("textbox", { name: "ガイドへの発言" });
  await input.fill("連れが倒れて、呼びかけても返事がありません");
  await input.press("Enter");
  await expect(page.getByTestId("guide-emergency")).toContainText("119", { timeout: 20_000 });
  await expect(page.getByTestId("guide-emergency")).toContainText("110");
  await snap(page, info, "64-guide-emergency-2d");
  await page.getByTestId("guide-dialogue-close").click();

  // 通りから店内へ戻れて、今の相談はそのまま続く
  await page.getByTestId("back-to-shop").click();
  await expect(page.getByTestId("game-stage")).toBeVisible();
  await expect(page.getByTestId("street")).toHaveCount(0);
  // 旅程があるので、狭い画面では旅程のパネルが開いて重なる
  const closePanel = page.getByRole("button", { name: "パネルを閉じる" });
  if (await closePanel.isVisible()) await closePanel.click();
  await page.getByTestId("greeting-bar").getByRole("button").click();
  await expect(page.getByTestId("reply-choices")).toContainText("旅のしおりを開く");
});

test("ガイドを用意していない環境でも、屋台を読め、相談できないことが分かる", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
  await page.route("**/api/guide/**", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        code: "bad_request",
        message: "ガイドは用意していません。",
        retryable: false,
      }),
    }),
  );
  await enterShop(page);
  await untilShiori(page);
  await goOutside(page);
  await expect(page.getByTestId("guide-bar")).toContainText("ガイドはいま相談を受けられません");
  await page.getByTestId("stall-access").click();
  await expect(page.getByTestId("stall-window")).toContainText("旅の道のり");
  await page.keyboard.press("Escape");
  await page.getByTestId("guide-bar").getByRole("button").click();
  await expect(page.getByTestId("guide-line")).toContainText("いまはガイドに相談できません");
  // 話せないときも、公的な連絡先はいつも出す
  await expect(page.getByTestId("guide-emergency")).toContainText("119");
  await expect(page.getByTestId("guide-emergency")).toContainText("110");
  // 入力欄は残る。ふつうの発言が断られたら、続け方を案内する
  const input = page.getByRole("textbox", { name: "ガイドへの発言" });
  await input.fill("持ち物を教えてください");
  await input.press("Enter");
  await expect(page.getByTestId("guide-line")).toContainText("この相談は続けられなくなりました");
  await expect(page.getByTestId("guide-emergency")).toContainText("119");
  await snap(page, info, "65-guide-unavailable");
});

test("通りの案内からログインの窓を開け、窓は画面に収まり、ほかの窓に隠れない", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  await page.route("**/api/auth/config", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        apiKey: "demo-api-key",
        authDomain: "example.com",
        projectId: "demo-project",
      },
    }),
  );
  await enterShop(page);
  await untilShiori(page);
  await goOutside(page);
  await page.getByTestId("guide-lead").click();
  await page.getByTestId("stall-window").getByRole("button", { name: "屋台を閉じる" }).click();
  const note = page.getByTestId("guest-note");
  await expect(note).toContainText("旅を残すと");
  await note.getByRole("button", { name: "ログインと自分の旅" }).click();
  const panel = page.locator("#account-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toBeInViewport({ ratio: 1 });
  // 窓の中のボタンが、ほかの部品に隠れず押せる
  await panel.getByRole("button").first().click({ trial: true });
  await snap(page, info, "66-account-panel-street");

  // 屋台を開いていても、上の段の入口から開ける
  await page.keyboard.press("Escape");
  await page.getByTestId("stall-food").click();
  const entry = page.getByTestId("account-menu").getByRole("button").first();
  await entry.click();
  await expect(panel).toBeInViewport({ ratio: 1 });
  await panel.getByRole("button").first().click({ trial: true });
  await snap(page, info, "67-account-panel-over-stall");
});

test("ガイドの知らせを読めなくても、緊急の相談を送れて、連絡先が先に出る", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
  await page.route("**/api/guide/state", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        code: "upstream_unavailable",
        message: "いま旅を読めません。",
        retryable: true,
      }),
    }),
  );
  await enterShop(page);
  await untilShiori(page);
  await goOutside(page);
  await page.getByTestId("guide-bar").getByRole("button").click();
  await expect(
    page.getByTestId("guide-dialogue").getByRole("button", { name: "もう一度読む" }),
  ).toBeVisible();
  const input = page.getByRole("textbox", { name: "ガイドへの発言" });
  await input.fill("連れが倒れて、呼びかけても返事がありません");
  await input.press("Enter");
  await expect(page.getByTestId("guide-emergency")).toHaveAttribute("role", "alert", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("guide-emergency")).toContainText("119");
});

test("通りのモデルを読めないときは、屋台の一覧を主にし、案内はすぐに屋台を開く", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
  // モデルの取得だけを止める（開発サーバーの ?import の付いた読み込みは止めない）
  await page.route(/ennichi[^/?]*\.glb$/, (route) => route.abort());
  await enterShop(page);
  await untilShiori(page);
  await page.evaluate(() => window.history.replaceState(null, "", "/"));
  await goOutside(page);
  await expect(page.getByTestId("street")).toHaveAttribute("data-mode", "2d", { timeout: 60_000 });
  await expect(page.getByTestId("stall-list")).toBeVisible();
  await page.getByTestId("guide-lead").click();
  await expect(page.getByTestId("stall-window")).toHaveAttribute("data-stall", "headquarters");
});

test("3D の読み込み中に案内を頼んでも、すぐに屋台が開く", async ({ page }, info) => {
  test.setTimeout(150_000);
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
  // 通りのモデルを返さないまま待たせる
  await page.route(/ennichi[^/?]*\.glb$/, () => undefined);
  await enterShop(page);
  await untilShiori(page);
  await page.evaluate(() => window.history.replaceState(null, "", "/"));
  await goOutside(page);
  await expect(page.getByTestId("street")).toHaveAttribute("data-mode", "3d");
  await page.getByTestId("guide-lead").click();
  await expect(page.getByTestId("stall-window")).toHaveAttribute("data-stall", "headquarters");
});

test("動きを減らす設定では、3D を出さずに屋台の一覧を主にする", async ({ page }, info) => {
  test.setTimeout(150_000);
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await enterShop(page, "");
  await untilShiori(page);
  await goOutside(page);
  await expect(page.getByTestId("street")).toHaveAttribute("data-mode", "2d");
  await expect(page.getByTestId("street-scene")).toHaveCount(0);
  await expect(page.getByTestId("stall-list")).toBeVisible();
});

test("3D の通りで、提灯が灯り、ガイドに案内されて歩いて屋台を開け、店内へ戻れる", async ({
  page,
}, info) => {
  // GPU のない環境では 3D の読み込みと描画が遅いので、余裕を持たせる
  test.setTimeout(420_000);
  test.skip(
    info.project.name !== "desktop" && process.env.E2E_STREET_3D_ALL !== "1",
    "デスクトップだけで確かめる",
  );
  // 相談は 2D で進め（店内の 3D は scene3d.spec.ts で確かめる）、通りだけを 3D で描く
  await enterShop(page);
  await untilShiori(page);
  await page.evaluate(() => window.history.replaceState(null, "", "/"));
  await goOutside(page);
  const scene = page.getByTestId("street-scene");
  await expect(scene).toHaveAttribute("data-ready", "true", { timeout: 120_000 });
  await expect(page.getByTestId("street")).toHaveAttribute("data-mode", "3d");

  // 留守の間の変化があるので、提灯が灯り、ガイドが旅人へ駆け寄って報告する
  await expect(scene).toHaveAttribute("data-lit", "headquarters");
  await expect(scene).toHaveAttribute("data-guide-spot", "player");
  await expect(page.getByTestId("guide-line")).toHaveAttribute("data-line", "report");
  await page.waitForTimeout(5_000);
  await snap(page, info, "72-guide-report-3d");

  // 案内を頼むと、ガイドが旗で先導し、旅人も歩いて、着くと屋台が開く。読むと提灯が消える
  await page.getByTestId("guide-lead").click();
  await expect(scene).toHaveAttribute("data-guide-spot", "headquarters");
  await page.waitForTimeout(5_000);
  await snap(page, info, "73-guide-leading-3d");
  await expect(page.getByTestId("stall-window")).toHaveAttribute("data-stall", "headquarters", {
    timeout: 180_000,
  });
  await expect(scene).toHaveAttribute("data-lit", "");
  await page.waitForTimeout(4_000);
  await snap(page, info, "74-stall-headquarters-3d");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(4_000);
  await snap(page, info, "75-street-3d");

  // 屋台の一覧は 3D の上でも開ける
  await page.getByTestId("stall-list-button").click();
  await expect(page.getByTestId("stall-list")).toBeVisible();
  await snap(page, info, "76-stall-list-3d");
  await page.getByTestId("stall-food").click();
  await expect(page.getByTestId("stall-window")).toHaveAttribute("data-stall", "food");
  await page.waitForTimeout(4_000);
  await snap(page, info, "77-stall-food-3d");
  await page.keyboard.press("Escape");
  // 一覧のボタンは消えたので、焦点は一覧を開くボタンへ戻る
  await expect(page.getByTestId("stall-list-button")).toBeFocused();

  // 店内へ戻れる
  await page.getByTestId("back-to-shop").click();
  await expect(page.locator('[data-testid="shop-scene"]')).toHaveAttribute("data-ready", "true", {
    timeout: 120_000,
  });
  await expect(page.getByTestId("street")).toHaveCount(0);
});
