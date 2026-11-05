import type {
  AnchorPlan,
  AnchorPlanRequest,
  ChatRequest,
  FestivalSearchRequest,
  FestivalSearchResponse,
  FestivalSearchResult,
} from "@matsuri-ikoka/schema";
import { fictionalFestival, fictionalSource } from "@matsuri-ikoka/schema/testing";
import { expect, type Page, test } from "@playwright/test";
import {
  blockMapTiles,
  chooseTripEntry,
  expectNoOverlap,
  openLog,
  snap,
  tabTo,
  talkToConcierge,
  waitForReply,
} from "./helpers";

// 祭りから探す相談を、入口から祭りを決めるまで通す。検索の応答は架空の祭りの偽の応答で返す。

const SOURCE = fictionalSource("kasou");

function result(index: number, overrides: Partial<FestivalSearchResult> = {}) {
  return {
    candidate: {
      festivalId: `kasou-matsuri-${index}`,
      name: `架空の祭り${index}`,
      date: "2030-08-16",
      start: "18:00",
      end: "21:00",
      venueName: "架空の広場",
      place: "架空県架空町",
      daysFromWish: 0,
      confidence: "official",
      confirmed: index !== 1,
      highlight: "灯籠が川を流れる",
      source: SOURCE,
    },
    matchedKinds: ["traditional"],
    reasons: [`合う理由その${index}`],
    wishFit: null,
    ...overrides,
  } satisfies FestivalSearchResult;
}

function reply(overrides: Partial<FestivalSearchResponse> = {}): FestivalSearchResponse {
  return { results: [], remaining: 0, nearMatches: [], next: [], reading: null, ...overrides };
}

/** 検索の口を偽の応答に差し替え、送られた本文を残す。応答は順に返す */
async function fakeSearch(page: Page, replies: FestivalSearchResponse[]) {
  const bodies: FestivalSearchRequest[] = [];
  await page.route("**/api/festivals/search", (route) => {
    bodies.push(route.request().postDataJSON() as FestivalSearchRequest);
    const next = replies.shift();
    return next === undefined
      ? route.fulfill({
          status: 500,
          json: { code: "internal", message: "探せませんでした。", retryable: true },
        })
      : route.fulfill({ json: next });
  });
  return bodies;
}

async function open(page: Page) {
  await page.goto("/?scene=2d");
  await page.getByRole("button", { name: "入店する" }).click();
  await talkToConcierge(page);
}

/** 種類 → 季節 → 地域 → その他の希望 まで答え、探す */
async function answerAll(page: Page, wish = "") {
  const consult = page.getByTestId("consult");
  const choose = (name: string) => consult.getByRole("button", { name, exact: true }).click();
  await choose("祭りから探す");
  await choose("伝統的な祭り");
  await choose("マイナーなお祭り");
  await consult.getByTestId("consult-decide").click();
  await choose("夏");
  await choose("四国");
  await choose("香川県");
  await consult.getByTestId("consult-decide").click();
  if (wish !== "") await consult.getByRole("textbox", { name: "その他の希望" }).fill(wish);
  await consult.getByTestId("festival-search-submit").click();
}

test.beforeEach(async ({ page }) => {
  await blockMapTiles(page);
});

test("入口の2択から祭りを探し、続きを見て、選んでここで終えるとはじめに戻れる", async ({
  page,
}, info) => {
  const firstSix = [1, 2, 3, 4, 5, 6].map((index) => result(index));
  const bodies = await fakeSearch(page, [
    reply({
      results: firstSix,
      remaining: 1,
      reading: { text: "夜の灯りを楽しみたい", by: "words" },
    }),
    reply({
      results: [result(7, { wishFit: "none" })],
      next: [
        {
          kind: "any_season",
          label: "季節を問わない",
          conditions: { kinds: ["traditional", "hidden"], season: null, prefectures: ["香川県"] },
          found: 2,
        },
        { kind: "edit_conditions", label: "条件を選び直す", conditions: null, found: null },
      ],
    }),
    reply({ results: [result(8)], remaining: 0 }),
  ]);
  await open(page);

  // 入口の間は、選ばずに書いて送れるよう、自由に書く欄も出ている
  await expect(page.getByTestId("consult-entry")).toBeVisible();
  await expect(page.getByTestId("composer")).toBeVisible();
  await snap(page, info, "50-entry");

  // 答えるまで先へは進めない。＜ ＞ で行き来できる
  const consult = page.getByTestId("consult");
  await consult.getByRole("button", { name: "祭りから探す", exact: true }).click();
  await expect(page.getByTestId("composer")).toHaveCount(0);
  await expect(page.getByTestId("consult-progress")).toHaveText("1 / 4");
  await expect(page.getByTestId("consult-forward")).toBeDisabled();
  await expect(consult.getByTestId("consult-decide")).toBeDisabled();
  await consult.getByRole("button", { name: "おまかせ", exact: true }).click();
  await consult.getByRole("button", { name: "伝統的な祭り", exact: true }).click();
  await expect(consult.getByRole("button", { name: "おまかせ", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await consult.getByRole("button", { name: "マイナーなお祭り", exact: true }).click();
  await consult.getByTestId("consult-decide").click();
  await expect(page.getByTestId("dialogue")).toContainText("どの季節");
  await consult.getByRole("button", { name: "夏", exact: true }).click();
  await expect(page.getByTestId("consult-progress")).toHaveText("3 / 4");
  await page.getByTestId("consult-back").click();
  await expect(page.getByTestId("consult-progress")).toHaveText("2 / 4");
  await page.getByTestId("consult-forward").click();
  await consult.getByRole("button", { name: "四国", exact: true }).click();
  await consult.getByRole("button", { name: "香川県", exact: true }).click();
  await expectNoOverlap(page, "button-hints", ["dialogue"]);
  await consult.getByTestId("consult-decide").click();
  await consult.getByRole("textbox", { name: "その他の希望" }).fill("夜の灯りがきれいな祭り");
  await consult.getByTestId("festival-search-submit").click();

  // 結果は候補と同じカードで出し、合った理由・要事前確認・出典を出す
  const results = page.getByTestId("festival-results");
  const cards = results.getByTestId("candidate-card");
  await expect(cards).toHaveCount(6);
  await expect(results.getByRole("heading", { name: /探した祭り/ })).toBeFocused();
  expect(bodies[0]).toMatchObject({
    kinds: ["traditional", "hidden"],
    season: "summer",
    prefectures: ["香川県"],
    wish: "夜の灯りがきれいな祭り",
    excludeIds: [],
  });
  await expect(page.getByTestId("festival-reading")).toContainText("夜の灯りを楽しみたい");
  await expect(cards.first()).toContainText("架空の祭り1");
  await expect(cards.first()).toContainText("合う理由その1");
  await expect(cards.first()).toContainText("要事前確認");
  await expect(
    cards.first().getByRole("link", { name: "example.com/suzunari/kasou" }).first(),
  ).toHaveAttribute("href", SOURCE.url);
  // ご希望の日を聞いていないので、日付の札は出さない
  await expect(cards.first()).not.toContainText("ご希望の日");
  await snap(page, info, "51-results");

  // 別の祭りを提案してもらうと、見せた祭りを除いて続きを足す。見終えたら閉じて次の手を出す
  await page.getByTestId("festival-more").click();
  await expect(cards).toHaveCount(7);
  expect(bodies[1]?.excludeIds).toEqual(firstSix.map((item) => item.candidate.festivalId));
  await expect(cards.nth(6)).toContainText("ご希望に合うとは言えません");
  await expect(page.getByTestId("festival-all-shown")).toHaveText("これで全部です");
  await expect(page.getByTestId("festival-more")).toHaveCount(0);

  // 次の手は変えた条件で探し、続きを足す
  await page.getByTestId("festival-next").click();
  await expect(cards).toHaveCount(8);
  expect(bodies[2]).toMatchObject({ season: null, prefectures: ["香川県"] });
  expect(bodies[2]?.excludeIds).toHaveLength(7);

  // リスト表示でも選べる
  await page.getByRole("button", { name: "リスト表示" }).click();
  await expect(results.getByTestId("candidate-row")).toHaveCount(8);
  await page.getByRole("button", { name: "カード表示" }).click();

  // Esc で閉じても、会話の窓からまた開ける
  await page.keyboard.press("Escape");
  await expect(results).toHaveCount(0);
  await consult.getByRole("button", { name: "探した祭りを見る" }).click();
  await expect(cards).toHaveCount(8);

  // 祭りを選ぶと、次にどうするかを選ぶ
  await cards.nth(1).getByRole("button", { name: "この祭りにする" }).click();
  await expect(results).toHaveCount(0);
  await expect(page.getByTestId("dialogue")).toContainText("「架空の祭り2」ですね");
  await snap(page, info, "52-decide");
  await consult.getByRole("button", { name: "ほかの祭りを見る", exact: true }).click();
  await expect(cards).toHaveCount(8);
  await cards.nth(1).getByRole("button", { name: "この祭りにする" }).click();

  // ここで終わると、モデルを呼ばずに要点を出す
  await consult.getByRole("button", { name: "ここで終わる", exact: true }).click();
  const finished = page.getByTestId("festival-finished");
  await expect(finished).toContainText("架空県架空町・架空の広場");
  await expect(finished).toContainText("18:00〜21:00");
  await expect(finished).toContainText("主催者の案内で確かめて");
  await expect(
    finished.getByRole("link", { name: "example.com/suzunari/kasou" }).first(),
  ).toHaveAttribute("href", SOURCE.url);
  await expect(finished).toContainText("作法の要点");
  await snap(page, info, "53-finished");
  await finished.getByRole("button", { name: "はじめに戻る" }).click();
  await expect(page.getByTestId("consult-entry")).toBeVisible();
  await openLog(page);
  await expect(page.getByTestId("chat-user")).toHaveCount(0);
});

test("接客サーバーの検索の口につながり、結果の一覧を出す", async ({ page }) => {
  await open(page);
  await answerAll(page);
  // 祭りの有無はサンプルのデータと今日の日付で変わるので、一覧が開くことと、失敗の文が出ないことを確かめる
  await expect(page.getByTestId("festival-results")).toBeVisible();
  await expect(page.getByTestId("festival-results-footer")).toBeVisible();
  await expect(page.getByTestId("festival-search-error")).toHaveCount(0);
});

test("0件のときは、外れている点つきの祭りと次の手を出し、条件を選び直せる", async ({ page }) => {
  await fakeSearch(page, [
    reply({
      nearMatches: [{ result: result(1), miss: "夏の開催です（秋を選んでいます）" }],
      next: [
        {
          kind: "any_kind",
          label: "種類を問わない",
          conditions: { kinds: [], season: "summer", prefectures: [] },
          found: 4,
        },
        { kind: "edit_conditions", label: "条件を選び直す", conditions: null, found: null },
      ],
    }),
  ]);
  await open(page);
  await answerAll(page);

  const results = page.getByTestId("festival-results");
  await expect(page.getByTestId("festival-results-none")).toHaveText(
    "条件に合う祭りは見つかりませんでした",
  );
  // 条件を黙って緩めない。外れている祭りは候補と分けて出す
  await expect(results.getByTestId("candidate-card")).toHaveCount(0);
  await expect(page.getByTestId("festival-near-matches")).toContainText("夏の開催です");
  await expect(page.getByTestId("festival-next")).toContainText("種類を問わない");
  await expect(page.getByTestId("festival-next")).toContainText("4件");
  await expect(page.getByTestId("festival-all-shown")).toHaveCount(0);

  await page.getByTestId("festival-edit-conditions").click();
  await expect(results).toHaveCount(0);
  await expect(page.getByTestId("consult-progress")).toHaveText("1 / 4");
  // 選んだ内容は残っている
  await expect(
    page.getByTestId("consult").getByRole("button", { name: "伝統的な祭り", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("旅行計画を作成すると今の聞き取りへ進み、＜ で決めるところへ戻れる", async ({ page }) => {
  await fakeSearch(page, [reply({ results: [result(1), result(2)] })]);
  await open(page);
  await answerAll(page);
  await page
    .getByTestId("festival-results")
    .getByRole("button", { name: "この祭りにする" })
    .first()
    .click();
  const consult = page.getByTestId("consult");
  await consult.getByRole("button", { name: "旅行計画を作成する", exact: true }).click();
  await expect(page.getByTestId("dialogue")).toContainText("だれと行きますか");
  await expect(page.getByTestId("consult-progress")).toHaveText("1 / 10");

  await page.getByTestId("consult-back").click();
  await expect(page.getByTestId("festival-decide")).toBeVisible();
});

// ---------------------------------------------------------------------------
// 祭りを固定した聞き取り。祭りは架空の記録（data/samples）で、接客サーバーの mock に通す

/** 記録の祭りの開催日より前の今日。画面の「今日」をこの日にする */
const SAMPLE_TODAY = "2026-08-03T10:00:00+09:00";

const FIXED_FESTIVAL: FestivalSearchResult = {
  ...result(1),
  candidate: {
    ...result(1).candidate,
    festivalId: "suzunari-toro",
    name: "鈴鳴灯籠まつり",
    date: "2026-08-16",
    place: "架空県鈴鳴町",
    venueName: "鈴鳴川の河原",
    confirmed: true,
  },
};

/** 祭りから探して決め、「旅行計画を作成する」まで進める */
async function planFixedFestival(page: Page, sample: string | null = "suzunari-fixed-festival") {
  await page.clock.setFixedTime(new Date(SAMPLE_TODAY));
  await fakeSearch(page, [reply({ results: [FIXED_FESTIVAL, result(2)] })]);
  await page.goto(`/?scene=2d${sample === null ? "" : `&sample=${sample}`}`);
  await page.getByRole("button", { name: "入店する" }).click();
  await talkToConcierge(page);
  await answerAll(page);
  await page
    .getByTestId("festival-results")
    .getByRole("button", { name: "この祭りにする" })
    .first()
    .click();
  const consult = page.getByTestId("consult");
  await consult.getByRole("button", { name: "旅行計画を作成する", exact: true }).click();
  return consult;
}

/** だれと → 日程（泊数） → 出発地 まで答える */
async function answerUpToOrigin(page: Page, nights: string) {
  const consult = page.getByTestId("consult");
  await consult.getByRole("button", { name: "友人と", exact: true }).click();
  await consult.getByTestId("consult-decide").click();
  await expect(page.getByTestId("dialogue")).toContainText("鈴鳴灯籠まつり");
  await consult.getByRole("button", { name: nights, exact: true }).click();
  const station = consult.getByRole("textbox", { name: "最寄りの駅" });
  await station.fill("みなと中央駅");
  await station.press("Enter");
}

/** 楽しみ → 食べたいもの → ペース → 予算 → ひとこと（書かない）と進め、確認の画面まで */
async function answerRest(page: Page) {
  const consult = page.getByTestId("consult");
  const choose = (name: string) => consult.getByRole("button", { name, exact: true }).click();
  for (let i = 0; i < 2; i++) {
    await choose("おまかせ");
    await consult.getByTestId("consult-decide").click();
  }
  await choose("おまかせ");
  await choose("おまかせ");
  await consult.getByTestId("consult-decide").click();
}

const planOf = (overrides: Partial<AnchorPlan> = {}): AnchorPlan => ({
  anchor: { festivalId: "suzunari-toro", date: "2026-08-16" },
  festivalName: "鈴鳴灯籠まつり",
  mustPrefectures: ["香川県"],
  visits: [],
  order: ["みなと中央駅", "鈴鳴灯籠まつり", "みなと中央駅"],
  startDate: "2026-08-16",
  endDate: "2026-08-17",
  minNights: null,
  warnings: [],
  ...overrides,
});

test("祭りから探して固定の聞き取りを進め、組み立てを確かめて旅程まで届く", async ({
  page,
}, info) => {
  const previews: AnchorPlanRequest[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/festival-trips/preview")) {
      previews.push(request.postDataJSON() as AnchorPlanRequest);
    }
  });
  const chats: ChatRequest[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/chat")) chats.push(request.postDataJSON() as ChatRequest);
  });
  const consult = await planFixedFestival(page);
  await expect(page.getByTestId("consult-progress")).toHaveText("1 / 10");
  await consult.getByRole("button", { name: "友人と", exact: true }).click();
  await consult.getByTestId("consult-decide").click();

  // 日程：開催回が1つなら確かめるだけ。行く日を含まない期間は選べない
  await expect(page.getByTestId("anchor-day-fixed")).toContainText("18:30〜21:00");
  await consult.getByRole("button", { name: "日付を指定", exact: true }).click();
  const calendar = page.getByTestId("consult-calendar");
  await expect(calendar.locator('[data-date="2026-08-16"]')).toBeEnabled();
  await expect(calendar.locator('[data-date="2026-08-15"]')).toBeEnabled();
  await expect(calendar.locator('[data-date="2026-08-17"]')).toBeDisabled();
  await calendar.locator('[data-date="2026-08-15"]').click();
  // 行きを選んだあとは、祭りの日より前を帰りにできない
  await expect(calendar.locator('[data-date="2026-08-16"]')).toBeFocused();
  await expect(calendar.locator('[data-date="2026-08-17"]')).toBeEnabled();
  await snap(page, info, "54-anchor-schedule");
  await calendar.locator('[data-date="2026-08-17"]').click();
  await expect(page.getByTestId("consult-nights")).toContainText("2泊3日");
  await calendar.getByTestId("consult-decide").click();

  const station = consult.getByRole("textbox", { name: "最寄りの駅" });
  await station.fill("みなと中央駅");
  await station.press("Enter");

  // 行き先：祭りの開催地は外せない形で出る。寄りたい場所は選ばなくてもよい
  const must = page.getByTestId("anchor-must-go");
  await expect(must).toContainText("必ず行く");
  await expect(must).toContainText("鈴鳴灯籠まつり");
  await expect(must.getByRole("button")).toHaveCount(0);
  await expect(consult.getByTestId("consult-decide")).toBeEnabled();
  await consult.getByRole("button", { name: "四国", exact: true }).click();
  await consult.getByRole("button", { name: "その他", exact: true }).click();
  await consult.getByRole("textbox", { name: /寄りたい場所/ }).fill("架空の岬");
  await snap(page, info, "55-anchor-destination");
  await consult.getByTestId("consult-decide").click();
  await answerRest(page);

  // 確認で組み立てを出す
  const plan = page.getByTestId("anchor-plan");
  await expect(plan).toHaveAttribute("data-status", "ready");
  await expect(page.getByTestId("anchor-plan-dates")).toBeVisible();
  await expect(page.getByTestId("anchor-plan-order")).toContainText("鈴鳴町");
  await expect(plan.getByTestId("anchor-must-go")).toBeVisible();
  await expect(plan.getByText("架空の岬")).toBeVisible();
  await snap(page, info, "56-anchor-plan");
  expect(previews.at(-1)).toMatchObject({
    anchor: { festivalId: "suzunari-toro", date: "2026-08-16", startDate: "2026-08-15" },
    origin: "みなと中央駅",
    nights: 2,
    wishes: ["四国", "架空の岬"],
    pace: "auto",
  });

  // 送ると、祭りを固定して旅程まで届く
  await consult.getByTestId("consult-submit").click();
  await waitForReply(page);
  await expect(page.getByTestId("itinerary-panel")).toContainText("第1版");
  // カレンダーで選んだ初日も届く（組み立てが日程を変えないように）
  expect(chats[0]?.anchor).toEqual({
    festivalId: "suzunari-toro",
    date: "2026-08-16",
    startDate: "2026-08-15",
  });
  expect(chats[0]?.message).toContain("祭りは探し直さず");
  expect(chats[0]?.message).toContain("四国");
});

test("日帰りでは行き先を聞かず、泊数が足りなければ日程へ戻って直せる", async ({ page }) => {
  const dropped = {
    name: "B県",
    prefecture: null,
    status: "dropped",
    reason: "<b>遠い</b>ので今回は外します",
  } as const;
  const bodies: AnchorPlanRequest[] = [];
  await page.route("**/api/festival-trips/preview", (route) => {
    const body = route.request().postDataJSON() as AnchorPlanRequest;
    bodies.push(body);
    return route.fulfill({
      json:
        body.nights === 0
          ? planOf({
              endDate: "2026-08-16",
              minNights: 1,
              warnings: ["日帰りでは、この祭りに無理なく行けません"],
            })
          : planOf({
              visits: [
                { name: "A県", prefecture: null, status: "included", reason: null },
                { name: "C県", prefecture: null, status: "maybe", reason: "余裕があれば" },
                dropped,
              ],
            }),
    });
  });
  const consult = await planFixedFestival(page);
  await answerUpToOrigin(page, "日帰り");

  // 行き先を飛ばして、楽しみへ進む。段階の数も1つ減る
  await expect(page.getByTestId("dialogue")).toContainText("楽しみたいこと");
  await expect(page.getByTestId("consult-progress")).toHaveText("4 / 9");
  await page.getByTestId("consult-back").click();
  await expect(consult.getByRole("textbox", { name: "最寄りの駅" })).toBeVisible();
  await page.getByTestId("consult-forward").click();
  await answerRest(page);

  await expect(page.getByTestId("anchor-plan-warnings")).toContainText("無理なく行けません");
  await expect(page.getByTestId("anchor-plan").getByTestId("anchor-must-go")).toContainText(
    "必ず行く",
  );
  const fix = page.getByTestId("anchor-fix-nights");
  await expect(fix).toContainText("1泊あると安心");

  // 泊数を直すと、確認へ戻り、確かめ直す
  await fix.click();
  await consult.getByRole("button", { name: "1泊2日", exact: true }).click();
  await expect(page.getByTestId("anchor-plan-warnings")).toHaveCount(0);
  await expect(page.getByTestId("anchor-fix-nights")).toHaveCount(0);
  expect(bodies.map((body) => body.nights)).toEqual([0, 1]);

  // 入れる・余裕があれば入れる・今回は外すと理由が読める。サーバーの文は文字として出す
  await expect(page.getByTestId("anchor-visits-included")).toContainText("A県");
  await expect(page.getByTestId("anchor-visits-maybe")).toContainText("余裕があれば");
  const left = page.getByTestId("anchor-visits-dropped");
  await expect(left).toContainText("B県");
  await expect(left).toContainText("<b>遠い</b>ので今回は外します");
  await expect(left.locator("b")).toHaveCount(0);
});

test("組み立てを確かめられなくても理由を出し、確かめ直しも、そのまま送ることもできる", async ({
  page,
}) => {
  let attempts = 0;
  await page.route("**/api/festival-trips/preview", (route) => {
    attempts += 1;
    return attempts === 1
      ? route.fulfill({
          status: 400,
          json: { code: "bad_request", message: "確かめられませんでした。", retryable: false },
        })
      : route.fulfill({
          status: 500,
          json: { code: "internal", message: "失敗", retryable: true },
        });
  });
  const consult = await planFixedFestival(page);
  await answerUpToOrigin(page, "1泊2日");
  await consult.getByTestId("consult-decide").click();
  await answerRest(page);

  const error = page.getByTestId("anchor-plan-error");
  await expect(error).toContainText("確かめられませんでした。");
  await page.getByTestId("anchor-plan-retry").click();
  await expect(error).toContainText("失敗");
  await expect(page.getByTestId("anchor-must-go")).toBeVisible();

  await consult.getByTestId("consult-submit").click();
  await waitForReply(page);
  await expect(page.getByTestId("itinerary-panel")).toContainText("第1版");
});

test("中止と分かって旅程が組めなければ、祭りの結果へ戻れる", async ({ page }) => {
  await page.route("**/api/festival-trips/preview", (route) => route.fulfill({ json: planOf() }));
  const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  await page.route("**/api/chat", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: [
        sse("festival.verified", {
          festivalId: "suzunari-toro",
          date: "2026-08-16",
          scope: "candidate",
          result: "cancelled",
          checkedAt: "2026-08-03T10:00:00+09:00",
          sources: [],
        }),
        sse("message.delta", {
          messageId: "m-1",
          text: "今年は中止と分かりました。ほかの祭りを選んでください。",
        }),
        sse("done", {
          stage: "candidates",
          conditions: {},
          preferences: { party: "adults", spot: "hidden", food: "local", move: "train" },
        }),
      ].join(""),
    }),
  );
  const consult = await planFixedFestival(page);
  await answerUpToOrigin(page, "1泊2日");
  await consult.getByTestId("consult-decide").click();
  await answerRest(page);
  await expect(page.getByTestId("anchor-plan")).toHaveAttribute("data-status", "ready");
  await consult.getByTestId("consult-submit").click();

  const replies = page.getByTestId("reply-choices");
  await expect(replies.getByRole("button", { name: "条件を選び直す" })).toHaveCount(0);
  await replies.getByRole("button", { name: "ほかの祭りを見る" }).click();
  const cards = page.getByTestId("festival-results").getByTestId("candidate-card");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("架空の祭り2");
});

test("探すのに失敗したら理由を出し、もう一度探せる", async ({ page }) => {
  await page.route("**/api/festivals/search", (route, request) => {
    const first = !(request.postData() ?? "").includes("もう一度");
    return first
      ? route.fulfill({
          status: 500,
          json: { code: "internal", message: "<b>探せません</b>でした。", retryable: true },
        })
      : route.fulfill({ json: reply({ results: [result(1)] }) });
  });
  await open(page);
  await answerAll(page);
  const error = page.getByTestId("festival-search-error");
  // サーバーの文は文字として出す
  await expect(error).toHaveText("<b>探せません</b>でした。");
  await expect(error.locator("b")).toHaveCount(0);
  await page.getByRole("textbox", { name: "その他の希望" }).fill("もう一度");
  await page.getByRole("button", { name: "もう一度探す" }).click();
  await expect(page.getByTestId("festival-results").getByTestId("candidate-card")).toHaveCount(1);
});

test("祭りの文字列は、HTML として埋め込まない", async ({ page }) => {
  const name = "<img src=x onerror=alert(1)>";
  await fakeSearch(page, [
    reply({
      results: [
        {
          ...result(2),
          candidate: { ...result(2).candidate, name },
          reasons: ["<b>太字</b>の理由"],
        },
      ],
    }),
  ]);
  await open(page);
  await answerAll(page);
  const card = page.getByTestId("festival-results").getByTestId("candidate-card");
  await expect(card).toContainText(name);
  await expect(card).toContainText("<b>太字</b>の理由");
  await expect(card.locator("img, b")).toHaveCount(0);
});

test("キーボードだけで、入口から祭りを選ぶところまで進める", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
  await fakeSearch(page, [reply({ results: [result(1), result(2)] })]);
  await open(page);
  const consult = page.getByTestId("consult");
  const press = async (name: string) => {
    await tabTo(page, consult.getByRole("button", { name, exact: true }));
    await page.keyboard.press("Enter");
  };
  const decide = async () => {
    await tabTo(page, consult.getByTestId("consult-decide"));
    await page.keyboard.press("Enter");
  };
  // 最初の選択肢（祭りから探す）に焦点がある
  await page.keyboard.press("Enter");
  await expect(consult.getByRole("button", { name: "花火", exact: true })).toBeFocused();
  await press("おまかせ");
  await decide();
  await expect(consult.getByRole("button", { name: "春", exact: true })).toBeFocused();
  await press("秋");
  await press("おまかせ（全国）");
  await decide();
  await expect(consult.getByRole("textbox", { name: "その他の希望" })).toBeFocused();
  await tabTo(page, consult.getByTestId("festival-search-submit"));
  await page.keyboard.press("Enter");

  const results = page.getByTestId("festival-results");
  await expect(results.getByRole("heading", { name: /探した祭り/ })).toBeFocused();
  await tabTo(page, results.getByRole("button", { name: "この祭りにする" }).first());
  await page.keyboard.press("Enter");
  await expect(consult.getByRole("button", { name: "旅行計画を作成する" })).toBeFocused();
});

test("入口を選ばずに書いて送ると、今までの相談として受ける", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
  await open(page);
  const input = page.getByRole("textbox", { name: "相談の発言" });
  await input.fill("みなと中央駅から行ける祭りはありますか");
  await input.press("Enter");
  await expect(page.getByTestId("consult")).toHaveCount(0);
  await waitForReply(page);
  await openLog(page);
  await expect(page.getByTestId("chat-user").first()).toContainText(
    "みなと中央駅から行ける祭りはありますか",
  );
});

test("「はじめからやり直す」で、旅行計画の相談のあとも入口へ戻れる", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
  await open(page);
  await chooseTripEntry(page);
  // 最初の段階の ＜ でも入口へ戻る
  await page.getByTestId("consult-back").click();
  await expect(page.getByTestId("consult-entry")).toBeVisible();
  const input = page.getByRole("textbox", { name: "相談の発言" });
  await input.fill("みなと中央駅から行ける祭りはありますか");
  await input.press("Enter");
  await waitForReply(page);
  if (await page.getByTestId("candidates").isVisible()) await page.keyboard.press("Escape");
  await page
    .getByTestId("reply-choices")
    .getByRole("button", { name: "はじめからやり直す" })
    .click();
  await expect(page.getByTestId("consult-entry")).toBeVisible();
});

test("祭りのデータがあれば、ここで終えたときに作法の要点を出す", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
  const festival = { ...fictionalFestival(), id: "kasou-matsuri-2" };
  await page.route("**/api/festivals/kasou-matsuri-2", (route) =>
    route.fulfill({ json: festival }),
  );
  await fakeSearch(page, [reply({ results: [result(2)] })]);
  await open(page);
  await answerAll(page);
  await page
    .getByTestId("festival-results")
    .getByRole("button", { name: "この祭りにする" })
    .click();
  await page
    .getByTestId("consult")
    .getByRole("button", { name: "ここで終わる", exact: true })
    .click();
  const finished = page.getByTestId("festival-finished");
  await expect(finished).toContainText("服装");
  await expect(finished).toContainText("見学か、加われるか");
});
