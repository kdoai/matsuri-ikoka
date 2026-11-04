import { expect, test } from "@playwright/test";
import {
  blockMapTiles,
  closeLog,
  enterShop,
  expectNoOverlap,
  openLog,
  openPanel,
  recordTexts,
  SAMPLE,
  seenTexts,
  sendSampleMessage,
  sessionReady,
  snap,
  tabTo,
  talkToConcierge,
  waitForReply,
} from "./helpers";

// 接客サーバー（mock）が再生する記録した架空の相談を、相談 → 候補 → 旅程と地図 → 修正 → 確認 → しおり まで通す

test.beforeEach(async ({ page }) => {
  await blockMapTiles(page);
});

test("相談からしおりまで、画面で通せる", async ({ page }, info) => {
  // 記録を記録の間隔のとおりに再生するので、相談の4回の返答だけで20秒ほどかかる
  test.setTimeout(150_000);
  await page.goto("/?scene=2d");
  await expect(page.getByRole("heading", { name: "MATSURI IKOKA" })).toBeVisible();
  await snap(page, info, "00-storefront");
  await page.getByRole("button", { name: "入店する" }).click();
  // 会話の窓は最初は出さず、「話しかける」のボタンだけを出す
  await expect(page.getByTestId("greeting-bar")).toContainText("コンシェルジュに話しかける");
  await expect(page.getByTestId("dialogue")).toBeHidden();
  await talkToConcierge(page);
  await expect(page.getByTestId("dialogue")).toContainText("いらっしゃいませ");

  // 1. 相談 → 候補
  await sendSampleMessage(page, 0);
  const cards = page.getByTestId("candidate-card");
  // 聞き取りに答えて送るので、返答の再生を待つ
  await expect(cards).toHaveCount(2, { timeout: 20_000 });
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
  // 開催が確認できていない祭りは選べず、理由を文字で出す
  await expect(cards.nth(1).getByRole("button", { name: "この祭りにする" })).toBeDisabled();
  await expect(cards.nth(1)).toContainText("今年の開催がまだ確認できていません");
  await waitForReply(page);
  await snap(page, info, "01-candidates");
  // リスト表示に切り替えると、1行ずつ見比べられる。選んだ表示は覚えておく
  await page.getByRole("button", { name: "リスト表示" }).click();
  await expect(page.getByTestId("candidate-row")).toHaveCount(2);
  await expect(cards).toHaveCount(0);
  await snap(page, info, "01-candidates-list");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "祭りの候補を見る" }).click();
  await expect(page.getByTestId("candidate-row")).toHaveCount(2);
  await page.getByRole("button", { name: "カード表示" }).click();
  await expect(cards).toHaveCount(2);
  // 候補を閉じても、店に戻って選び直せる
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("candidates")).toHaveCount(0);
  // 会話で伝えた出発の駅が、日付の札に出る
  await expect(page.getByTestId("date-badge")).toContainText("みなと中央駅から");
  await page.getByRole("button", { name: "祭りの候補を見る" }).click();
  await expect(page.getByTestId("candidates")).toBeVisible();

  // 2. 候補を選ぶ → 旅程と地図
  await cards.nth(0).getByRole("button", { name: "この祭りにする" }).click();
  await expect(page.getByTestId("candidates")).toHaveCount(0);
  await waitForReply(page);
  // 低い画面で「つづきを読む」を押しても、会話の窓は画面に収まり、選択肢は見えたまま（せりふだけが窓の中でスクロールする）。
  // 狭い画面では旅程のパネルが会話の窓に重なって開くので、PC の幅で確かめる
  if (info.project.name !== "mobile") {
    const viewport = page.viewportSize();
    const lowHeight = 560;
    if (viewport !== null) await page.setViewportSize({ width: viewport.width, height: lowHeight });
    const dialogue = page.getByTestId("dialogue");
    await dialogue.getByRole("button", { name: "つづきを読む" }).click();
    const box = await dialogue.boundingBox();
    if (box === null) throw new Error("会話の窓が見えません");
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(lowHeight);
    await expect(page.getByTestId("reply-choices")).toBeInViewport();
    await dialogue.getByRole("button", { name: "たたむ" }).click();
    if (viewport !== null) await page.setViewportSize(viewport);
  }
  await openPanel(page);
  const items = page.getByTestId("itinerary-item");
  await expect(items).toHaveCount(8);
  await expect(page.getByTestId("itinerary-panel")).toContainText("第1版");
  await expect(page.getByTestId("day-card")).toContainText("1日目");
  await expect(page.getByTestId("updated-sticker")).toHaveCount(0);
  await expect(page.locator('[data-change="added"], [data-change="changed"]')).toHaveCount(0);
  await expect(page.getByTestId("dialogue")).toContainText("旅程を組みました");
  // 旅程を確かめる間は、会話の窓に旅程についての選択肢を出す
  await expect(page.getByTestId("reply-choices")).toContainText("この旅程で決める");
  await expect(page.getByTestId("reply-choices")).toContainText("少し調整する");
  // 操作の案内は上の段にあり、旅のしおりの窓とも会話の窓とも重ならない
  await expectNoOverlap(page, "button-hints", ["itinerary-panel", "dialogue"]);
  await snap(page, info, "02-itinerary");
  // 予定の行を押すと、くわしい中身が開く
  const firstRow = items.first().getByRole("button");
  await firstRow.click();
  await expect(firstRow).toHaveAttribute("aria-expanded", "true");
  await firstRow.click();
  await expect(firstRow).toHaveAttribute("aria-expanded", "false");

  await page.getByRole("tab", { name: "旅の案内" }).click();
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

  await page.getByRole("tab", { name: "持ち物と確認" }).click();
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
  // 最初から、サーバーが作る冊子のしおり（PDF と同じ A4 の紙を見開きで並べたもの）を埋め込んで出す
  const booklet = page.frameLocator('[data-testid="shiori-booklet"]');
  await expect(booklet.getByRole("region", { name: "表紙", exact: true })).toBeVisible();
  await expect(booklet.locator("h1")).toHaveText("鈴鳴の灯籠と川べりさんぽ");
  await expect(booklet.getByRole("region", { name: "はじめての方へ" }).first()).toContainText(
    "For first-time visitors",
  );
  // 冊子にできるよう、ページの数は4の倍数
  expect((await booklet.locator(".sheet").count()) % 4).toBe(0);
  await snap(page, info, "06-shiori", true);

  // 矢印を1回押すと、次の見開き（2〜3ページ）へめくる
  if (info.project.name === "desktop") {
    await booklet.getByRole("link", { name: "次のページ" }).first().click();
    // なめらかにめくり終わるまで待つ
    await expect(booklet.getByRole("group", { name: "2〜3ページ" })).toBeInViewport({
      ratio: 0.99,
    });
    await snap(page, info, "07-shiori-spread", true);
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

test("待ち時間には豆知識係が祭りの話と出典を出し、送る・止めるができ、クイズに答えられる", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
  await enterShop(page);
  const staffLine = '[data-testid="staff-activity"]';
  const elapsedLine = '[data-testid="waiting-elapsed"]';
  const talkCard = '[data-testid="trivia-card"]';
  await recordTexts(page, [staffLine, elapsedLine, talkCard]);
  await sendSampleMessage(page, 0);

  // 最初の返答の間に、次の話へ送り、止める
  const guide = page.getByTestId("waiting-guide");
  const talk = page.getByTestId("waiting-talk");
  await expect(talk).toBeVisible();
  const first = await talk.textContent();
  await guide.getByRole("button", { name: "次の話" }).click();
  await guide.getByRole("button", { name: "止める" }).click();
  await expect(guide.getByRole("button", { name: "続ける" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await snap(page, info, "10-waiting-guide");
  await waitForReply(page);
  const talks = await seenTexts(page, talkCard);
  // 送ると、別の話に移る
  expect(talks.length).toBeGreaterThanOrEqual(2);
  expect(talks.some((text) => !text.includes(first ?? ""))).toBe(true);
  // 祭り調査係が探している間も、だれが何をしているかと経過時間を出す
  expect((await seenTexts(page, staffLine)).join()).toContain("祭り調査係");
  expect((await seenTexts(page, elapsedLine)).join()).toContain("経過");
  // 候補が出る前は、読み込んである祭りの全体から、出典つきで話す
  expect(talks.join()).toMatch(/(鈴鳴灯籠まつり|風見町 盆おどり)より/);
  expect(talks.join()).toContain("example.com");

  await page
    .getByTestId("candidate-card")
    .first()
    .getByRole("button", { name: "この祭りにする" })
    .click();
  // 豆知識を送っていくと、同じ窓にクイズが出る。その間も、店内のようすでだれが何をしているかを出し続ける
  const quiz = page.getByTestId("quiz-card");
  await expect(guide).toBeVisible();
  for (let i = 0; i < 4 && (await quiz.count()) === 0; i++) {
    await guide.getByRole("button", { name: "次の話" }).click();
  }
  await expect(quiz).toBeVisible();
  await expect(page.getByTestId("staff-activity")).toBeVisible();
  await quiz.getByRole("button").first().click();
  await expect(quiz.getByRole("status")).toHaveText(/正解|おしい/);
  await expect(quiz.getByTestId("quiz-explanation")).not.toBeEmpty();
  await snap(page, info, "11-quiz");
  // 次へ送ると、同じ窓が豆知識に戻る（返答が終わるまで待たない）
  await guide.getByRole("button", { name: "次の話" }).click();
  await expect(quiz).toHaveCount(0);
  await expect(guide.getByTestId("waiting-talk")).toBeVisible();
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

  // X で旅のしおりの窓を開き、矢印キーでタブを移る
  await page.keyboard.press("x");
  await expect(page.getByTestId("itinerary-panel")).toBeVisible();
  await page.getByRole("tab", { name: "旅程" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "旅の案内" })).toBeFocused();
  await expect(page.getByRole("tab", { name: "旅の案内" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "旅程" })).toHaveAttribute("aria-selected", "true");
});

test("キーボードだけで、入店から相談・候補選び・しおりまで進める", async ({ page }, info) => {
  test.setTimeout(150_000);
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
  await page.goto("/?scene=2d");
  await tabTo(page, page.getByRole("button", { name: "入店する" }));
  await page.keyboard.press("Enter");
  // 会話の窓は、E で話しかけると出る。焦点は選んで進める相談の最初の選択肢へ移る
  await page.keyboard.press("e");
  await expect(page.getByTestId("consult-choice").first()).toBeFocused();
  await sessionReady(page);

  // 聞き取りは、Tab と Enter、カレンダーは矢印キーで最後まで答えられる
  const consult = page.getByTestId("consult");
  const press = async (name: string) => {
    await tabTo(page, consult.getByRole("button", { name, exact: true }));
    await page.keyboard.press("Enter");
  };
  const decide = async () => {
    await tabTo(page, consult.getByTestId("consult-decide"));
    await page.keyboard.press("Enter");
  };
  await page.keyboard.press("Enter");
  await press("日付を指定");
  await expect(page.getByTestId("consult-calendar")).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("consult-nights")).toContainText("1泊2日");
  await decide();
  await expect(consult.getByRole("textbox", { name: "最寄りの駅" })).toBeFocused();
  await page.keyboard.insertText("みなと中央駅");
  await page.keyboard.press("Enter");
  for (let i = 0; i < 3; i++) {
    await press("おまかせ");
    await decide();
  }
  await press("おまかせ");
  await press("おまかせ");
  await expect(consult.getByRole("textbox", { name: "ひとこと" })).toBeFocused();
  await page.keyboard.insertText(SAMPLE.turns[0]?.request.message ?? "");
  await decide();
  await tabTo(page, page.getByTestId("consult-submit"));
  await page.keyboard.press("Enter");

  // 聞き取りのあとは、E で自分の言葉で書く欄へ移り、打って Enter で送る
  const input = page.getByRole("textbox", { name: "相談の発言" });
  const say = async (index: number) => {
    await page.keyboard.press("e");
    await expect(input).toBeFocused();
    await page.keyboard.insertText(SAMPLE.turns[index]?.request.message ?? "");
    await page.keyboard.press("Enter");
  };
  await expect(page.getByRole("heading", { name: "祭りの候補" })).toBeFocused();
  await waitForReply(page);
  await tabTo(page, page.getByRole("button", { name: "この祭りにする" }).first());
  await page.keyboard.press("Enter");
  await waitForReply(page);
  // Esc で入力欄を離れても、E でまた戻れる
  await page.keyboard.press("e");
  await page.keyboard.press("Escape");
  await expect(input).not.toBeFocused();
  await say(2);
  await waitForReply(page);
  await say(3);
  await expect(page.getByTestId("celebration")).toBeVisible({ timeout: 10_000 });
  await waitForReply(page);

  await page.keyboard.press("x");
  await tabTo(page, page.getByRole("button", { name: "旅のしおりを開く" }).first());
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("shiori").getByRole("heading", { level: 1 })).toBeVisible();
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
  await expect(page.getByTestId("greeting-bar")).toContainText("Talk to the concierge");
  await talkToConcierge(page, "Talk to the concierge");
  await expect(page.getByTestId("dialogue")).toContainText("Welcome!");
  await page.getByRole("button", { name: "Plan details" }).click();
  await expect(page.getByRole("tab", { name: "Plan" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await snap(page, info, "30-english");
});

test("文章を書かずに、選択肢を選ぶだけで相談を始められる", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
  await enterShop(page);
  const consult = page.getByTestId("consult");
  const progress = page.getByTestId("consult-progress");
  const decide = () => consult.getByTestId("consult-decide").click();
  // 聞き取りの窓が高くなっても、上の段（丸いボタンと操作の案内）とは重ならない
  const noOverlap = async () => {
    for (const top of ["icon-buttons", "button-hints"]) {
      await expectNoOverlap(page, top, ["dialogue"]);
    }
  };
  await expect(page.getByTestId("dialogue")).toContainText("だれと行きますか");
  await noOverlap();
  // 聞き取りの間は、自分の言葉で書く欄を出さない。答えるまで先へは進めない
  await expect(page.getByTestId("composer")).toHaveCount(0);
  await expect(progress).toHaveText("1 / 10");
  await expect(page.getByTestId("consult-forward")).toBeDisabled();

  // 家族を選ぶと、その場で人数を入れられる
  await consult.getByRole("button", { name: "家族で", exact: true }).click();
  await consult.getByRole("button", { name: "子ども（小学生）を1人増やす" }).click();
  await expect(page.getByTestId("consult-counts")).toContainText("合計 3人");
  await noOverlap();
  await decide();

  // 日付を指定を選ぶと、すぐ期間のカレンダーが開き、今日に焦点が移る。行きと帰りで泊数を出す
  await expect(progress).toHaveText("2 / 10");
  await consult.getByRole("button", { name: "日付を指定", exact: true }).click();
  await expect(page.getByTestId("consult-calendar")).toBeVisible();
  await noOverlap();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("consult-nights")).toContainText("2泊3日");
  await decide();

  // ＜ で戻り、＞ で答えたところまで進める
  await expect(progress).toHaveText("3 / 10");
  await page.getByTestId("consult-back").click();
  await expect(progress).toHaveText("2 / 10");
  await page.getByTestId("consult-forward").click();
  await expect(page.getByTestId("consult-forward")).toBeDisabled();

  // 駅の候補の出典を、公式のページへのリンクで出す
  await expect(page.getByTestId("consult-station-source").getByRole("link")).toHaveAttribute(
    "href",
    /^https:\/\/nlftp\.mlit\.go\.jp\/ksj\//,
  );
  const station = consult.getByRole("textbox", { name: "最寄りの駅" });
  await station.fill("みなと中央駅");
  await station.press("Enter");

  // 行き先は地方と都道府県、「その他」で自由に書ける。泊まりの旅なので、所要時間の上限は出さない
  await expect(consult.getByRole("button", { name: "関東", exact: true })).toBeVisible();
  await expect(page.getByTestId("consult-travel")).toHaveCount(0);
  await consult.getByRole("button", { name: "関東", exact: true }).click();
  await consult.getByRole("button", { name: "東京都", exact: true }).click();
  await consult.getByRole("button", { name: "その他", exact: true }).click();
  await consult.getByRole("textbox", { name: "行き先（自由に書く）" }).fill("川沿いの町");
  await noOverlap();
  await decide();
  await consult.getByRole("button", { name: "温泉", exact: true }).click();
  await decide();
  await consult.getByRole("button", { name: "その他", exact: true }).click();
  await consult.getByRole("textbox", { name: "食べたいもの（自由に書く）" }).fill("川魚");
  await decide();
  await consult.getByRole("button", { name: "ゆっくり", exact: true }).click();
  // 予算は金額でも伝えられ、1人あたりか全員でかを選べる
  await expect(consult.getByRole("textbox", { name: "金額で伝える（1人あたり）" })).toBeVisible();
  await page
    .getByTestId("consult-budget-basis")
    .getByRole("button", { name: "全員で", exact: true })
    .click();
  const amount = consult.getByRole("textbox", { name: "金額で伝える（全員で）" });
  await amount.fill("75000");
  await noOverlap();
  await amount.press("Enter");
  await consult.getByRole("textbox", { name: "ひとこと" }).fill("子どもが歩き疲れないように");
  await decide();

  const summary = page.getByTestId("consult-summary");
  await expect(progress).toHaveText("10 / 10");
  await expect(summary).toContainText("家族で（大人2人、子ども1人、計3人）");
  await expect(summary).toContainText("2泊3日");
  await expect(summary).toContainText("みなと中央駅");
  await expect(summary).toContainText("関東（東京都）、川沿いの町");
  await noOverlap();
  await expect(summary).toContainText("75,000円（全員で）");
  // 一覧から段階へ戻って直すと、確認へ戻る
  await consult.getByRole("button", { name: "旅のペース：直す" }).click();
  await consult.getByRole("button", { name: "たっぷり", exact: true }).click();
  await expect(progress).toHaveText("10 / 10");
  await expect(summary).toContainText("たっぷり");
  await snap(page, info, "06-consult-confirm");
  await page.getByTestId("consult-submit").click();

  // まとめた一文を送ると、聞き取りをしまい、候補が絵葉書のカードで出る
  await expect(page.getByTestId("candidates")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("candidate-card").first()).toContainText("詳細を見る");
  await waitForReply(page);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("consult")).toHaveCount(0);
  await expect(page.getByTestId("composer")).toBeVisible();
  await expect(page.getByTestId("reply-choices")).toContainText("条件を選び直す");
  await openLog(page);
  await expect(page.getByTestId("chat-user").first()).toContainText(
    "・だれと：家族で（大人2人、子ども1人、計3人）",
  );
  await expect(page.getByTestId("chat-user").first()).toContainText("・予算：75,000円（全員で）");
  await closeLog(page);
});

test("使い方は見出しで区切られ、窓の中でスクロールできる", async ({ page }, info) => {
  await enterShop(page);
  // 会話の記録は、ベルではなく吹き出しのボタンから開く。旅のこだわりのボタンはない
  await expect(
    page.getByTestId("icon-buttons").getByRole("button", { name: "会話の記録", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "旅のこだわり" })).toHaveCount(0);
  // 操作の案内（旅程詳細・地図・メニュー）は、丸いボタンの左に同じ段で並び、画面の幅からはみ出さない
  const hints = await page.getByTestId("button-hints").boundingBox();
  const icons = await page.getByTestId("icon-buttons").boundingBox();
  const width = page.viewportSize()?.width ?? 0;
  expect(hints).not.toBeNull();
  expect(icons).not.toBeNull();
  if (hints !== null && icons !== null) {
    expect(hints.x + hints.width).toBeLessThanOrEqual(icons.x);
    expect(Math.abs(hints.y + hints.height / 2 - (icons.y + icons.height / 2))).toBeLessThan(4);
    expect(hints.x).toBeGreaterThanOrEqual(0);
    expect(icons.x + icons.width).toBeLessThanOrEqual(width);
  }
  const help = page.getByTestId("icon-buttons").getByRole("button", { name: "使い方" });
  if (await help.isVisible()) {
    await help.click();
  } else {
    await page.getByTestId("button-hints").getByRole("button", { name: "メニュー" }).click();
    await page.getByTestId("game-menu").getByRole("button", { name: "使い方" }).click();
  }
  const dialog = page.getByRole("dialog", { name: "使い方" });
  await expect(dialog.getByRole("heading", { name: "相談の進め方" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "操作の案内" })).toBeVisible();
  const overflow = await page
    .getByTestId("help")
    .evaluate((element) => getComputedStyle(element.parentElement ?? element).overflowY);
  expect(overflow).toBe("auto");
  await expectNoOverlap(page, "button-hints", ["dialogue"]);
  await snap(page, info, "08-help");
});
