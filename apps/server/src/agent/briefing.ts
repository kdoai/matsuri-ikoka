import type {
  ConversationStage,
  DateWish,
  LodgingBudget,
  PartialTripConditions,
  Party,
  Preferences,
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
    conditions.nights === undefined
      ? null
      : conditions.nights === 0
        ? "日帰り・お出かけ（0泊）"
        : `${conditions.nights}泊${conditions.nights + 1}日`,
    conditions.party ? partyLabel(conditions.party) : null,
    conditions.lodgingBudget ? lodgingBudgetLabel(conditions.lodgingBudget) : null,
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
  if (session.selectedFestivalId) lines.push(`選んだ祭り：${session.selectedFestivalId}`);

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

/** コンシェルジュに渡す、1回の発言のプロンプト */
export function turnPrompt(ctx: ToolContext, message: string): string {
  return [
    OPEN_RECORD,
    shopRecord(ctx),
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
        .flatMap((o) => (o.start === null ? [] : [{ date: o.date, start: o.start }]))
        .slice(0, 8)
        .map(
          ({ date, start }) =>
            `- ${formatMonthDayWithWeekday(date)}：${start} 開始 → ${fromMinutes(toMinutes(start) - buffer)} までに会場に着く（祭りの前の最後の予定の終わりと、会場までの移動の目安の長いほうを足して、この時刻より前にする）`,
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
