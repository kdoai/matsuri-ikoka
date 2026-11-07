import { expect, type Page, test } from "@playwright/test";
import {
  blockMapTiles,
  enterShop,
  FAKE_HEARD,
  fakeSpeechRecognition,
  sendSampleMessage,
  snap,
  waitForReply,
} from "./helpers";

// しおりのあと、店の外の縁日の通りへ出て、ガイドの屋台で知らせを読み、ガイドに相談し、通知から屋台へ案内してもらう。
// 屋台は種類で分けず、旅のことはガイド1人に尋ねる。接客サーバー（mock）が再生する架空の相談とガイドの相談を使う。

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

test("2D だけで、ガイドの屋台の知らせ・相談がすべて使え、店内へ戻れる", async ({ page }, info) => {
  test.setTimeout(180_000);
  await enterShop(page);
  await untilShiori(page);
  await goOutside(page);
  await expect(page.getByTestId("street")).toHaveAttribute("data-mode", "2d");

  // ガイドの屋台が主役。屋台を種類で分けず、旅のことはガイド1人に尋ねる
  const front = page.getByTestId("guide-stall");
  await expect(front).toBeVisible();
  await expect(front).toContainText("旅の相談処");

  // 留守の間の変化があれば、提灯が灯り、ガイドが会話の窓で報告する
  const dialogue = page.getByTestId("guide-dialogue");
  await expect(dialogue).toContainText("コンシェルジュ（旅のガイド）");
  await expect(page.getByTestId("guide-line")).toHaveAttribute("data-line", "report");
  await expect(page.getByTestId("guide-line")).toContainText("鈴鳴灯籠まつりの開始");
  await expect(page.getByTestId("guide-line")).toContainText("調べました");
  await expect(page.getByTestId("street-unread")).toBeVisible();
  await expect(page.getByTestId("street-lit")).toContainText("新しい知らせ");
  await snap(page, info, "60-guide-report-2d");

  // 案内してもらうと、ガイドの屋台の窓が開き、読むと提灯が消える。旅程はまだ変わらない
  await page.getByTestId("guide-lead").click();
  const stall = page.getByTestId("stall-window");
  await expect(stall).toHaveAttribute("data-stall", "headquarters");
  await expect(stall.getByTestId("stall-notices")).toContainText("鈴鳴灯籠まつりの開始");
  await expect(stall.getByRole("link").first()).toHaveAttribute(
    "href",
    /^https:\/\/example\.com\//,
  );
  await snap(page, info, "61-stall-notice-2d");
  await page.keyboard.press("Escape");
  await expect(stall).toHaveCount(0);
  await expect(page.getByTestId("street-unread")).toHaveCount(0);

  // ログインなしの旅は相談の間だけ続くと分かる
  await expect(page.getByTestId("guest-note")).toContainText("6時間");
  await snap(page, info, "62-street-2d");

  // ガイドに話しかけて、選択肢から聞ける。もう読んだ知らせは灯り直さない
  await front.getByTestId("guide-stall-talk").click();
  await dialogue.getByRole("button", { name: "変わったことは？" }).click();
  await expect(page.getByTestId("guide-line")).toHaveAttribute("data-line", "guide", {
    timeout: 20_000,
  });
  await expect(dialogue.getByRole("button", { name: "変わったことは？" })).toBeEnabled({
    timeout: 20_000,
  });
  await expect(page.getByTestId("street-unread")).toHaveCount(0);

  // 自分の言葉でも聞ける。電話をかけるボタンは出さない
  await expect(dialogue.getByRole("textbox", { name: "ガイドへの発言" })).toBeVisible();
  await expect(page.getByTestId("guide-emergency")).toHaveCount(0);
  await expect(dialogue.locator('a[href^="tel:"]')).toHaveCount(0);
  const input = dialogue.getByRole("textbox", { name: "ガイドへの発言" });
  await input.fill("雨が降ったらどうすればいいですか");
  await input.press("Enter");
  await expect(page.getByTestId("guide-line")).toContainText("小雨なら開催します", {
    timeout: 20_000,
  });
  await snap(page, info, "64-guide-dialogue-2d");
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

test("旅の当日のスマホの幅では、次の予定・出発・帰りの最終の札が最初の画面に入る", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "mobile", "スマホの幅だけで確かめる");
  test.setTimeout(180_000);
  // 架空の旅の日（8月16日）の朝。サーバーの返事を待たず、手元の旅程と時計で旅の日と決まる
  await page.clock.setFixedTime(new Date("2026-08-16T09:00:00+09:00"));
  await page.setViewportSize({ width: 375, height: 812 });
  await enterShop(page);
  await untilShiori(page);
  await goOutside(page);

  const card = page.getByTestId("trip-day");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("trip-day-next")).toBeVisible();
  await expect(card.getByTestId("trip-day-departure")).toBeVisible();
  await expect(card.getByTestId("trip-day-last-return")).toContainText("22:45");
  // 屋台より先にあり、スクロールしなくても見える
  const box = await card.boundingBox();
  expect(box).not.toBeNull();
  expect((box?.y ?? 9999) + Math.min(box?.height ?? 0, 160)).toBeLessThanOrEqual(812);
  const stall = await page.getByTestId("guide-stall").boundingBox();
  expect(box?.y ?? 9999).toBeLessThan(stall?.y ?? 0);
  await snap(page, info, "61-trip-day-mobile");
});

test("知らせの組み直しの案を承認すると旅程が新しい版になり、直す前の旅程に戻せる", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  await enterShop(page);
  await untilShiori(page);
  await goOutside(page);

  await page.getByTestId("guide-lead").click();
  const stall = page.getByTestId("stall-window");
  await expect(stall).toHaveAttribute("data-stall", "headquarters");
  const proposal = stall.getByTestId("stall-notices").getByTestId("stall-proposal");
  await expect(proposal).toContainText("旅程はまだ変わっていません");

  await proposal.getByTestId("proposal-approve").click();
  const outcome = stall.getByTestId("guide-outcome");
  await expect(outcome).toHaveAttribute("data-outcome", "applied");
  await expect(stall.getByTestId("stall-proposal")).toHaveCount(0);
  await snap(page, info, "64-proposal-applied-2d");

  // 窓を閉じても、ガイドの屋台から直す前の旅程に戻せる
  await stall.getByRole("button", { name: "屋台を閉じる" }).click();
  const front = page.getByTestId("guide-stall");
  await front.getByTestId("guide-revert").click();
  await expect(front.getByTestId("guide-outcome")).toHaveAttribute("data-outcome", "reverted");
  await expect(front.getByTestId("guide-revert")).toHaveCount(0);
});

test("ガイドにつながらないときも、入力欄は残り、電話をかけるボタンは出さない", async ({
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
  await expect(page.getByTestId("guide-bar")).toContainText("ガイドに話しかける");
  await page.getByTestId("guide-bar").getByRole("button").click();
  const dialogue = page.getByTestId("guide-dialogue");
  await expect(page.getByTestId("guide-line")).toContainText("いまガイドにつながりません");
  await expect(dialogue.getByRole("button", { name: "もう一度読む" })).toBeVisible();
  await expect(page.getByTestId("guide-emergency")).toHaveCount(0);
  await expect(dialogue.locator('a[href^="tel:"]')).toHaveCount(0);
  // 入力欄は残る。ふつうの発言が断られたら、続け方を案内する
  const input = dialogue.getByRole("textbox", { name: "ガイドへの発言" });
  await input.fill("持ち物を教えてください");
  await input.press("Enter");
  await expect(page.getByTestId("guide-line")).toContainText("この相談は続けられなくなりました");
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

  // 会話の窓を開いていても、上の段の入口から開ける
  await page.keyboard.press("Escape");
  await page.getByTestId("guide-bar").getByRole("button").click();
  const entry = page.getByTestId("account-menu").getByRole("button").first();
  await entry.click();
  await expect(panel).toBeInViewport({ ratio: 1 });
  await panel.getByRole("button").first().click({ trial: true });
  await snap(page, info, "67-account-panel-over-dialogue");
});

test("通りのモデルを読めないときは、ガイドの屋台を主にし、案内はすぐに屋台を開く", async ({
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
  await expect(page.getByTestId("guide-stall")).toBeVisible();
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

test("動きを減らす設定では、3D を出さずにガイドの屋台を主にする", async ({ page }, info) => {
  test.setTimeout(150_000);
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await enterShop(page, "");
  await untilShiori(page);
  await goOutside(page);
  await expect(page.getByTestId("street")).toHaveAttribute("data-mode", "2d");
  await expect(page.getByTestId("street-scene")).toHaveCount(0);
  await expect(page.getByTestId("guide-stall")).toBeVisible();
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

  // 案内を頼むと、ガイドが旗で先導し、旅人も歩いて、着くとガイドの屋台の窓が開く。読むと提灯が消える
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

  // ガイドの屋台の知らせは、3D の上でも上の段から開ける
  await page.getByTestId("stall-list-button").click();
  await expect(page.getByTestId("stall-window")).toHaveAttribute("data-stall", "board");
  await snap(page, info, "76-guide-board-3d");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("stall-list-button")).toBeFocused();

  // 店内へ戻れる
  await page.getByTestId("back-to-shop").click();
  await expect(page.locator('[data-testid="shop-scene"]')).toHaveAttribute("data-ready", "true", {
    timeout: 120_000,
  });
  await expect(page.getByTestId("street")).toHaveCount(0);
});

test("ガイドの会話の窓でも、押している間だけ声で話し、送る前に確かめられる", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
  await fakeSpeechRecognition(page, { accepted: true });
  await enterShop(page);
  await untilShiori(page);
  await goOutside(page);
  // 通りには設定の窓がないので、読み上げの切り替えを上の段に出す
  await expect(page.getByTestId("read-aloud-toggle")).toBeVisible();

  const composer = page.getByTestId("guide-composer");
  const mic = composer.getByTestId("voice-input");
  const input = composer.getByRole("textbox");
  await mic.focus();
  await page.keyboard.down("Space");
  await expect(composer.getByTestId("voice-status")).toHaveText("聞いています。離すと止まります");
  await page.keyboard.up("Space");
  // 聞き取った文は送らずに入力欄へ入れ、焦点も入力欄へ移る
  await expect(input).toHaveValue(FAKE_HEARD);
  await expect(input).toBeFocused();
  await expect(page.getByTestId("guide-line")).toHaveAttribute("data-line", "report");
  // 確かめてから Enter で送る
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(page.getByTestId("guide-history")).toContainText(FAKE_HEARD);
});

test("声の機能がないブラウザでは、ガイドの窓にも声のボタンを出さず、文字で相談できる", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
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
  await enterShop(page);
  await untilShiori(page);
  await goOutside(page);
  const composer = page.getByTestId("guide-composer");
  await expect(composer).toBeVisible();
  await expect(composer.getByTestId("voice-input")).toHaveCount(0);
  await expect(page.getByTestId("read-aloud-toggle")).toHaveCount(0);
  const input = composer.getByRole("textbox");
  await input.fill("会場までの道を教えてください");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(page.getByTestId("guide-history")).toContainText("会場までの道を教えてください");
});

test("ガイドの窓でマイクの許可を断っても、わけを出して、文字で相談を続けられる", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
  await fakeSpeechRecognition(page, { accepted: true, error: "not-allowed" });
  await enterShop(page);
  await untilShiori(page);
  await goOutside(page);
  const composer = page.getByTestId("guide-composer");
  await composer.getByTestId("voice-input").click();
  await expect(composer.getByTestId("voice-status")).toHaveText(
    "マイクを使えませんでした。文字で相談を続けられます。",
  );
  const input = composer.getByRole("textbox");
  await input.fill("会場までの道を教えてください");
  await input.press("Enter");
  await expect(page.getByTestId("guide-history")).toContainText("会場までの道を教えてください");
});

test("スマートフォンの幅（375px）でも、通りの上の段が横にはみ出さない", async ({ page }, info) => {
  test.setTimeout(180_000);
  test.skip(info.project.name !== "mobile", "スマートフォンの幅だけで確かめる");
  await page.setViewportSize({ width: 375, height: 812 });
  await enterShop(page);
  await untilShiori(page);
  await goOutside(page);
  await expect(page.getByTestId("read-aloud-toggle")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  // 上の段のボタンは、どれも画面の中に収まる
  const box = await page.getByTestId("read-aloud-toggle").boundingBox();
  expect(box).not.toBeNull();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375);
});
