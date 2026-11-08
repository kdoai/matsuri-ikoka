import {
  type AnchorVisit,
  type ConversationStage,
  type DateWish,
  DEFAULT_LOCALE,
  type Locale,
  type LodgingBudget,
  type PartialTripConditions,
  type Party,
  type Preferences,
  type TripBudget,
  tripBudgetAmounts,
} from "@matsuri-ikoka/schema";
import { arrivalBufferMinutes } from "../domain/arrivalBuffer";
import {
  formatMonthDay,
  formatMonthDayWithWeekday,
  fromMinutes,
  toMinutes,
} from "../domain/calendar";
import { DIETARY_LABELS, FOOD_WISH_LABELS } from "../domain/food";
import { preferenceEffects } from "../domain/preferences";
import { TRANSPORT_LABELS } from "../domain/transport";
import type { ToolContext } from "../tools/context";
import { hearingReport } from "../tools/matsuriTools";
import type { Staff } from "./bubbles";

// エージェントに渡す「店の記録」。会話の状態・条件・こだわり・候補・旅程は、サーバーが持つものを正とする。
// 利用者の発言とは、決まったタグで分けて渡す。

const STAGE_LABELS: Record<ConversationStage, string> = {
  hearing: "聞き取り",
  candidates: "祭りの候補",
  itinerary: "旅程の案",
  revising: "修正",
  verifying: "確定前の確認",
  shiori: "旅のしおり",
};

const PREFERENCE_LABELS = {
  party: { adults: "大人だけ", kids: "子連れ", seniors: "シニアと一緒" },
  spot: { classic: "定番どころ", auto: "おまかせ", hidden: "穴場" },
  food: { stalls: "屋台で十分", local: "地元の店も楽しむ" },
  move: { train: "電車", car: "車" },
} as const;

/** 人数と内訳（例：大人3（うちシニア1）・子ども1（うち幼児1）） */
export function partyLabel(party: Party): string {
  const of = (label: string, n: number | undefined) => (n ? `（うち${label}${n}）` : "");
  return `大人${party.adults}${of("シニア", party.seniors)}・子ども${party.children}${of("幼児", party.infants)}`;
}

/** 宿の予算（例：宿の予算 1人1泊 12,000円まで） */
export function lodgingBudgetLabel(budget: LodgingBudget): string {
  const yen = budget.perPersonYen.toLocaleString("ja-JP");
  return `宿の予算 ${budget.per === "night" ? "1人1泊" : "1人あたり泊まり全体で"} ${yen}円まで`;
}

/** 旅の予算（例：旅の予算 全員で 90,000円まで（3人で1人あたり 30,000円）） */
export function tripBudgetLabel(budget: TripBudget, party: Party | undefined): string {
  const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;
  const amounts = tripBudgetAmounts(budget, party);
  if (budget.basis === "perPerson") {
    const total =
      amounts.totalYen === null ? "" : `（${amounts.payers}人で合計 ${yen(amounts.totalYen)}）`;
    return `旅の予算 1人あたり ${yen(budget.yen)}まで${total}`;
  }
  const each =
    amounts.perPersonYen === null
      ? "（人数が分からないので1人あたりは未計算）"
      : `（${amounts.payers}人で1人あたり ${yen(amounts.perPersonYen)}）`;
  return `旅の予算 全員で ${yen(budget.yen)}まで${each}`;
}

export function preferencesLabel(p: Preferences): string {
  const labels = [
    PREFERENCE_LABELS.party[p.party],
    PREFERENCE_LABELS.spot[p.spot],
    PREFERENCE_LABELS.food[p.food],
    PREFERENCE_LABELS.move[p.move],
  ].join("・");
  return `${labels}（ツールに渡す値：${JSON.stringify(p)}）`;
}

const ROUTE_LABELS = {
  stay: "ずっと一か所を拠点にする",
  loop: "いくつかの地域を巡る",
  via: "目的地へ向かう途中で祭りに寄る",
  auto: "おまかせ",
} as const;
const STAY_NEAR_LABELS = { festival: "祭りの近く", town: "街", auto: "おまかせ" } as const;
const FESTIVAL_DAYS_LABELS = { one: "1日だけ", several: "何日か", auto: "おまかせ" } as const;
const PACE_LABELS = {
  relaxed: "ゆっくり",
  normal: "ふつう",
  packed: "たっぷり",
  auto: "おまかせ",
} as const;
const INTEREST_LABELS = {
  onsen: "温泉",
  food: "食",
  nature: "自然",
  town_walk: "街歩き",
  history: "歴史",
  shopping: "買い物",
} as const;

/** 泊まりの旅で聞き取った好み（旅のかたち・終わりの場所など） */
function tripStyleLabels(conditions: PartialTripConditions): string[] {
  const { route } = conditions;
  return [
    route
      ? `旅のかたち ${ROUTE_LABELS[route.shape]}${route.areas.length > 0 ? `（${route.areas.join("→")}）` : ""}`
      : null,
    conditions.returnTo ? `終わりの場所 ${conditions.returnTo}` : null,
    conditions.stayNear ? `泊まる場所 ${STAY_NEAR_LABELS[conditions.stayNear]}` : null,
    conditions.festivalDays ? `祭りの日数 ${FESTIVAL_DAYS_LABELS[conditions.festivalDays]}` : null,
    conditions.pace ? `ペース ${PACE_LABELS[conditions.pace]}` : null,
    conditions.interests
      ? `楽しみ ${conditions.interests.length === 0 ? "特になし" : conditions.interests.map((i) => INTEREST_LABELS[i]).join("・")}`
      : null,
    conditions.foodWishes
      ? `食べたいもの ${conditions.foodWishes.length === 0 ? "こだわらない" : conditions.foodWishes.map((w) => FOOD_WISH_LABELS[w]).join("・")}`
      : null,
    conditions.dietary && conditions.dietary.length > 0
      ? `食事で気をつけたいこと ${conditions.dietary.map((d) => DIETARY_LABELS[d]).join("・")}`
      : null,
    conditions.transport && conditions.transport.length > 0
      ? `交通手段 ${conditions.transport.map((m) => TRANSPORT_LABELS[m]).join("・")}`
      : null,
    conditions.leaveToStaff ? "あとはおまかせ" : null,
  ].filter((v): v is string => v !== null);
}

function wishLabel(wish: DateWish): string {
  return wish.kind === "date"
    ? formatMonthDayWithWeekday(wish.date)
    : `${formatMonthDayWithWeekday(wish.from)}〜${formatMonthDayWithWeekday(wish.to)}`;
}

const visitLabel = (v: AnchorVisit) =>
  `${v.name}${v.prefecture !== null && v.prefecture !== v.name ? `（${v.prefecture}）` : ""}${v.reason ? `：${v.reason}` : ""}`;

/** 祭りを固定した旅程の記録。すべてコードで計算したものをそのまま渡す */
function anchorLines(ctx: ToolContext): string[] {
  const { anchor, anchorPlan: plan, anchorCheck, cancelledAnchor } = ctx.session;
  const lines: string[] = [];
  if (cancelledAnchor !== null) {
    lines.push(
      `中止と分かった祭り：${cancelledAnchor.name}（${cancelledAnchor.festivalId}）${formatMonthDay(cancelledAnchor.date)}${cancelledAnchor.note ? `（${cancelledAnchor.note}）` : ""}。この祭りの旅程は組みません。中止と分かったことを伝え、祭りの結果に戻ってほかの祭りを選んでもらいます`,
    );
  }
  if (anchor === null) return lines;
  const name = ctx.festivals.get(anchor.festivalId)?.name.ja ?? anchor.festivalId;
  lines.push(
    `必ず行く祭り：${name}（${anchor.festivalId}）。行く日 ${formatMonthDayWithWeekday(anchor.date)}（${anchor.date}）。変えられません。祭り調査係は呼びません`,
  );
  if (anchorCheck !== null) lines.push(`必ず行く祭りの開催の確かめ：${anchorCheck}`);
  if (plan === null) return lines;
  const of = (status: AnchorVisit["status"]) =>
    plan.visits.filter((v) => v.status === status).map(visitLabel);
  lines.push(
    `旅の日付：${plan.startDate}〜${plan.endDate}`,
    `回る順：${plan.order.join("→")}`,
    `入れる場所：${[...plan.mustPrefectures, ...of("included")].join("、")}`,
  );
  const maybe = of("maybe");
  if (maybe.length > 0) lines.push(`余裕があれば入れる場所：${maybe.join("、")}`);
  const dropped = of("dropped");
  if (dropped.length > 0) lines.push(`今回は外す場所と理由：${dropped.join("、")}`);
  if (plan.minNights !== null) lines.push(`無理なく行くのに要る泊数の目安：${plan.minNights}泊`);
  for (const warning of plan.warnings) lines.push(`注意：${warning}`);
  return lines;
}

/** 店の記録（コンシェルジュとスタッフに共通） */
export function shopRecord(ctx: ToolContext): string {
  const { session } = ctx;
  const { conditions } = session;
  const lines: string[] = [];
  lines.push(`今日：${ctx.today()}（${formatMonthDayWithWeekday(ctx.today())}）`);
  lines.push(`会話の状態：${session.stage}（${STAGE_LABELS[session.stage]}）`);

  const known = [
    conditions.when
      ? `希望日 ${wishLabel(conditions.when)}（${JSON.stringify(conditions.when)}）`
      : null,
    conditions.origin ? `出発地 ${conditions.origin}` : null,
    conditions.destinations
      ? `行き先 ${conditions.destinations.length === 0 ? "おまかせ（どこでも）" : conditions.destinations.join("・")}`
      : null,
    // 了承を得て広げた段階。探し直すときも search_festivals が引き継ぐ
    conditions.widen === "neighbor"
      ? "行き先の広げ方 隣の県まで（了承済み）"
      : conditions.widen === "nationwide"
        ? "行き先の広げ方 全国から（了承済み）"
        : null,
    conditions.nights === undefined
      ? null
      : conditions.nights === 0
        ? "日帰り・お出かけ（0泊）"
        : `${conditions.nights}泊${conditions.nights + 1}日`,
    conditions.party ? partyLabel(conditions.party) : null,
    conditions.lodgingBudget ? lodgingBudgetLabel(conditions.lodgingBudget) : null,
    conditions.budget ? tripBudgetLabel(conditions.budget, conditions.party) : null,
    ...tripStyleLabels(conditions),
  ].filter((v): v is string => v !== null);
  lines.push(`聞き取れた条件：${known.length === 0 ? "まだありません" : known.join(" / ")}`);
  // 聞く項目と順番はコードで決める（泊数に応じて深さを変える）
  const hearing = hearingReport(ctx);
  lines.push(
    `聞き取り：${hearing.readyToSearch ? "祭りを探してよい" : "まだ探さない"}・${
      hearing.askNext.length === 0 ? "聞くことはない" : `次に聞くこと ${hearing.askNext.join("、")}`
    }`,
  );
  lines.push(`こだわり：${preferencesLabel(session.preferences)}`);

  if (session.candidates.length > 0) {
    lines.push("出した候補：");
    for (const c of session.candidates) {
      const time = c.start ? ` ${c.start}〜${c.end ?? ""}` : "";
      const confirmed = c.confirmed ? "開催確認済み" : "未確認";
      lines.push(
        `- ${c.festivalId}：${c.name} ${formatMonthDay(c.date)}${time}（${confirmed}・確度 ${c.confidence}）`,
      );
    }
  }
  if (session.candidates.length === 0 && session.nearMisses.length > 0) {
    lines.push("条件に合う祭りは見つかりませんでした。条件を1つだけ外せば出る祭り：");
    for (const c of session.nearMisses) {
      lines.push(`- ${c.festivalId}：${c.name} ${formatMonthDay(c.date)}`);
    }
  }
  if (session.selectedFestivalId) lines.push(`選んだ祭り：${session.selectedFestivalId}`);
  lines.push(...anchorLines(ctx));

  const itinerary = session.itineraryId ? ctx.itineraries.get(session.itineraryId) : undefined;
  if (itinerary === undefined) {
    lines.push("旅程：まだありません");
  } else {
    const verification =
      itinerary.verification.status === "pending"
        ? "再確認はまだ"
        : `再確認の結果 ${itinerary.verification.status}`;
    const first = itinerary.days[0];
    const last = itinerary.days.at(-1);
    const span =
      first === undefined || last === undefined || first.date === last.date
        ? formatMonthDay(first?.date ?? "")
        : `${formatMonthDay(first.date)}〜${formatMonthDay(last.date)}（${itinerary.days.length}日）`;
    const items = itinerary.days.reduce((total, day) => total + day.items.length, 0);
    lines.push(
      `旅程：第${itinerary.version}版（主役 ${itinerary.mainFestivalId}、${span}、予定${items}件、${verification}）`,
    );
  }
  return lines.join("\n");
}

const OPEN_RECORD = "<店の記録>";
const CLOSE_RECORD = "</店の記録>";
const OPEN_MESSAGE = "<お客さまの発言>";
const CLOSE_MESSAGE = "</お客さまの発言>";

/** 利用者の発言の中で、記録や発言の区切りのタグを作れないようにする */
export function sanitizeMessage(message: string): string {
  // タグの文字列だけを消すと、入れ子（</お客さまの<お客さまの発言>発言>）で消したあとにタグができる。
  // 山かっこを全角にして、発言の中ではどんなタグも作れないようにする
  return message.replaceAll("<", "＜").replaceAll(">", "＞");
}

/**
 * 返事を書く言語の決まり。日本語の画面では足さない（null）。
 * 祭り・駅・店の名前はデータの表記のまま書かせ、言い換えた名前で取り違えないようにする
 */
export function replyLanguageLine(locale: Locale = DEFAULT_LOCALE): string | null {
  return locale === "en"
    ? "画面の言語：英語。返事は英語で書く。祭り・駅・店などの名前は、データの日本語の表記のまま書き、要るなら英語の説明を添える"
    : null;
}

/** コンシェルジュに渡す、1回の発言のプロンプト */
export function turnPrompt(
  ctx: ToolContext,
  message: string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const language = replyLanguageLine(locale);
  return [
    OPEN_RECORD,
    shopRecord(ctx),
    ...(language === null ? [] : [language]),
    CLOSE_RECORD,
    OPEN_MESSAGE,
    sanitizeMessage(message),
    CLOSE_MESSAGE,
  ].join("\n");
}

/** サブエージェントの開始時に足す文脈。旅程係には今の旅程の全体を渡す */
export function staffBriefing(ctx: ToolContext, staff: Staff): string {
  const parts = [OPEN_RECORD, shopRecord(ctx), CLOSE_RECORD];
  const rules = preferenceEffects(ctx.session.preferences).rules;
  if (staff !== "researcher") {
    parts.push(`こだわりによる組み方の決まり：\n${rules.map((r) => `- ${r}`).join("\n")}`);
  }
  if (staff === "planner") {
    const festivalId =
      (ctx.session.itineraryId
        ? ctx.itineraries.get(ctx.session.itineraryId)?.mainFestivalId
        : undefined) ?? ctx.session.selectedFestivalId;
    const festival = festivalId ? ctx.festivals.get(festivalId) : undefined;
    if (festival !== undefined) {
      const buffer = arrivalBufferMinutes(festival);
      parts.push(`会場への到着の余裕：開始の${buffer}分前までに着く`);
      // 組み直しを減らすため、行く日ごとの「会場に着く締め切り」をコードで出して渡す
      const deadlines = festival.occurrences
        .filter((o) => o.status !== "cancelled" && (o.endDate ?? o.date) >= ctx.today())
        .flatMap((o) => (o.start === null ? [] : [{ date: o.date, start: o.start, end: o.end }]))
        .slice(0, 8)
        .map(
          ({ date, start, end }) =>
            `- ${formatMonthDayWithWeekday(date)}：${start} 開始 → ${fromMinutes(toMinutes(start) - buffer)} までに会場に着く。祭りの予定（type: festival）は ${start}〜${end ?? "終わりの時刻は不明"} の中に収める（祭りの前の最後の予定の終わりと、会場までの移動の目安の長いほうを足して、この時刻より前にする）`,
        );
      if (deadlines.length > 0) parts.push(`日ごとの到着の締め切り：\n${deadlines.join("\n")}`);
    }
    const itinerary = ctx.session.itineraryId
      ? ctx.itineraries.get(ctx.session.itineraryId)
      : undefined;
    if (itinerary !== undefined) {
      parts.push(
        `今の旅程（第${itinerary.version}版）。修正では、変えない予定の id と中身をそのまま残す：\n${JSON.stringify(itinerary)}`,
      );
    }
  }
  return parts.join("\n");
}
