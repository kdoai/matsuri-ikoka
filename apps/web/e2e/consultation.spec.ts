import { expect, test } from "@playwright/test";
import {
  blockMapTiles,
  closeLog,
  enterShop,
  openLog,
  openPanel,
  openPreferences,
  sendSampleMessage,
  snap,
  waitForReply,
} from "./helpers";

// 接客サーバー（mock）が再生する記録した架空の相談を、相談 → 候補 → 旅程と地図 → 修正 → 確認 → しおり まで通す

test.beforeEach(async ({ page }) => {
  await blockMapTiles(page);
});

test("相談からしおりまで、画面で通せる", async ({ page }, info) => {
  await page.goto("/?scene=2d");
  await expect(page.getByRole("heading", { name: "MATSURI IKOKA" })).toBeVisible();
  await snap(page, info, "00-storefront");
  await page.getByRole("button", { name: "入店する" }).click();
  await expect(page.getByTestId("dialogue")).toContainText("いらっしゃいませ");

  // 1. 相談 → 候補
  await sendSampleMessage(page, 0);
  const cards = page.getByTestId("candidate-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText("鈴鳴灯籠まつり");
  await expect(cards.nth(0)).toContainText("公式で確認");
  await expect(cards.nth(0)).toContainText("ご希望の日");
  await expect(cards.nth(1)).toContainText("未確認");
  await expect(cards.nth(1)).toContainText("ご希望の1日前");
  await expect(cards.nth(1)).toContainText("要確認");
  await expect(cards.nth(0).getByRole("link", { name: "情報の訂正を送る" })).toHaveAttribute(
    "href",
    /issues\/new\?template=festival-correction\.yml/,
  );
  await waitForReply(page);
  await snap(page, info, "01-candidates");
  // 候補を閉じても、店に戻って選び直せる
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("candidates")).toHaveCount(0);
  // 会話で伝えたこだわり（穴場・地元の店）が、旅のこだわりの切り替えに反映される
  await openPreferences(page);
  await expect(page.getByRole("radio", { name: "穴場", includeHidden: true })).toBeChecked();
  await expect(
    page.getByRole("radio", { name: "地元の店も楽しむ", includeHidden: true }),
  ).toBeChecked();
  await expect(page.getByTestId("condition-chips")).toContainText("みなと中央駅から");
  await snap(page, info, "01b-preferences");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "祭りの候補を見る" }).click();
  await expect(page.getByTestId("candidates")).toBeVisible();

  // 2. 候補を選ぶ → 旅程と地図
  await cards.nth(0).getByRole("button", { name: "この祭りにする" }).click();
  await expect(page.getByTestId("candidates")).toHaveCount(0);
  await waitForReply(page);
  await openPanel(page);
  const items = page.getByTestId("itinerary-item");
  await expect(items).toHaveCount(8);
  await expect(page.getByTestId("itinerary-panel")).toContainText("第1版");
  await expect(page.getByTestId("day-card")).toContainText("1日目");
  await expect(page.getByTestId("updated-sticker")).toHaveCount(0);
  await expect(page.locator('[data-change="added"], [data-change="changed"]')).toHaveCount(0);
  await expect(page.getByTestId("dialogue")).toContainText("旅程を組みました");
  await snap(page, info, "02-itinerary");

  await page.getByRole("tab", { name: "地図" }).click();
  // 第1版は地図に打てる予定が6つ。旅程に入っていない寄り道の候補も文字で出す
  await expect(page.getByTestId("map-places").getByRole("listitem")).toHaveCount(6, {
    timeout: 15_000,
  });
  await expect(page.getByTestId("map-places")).toContainText("鈴鳴灯籠まつり（会場）");
  await expect(page.getByTestId("map-view")).toContainText("寄り道の候補：鈴鳴和紙の館");
  await expect(page.locator(".leaflet-control-attribution")).toContainText("OpenStreetMap");
  await snap(page, info, "03-map");

  // 3. 修正 → 変わった予定に色が付く
  await page.getByRole("tab", { name: "旅程" }).click();
  if (info.project.name === "mobile") {
    await page.getByRole("button", { name: "パネルを閉じる" }).click();
  }
  await sendSampleMessage(page, 2);
  await waitForReply(page);
  await openPanel(page);
  await expect(page.getByTestId("itinerary-panel")).toContainText("第2版");
  await expect(page.getByTestId("updated-sticker")).toHaveText("更新！");
  await expect(items).toHaveCount(9);
  await expect(page.locator('[data-item-id="craft-hall"]')).toHaveAttribute("data-change", "added");
  await expect(page.locator('[data-item-id="riverside"]')).toHaveAttribute(
    "data-change",
    "changed",
  );
  await expect(page.locator('[data-item-id="go"]')).toHaveAttribute("data-change", "none");
  await snap(page, info, "04-revised");

  await page.getByRole("tab", { name: "出典" }).click();
  await expect(page.getByTestId("source-list").getByRole("listitem").first()).toBeVisible();
  await expect(page.getByTestId("source-list")).toContainText("公式で確認");

  // 4. 確定 → 再確認 → しおり完成
  if (info.project.name === "mobile") {
    await page.getByRole("button", { name: "パネルを閉じる" }).click();
  }
  await sendSampleMessage(page, 3);
  await expect(page.getByTestId("celebration")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("celebration")).toContainText("旅のしおり完成");
  await snap(page, info, "05-celebration");
  await waitForReply(page);
  await expect(page.getByTestId("celebration")).toHaveCount(0, { timeout: 5_000 });
  await openPanel(page);
  await expect(page.getByTestId("verification")).toContainText("予定どおり開催されます");

  await page
    .getByTestId("itinerary-panel")
    .getByRole("button", { name: "旅のしおりを開く" })
    .click();
  const shiori = page.getByTestId("shiori");
  await expect(shiori.getByRole("heading", { level: 1 })).toHaveText("鈴鳴の灯籠と川べりさんぽ");
  for (const section of ["main", "flow", "map", "food", "first-time", "rain", "sources"]) {
    await expect(page.getByTestId(`shiori-${section}`)).toBeVisible();
  }
  await expect(page.getByTestId("shiori-first-time")).toContainText("First time here?");
  await expect(page.getByTestId("etiquette-table").getByRole("row")).toHaveCount(8);
  await expect(page.getByTestId("shiori-first-time")).toContainText("You can join if you apply");
  await expect(page.getByTestId("shiori-sources")).toContainText("当日は、公式サイトで最終確認");
  await snap(page, info, "06-shiori", true);

  // 印刷すると A4 縦で2枚以内に収まる
  if (info.project.name === "desktop") {
    await page.emulateMedia({ media: "print" });
    await snap(page, info, "07-shiori-print", true);
    const pdf = await page.pdf({ format: "A4", preferCSSPageSize: true, printBackground: true });
    const pages = pdf.toString("latin1").match(/\/Type\s*\/Page(?!s)/g)?.length ?? 0;
    expect(pages).toBeGreaterThan(0);
    expect(pages).toBeLessThanOrEqual(2);
  }

  await page.emulateMedia({ media: "screen" });
  await page.getByRole("button", { name: "店内に戻る" }).click();
  await expect(page.getByTestId("itinerary-panel")).toBeAttached();

  // 会話の記録に、これまでのやりとりとスタッフ全員のようすが残っている
  if (info.project.name === "mobile") {
    await page.getByRole("button", { name: "パネルを閉じる" }).click();
  }
  await openLog(page);
  await expect(page.getByTestId("chat-user")).toHaveCount(4);
  await expect(page.getByTestId("chat-user").nth(1)).toHaveText(/「鈴鳴灯籠まつり」にします。/);
  await expect(page.getByTestId("backlog").getByTestId("staff-list")).toContainText("待機中");
  await closeLog(page);
});

test("待ち時間には豆知識係が祭りの話と出典を出し、クイズに答えられる", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
  await enterShop(page);
  await sendSampleMessage(page, 0);
  // 祭り調査係が探している間も、だれが何をしているかと経過時間を出す
  const guide = page.getByTestId("waiting-guide");
  await expect(guide).toBeVisible();
  await expect(page.getByTestId("waiting-staff")).toContainText("祭り調査係");
  await expect(page.getByTestId("waiting-elapsed")).toContainText("経過");
  await waitForReply(page);

  await page
    .getByTestId("candidate-card")
    .first()
    .getByRole("button", { name: "この祭りにする" })
    .click();
  // 候補が出たあとは、候補の祭りのデータの話を、出典つきで話す
  const talk = page.getByTestId("trivia-card");
  await expect(talk).toBeVisible();
  await expect(talk).toContainText("鈴鳴灯籠まつりより");
  await expect(talk.getByRole("link")).toHaveAttribute("href", /example\.com/);
  const first = await page.getByTestId("waiting-talk").textContent();
  await guide.getByRole("button", { name: "次の話" }).click();
  await expect(page.getByTestId("waiting-talk")).not.toHaveText(first ?? "");
  await guide.getByRole("button", { name: "止める" }).click();
  await expect(guide.getByRole("button", { name: "続ける" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await snap(page, info, "10-waiting-guide");

  const quiz = page.getByTestId("quiz-card");
  await expect(quiz).toBeVisible({ timeout: 10_000 });
  await quiz.getByRole("button").first().click();
  await expect(quiz.getByRole("status")).toHaveText(/正解|おしい/);
  await snap(page, info, "11-quiz");
  await waitForReply(page);
  await expect(quiz).toHaveCount(0);
  await expect(guide).toHaveCount(0);
});

test("キーボードだけで、候補を閉じ、タブを移れる", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
  await enterShop(page);
  await sendSampleMessage(page, 0);
  await expect(page.getByTestId("candidates")).toBeVisible();
  await expect(page.getByRole("heading", { name: "祭りの候補" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("candidates")).toHaveCount(0);
  await page.getByRole("button", { name: "祭りの候補を見る" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("candidates")).toBeVisible();
  await page.keyboard.press("Escape");

  // X で旅程・地図・出典のパネルを開き、矢印キーでタブを移る
  await page.keyboard.press("x");
  await expect(page.getByTestId("itinerary-panel")).toBeVisible();
  await page.getByRole("tab", { name: "旅程" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "地図" })).toBeFocused();
  await expect(page.getByRole("tab", { name: "地図" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "旅程" })).toHaveAttribute("aria-selected", "true");
});

test("動きを減らす設定では、2D の店内とスタッフの文字の一覧を出す", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await enterShop(page);
  await expect(page.getByTestId("staff-floor")).toBeVisible();
  await sendSampleMessage(page, 0);
  await expect(page.getByTestId("staff-activity")).toContainText("祭り調査係");
  await expect(page.getByTestId("staff-researcher")).toHaveAttribute(
    "data-phase",
    /walking|working/,
  );
  await waitForReply(page);
  await snap(page, info, "20-reduced-motion");
});

test("英語に切り替えられる", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
  await page.goto("/?scene=2d");
  await page.getByRole("button", { name: /English/ }).click();
  await expect(page.getByRole("button", { name: "Come in" })).toBeVisible();
  await page.getByRole("button", { name: "Come in" }).click();
  await expect(page.getByTestId("dialogue")).toContainText("Welcome!");
  await page.getByRole("button", { name: "Plan details" }).click();
  await expect(page.getByRole("tab", { name: "Plan" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await snap(page, info, "30-english");
});
