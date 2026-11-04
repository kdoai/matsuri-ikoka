import type {
  ConsideredPlace,
  ItineraryItem,
  LastReturn,
  MealPlan,
  MealSlot,
  Move,
  PlanGap,
} from "@matsuri-ikoka/schema";
import { toMinutes } from "./calendar";

// 旅程の点検のうち「そろっているか」を確かめる。予定の矛盾（planCheck.ts）とは別に、
// 旅に出るのに要るもの（行き・最後の移動・帰り・乗り換え・帰りの最終・食事・調べた場所の採否）が
// そろっているかを見て、足りないものを不足（gaps）として返す。保存は止めず、評価の点に入れる。
// 分からないところは推測で埋めず、不足として残す。

export type CoverageItem = Pick<
  ItineraryItem,
  "id" | "start" | "end" | "type" | "name" | "reason" | "move" | "spotId" | "sources"
>;

export interface CoverageDay {
  date: string;
  items: readonly CoverageItem[];
  stay: unknown;
  meals?: readonly MealPlan[] | undefined;
  lastReturn?: LastReturn | null | undefined;
}

export interface CoveragePlan {
  days: readonly CoverageDay[];
  considered?: readonly ConsideredPlace[] | undefined;
}

/** 周辺係・宿の係が見つけた場所 */
export interface ResearchedPlace {
  id: string;
  name: string;
  from: ConsideredPlace["from"];
}

/** 食事の時間帯。滞在の時間帯がこの幅に MEAL_OVERLAP_MINUTES 以上かかれば、その食事の案が要る */
export const MEAL_WINDOWS: Readonly<Record<MealSlot, readonly [string, string]>> = {
  lunch: ["11:30", "13:30"],
  dinner: ["17:30", "19:30"],
};
export const MEAL_OVERLAP_MINUTES = 30;

const MEAL_LABELS: Record<MealSlot, string> = { lunch: "昼", dinner: "夜" };

/** 電車・バスを使う移動か（乗り換えの区間・出典・帰りの最終が要る） */
export function isTransitMove(move: Move | null): boolean {
  if (move === null) return false;
  if (move.means === "train" || move.means === "bus") return true;
  return (move.legs ?? []).some((leg) => leg.means === "train" || leg.means === "bus");
}

/** 時刻の幅を分にする。終わりが始まりより前なら日をまたぐ */
function span(start: string, end: string): [number, number] {
  const from = toMinutes(start);
  let to = toMinutes(end);
  if (to < from) to += 1440;
  return [from, to];
}

function overlap(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
}

/**
 * その日の滞在の時間帯（出発の駅からの移動が着いてから、帰りの移動に乗るまで）。
 * 最初の予定が行きの移動ならその終わりから、最後の予定が帰りの移動ならその始まりまで
 */
export function stayWindow(day: CoverageDay, isFirstDay: boolean, isLastDay: boolean) {
  const first = day.items[0];
  const last = day.items.at(-1);
  if (first === undefined || last === undefined) return null;
  const startsWithMove = isFirstDay && first.type === "move";
  const endsWithMove = isLastDay && last.type === "move" && day.items.length > 1;
  const from = toMinutes(startsWithMove ? first.end : first.start);
  let to = toMinutes(endsWithMove ? last.start : last.end);
  if (to < from) to += 1440;
  return [from, to] as const;
}

/** その日に案が要る食事 */
export function mealsNeeded(day: CoverageDay, isFirstDay: boolean, isLastDay: boolean): MealSlot[] {
  const window = stayWindow(day, isFirstDay, isLastDay);
  if (window === null) return [];
  return (Object.keys(MEAL_WINDOWS) as MealSlot[]).filter((slot) => {
    const [start, end] = MEAL_WINDOWS[slot];
    return overlap(window, span(start, end)) >= MEAL_OVERLAP_MINUTES;
  });
}

/** その食事の時間帯に、食事の案（meals）か食事の予定があるか */
function mealCovered(day: CoverageDay, slot: MealSlot): boolean {
  if (day.meals?.some((meal) => meal.slot === slot)) return true;
  const [start, end] = MEAL_WINDOWS[slot];
  const window = span(start, end);
  return day.items.some(
    (item) => item.type === "meal" && overlap(span(item.start, item.end), window) > 0,
  );
}

/** 祭りの予定の前に、会場までの最後の移動があるか */
function hasLastMile(items: readonly CoverageItem[], festivalIndex: number): boolean {
  const festival = items[festivalIndex];
  if (festival?.move != null) return true;
  for (let index = festivalIndex - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item === undefined) break;
    if (item.type === "festival_prep") {
      if (item.move !== null) return true;
      continue;
    }
    return item.type === "move" && item.move?.purpose === "last_mile";
  }
  return false;
}

/** 日ごとの不足。何日かの旅では、どの日の不足かを書き添える */
function dayGaps(day: CoverageDay, index: number, days: number): PlanGap[] {
  const gaps: PlanGap[] = [];
  const label = days > 1 ? `${index + 1}日目：` : "";
  const isFirst = index === 0;
  const isLast = index === days - 1;
  const first = day.items[0];
  const last = day.items.at(-1);

  if (isFirst && first !== undefined && first.type !== "move") {
    gaps.push({
      code: "outbound_missing",
      itemId: null,
      message: `${label}出発の駅からの移動がありません`,
    });
  }
  const returnMove =
    isLast && last !== undefined && last.type === "move" && day.items.length > 1 ? last : null;
  if (isLast && returnMove === null) {
    gaps.push({ code: "return_missing", itemId: null, message: `${label}帰りの移動がありません` });
  }
  if (returnMove !== null && isTransitMove(returnMove.move)) {
    if (day.lastReturn == null || day.lastReturn.departBy === null) {
      gaps.push({
        code: "last_return_unknown",
        itemId: returnMove.id,
        message: `${label}帰りの最終の時刻が分かっていません`,
      });
    }
  }

  day.items.forEach((item, itemIndex) => {
    if (item.type === "festival" && !hasLastMile(day.items, itemIndex)) {
      gaps.push({
        code: "last_mile_missing",
        itemId: item.id,
        message: `${label}「${item.name}」の会場までの最後の移動（駅から歩く・バスなど）がありません`,
      });
    }
    if (item.type === "move" && item.move !== null) {
      if (item.move.from === undefined || item.move.to === undefined) {
        gaps.push({
          code: "move_endpoints_missing",
          itemId: item.id,
          message: `${label}「${item.name}」の出発・到着の場所がありません`,
        });
      }
      if (isTransitMove(item.move) && item.move.legs === undefined) {
        gaps.push({
          code: "transfer_unknown",
          itemId: item.id,
          message: `${label}「${item.name}」の乗り換えの駅と路線が分かっていません`,
        });
      }
      if (isTransitMove(item.move) && item.sources.length === 0) {
        gaps.push({
          code: "move_unsourced",
          itemId: item.id,
          message: `${label}「${item.name}」の行き方に出典がありません`,
        });
      }
    }
    if (item.type === "meal" && item.sources.length === 0) {
      gaps.push({
        code: "meal_unsourced",
        itemId: item.id,
        message: `${label}「${item.name}」に出典がありません`,
      });
    }
  });

  for (const slot of mealsNeeded(day, isFirst, isLast)) {
    if (!mealCovered(day, slot)) {
      const [start, end] = MEAL_WINDOWS[slot];
      gaps.push({
        code: "meal_missing",
        itemId: null,
        message: `${label}${MEAL_LABELS[slot]}の食事（${start}〜${end}ごろ）の店か案がありません`,
      });
    }
  }
  return gaps;
}

/**
 * 旅程の不足を返す。researched は周辺係・宿の係が見つけた場所で、
 * 採否と理由（considered）のない場所を不足にする
 */
export function findGaps(
  plan: CoveragePlan,
  researched: readonly ResearchedPlace[] = [],
): PlanGap[] {
  const gaps = plan.days.flatMap((day, index) => dayGaps(day, index, plan.days.length));
  const reviewed = new Set((plan.considered ?? []).map((place) => place.id));
  const unreviewed = researched.filter((place) => !reviewed.has(place.id));
  if (unreviewed.length > 0) {
    gaps.push({
      code: "research_unreviewed",
      itemId: null,
      message: `調べた場所の採否と理由がありません：${unreviewed
        .slice(0, 5)
        .map((place) => place.name)
        .join("、")}${unreviewed.length > 5 ? ` ほか${unreviewed.length - 5}か所` : ""}`,
    });
  }
  return gaps;
}

/** 泊まりに付けた宿の候補で、旅程係が理由を書かなかったときの理由 */
export const LODGING_ADOPTED_REASON = "その夜に泊まる宿の候補として旅程に付けた";

/**
 * 調べた場所の採否を、旅程の予定と宿の候補から決め直す。
 * - 採ったか（adopted）は、予定の spotId と宿の候補の id からコードで決める（旅程係の書いた値は使わない）
 * - 理由は旅程係の書いたものを使う。採った場所で理由がなければ、その予定の理由を使う
 * - 採らなかった場所で理由がなければ、入れない（不足 research_unreviewed になる）
 * - 調べた場所にないもの（旅程係が作った ID）は入れない
 */
export function reconcileConsidered(
  written: readonly Pick<ConsideredPlace, "id" | "reason">[] | undefined,
  plan: { days: readonly { items: readonly CoverageItem[]; stay: unknown }[] },
  researched: readonly ResearchedPlace[],
  lodgingOfferIds: ReadonlySet<string> = new Set(),
): ConsideredPlace[] {
  const reasons = new Map((written ?? []).map((place) => [place.id, place.reason.trim()]));
  const itemsBySpot = new Map<string, CoverageItem>();
  for (const day of plan.days) {
    for (const item of day.items) {
      if (item.spotId !== undefined && !itemsBySpot.has(item.spotId))
        itemsBySpot.set(item.spotId, item);
    }
  }
  return researched.flatMap((place): ConsideredPlace[] => {
    const item = itemsBySpot.get(place.id);
    const adopted = place.from === "lodging" ? lodgingOfferIds.has(place.id) : item !== undefined;
    const fallback = place.from === "lodging" ? LODGING_ADOPTED_REASON : item?.reason;
    const reason = reasons.get(place.id) || (adopted ? fallback : undefined);
    if (reason === undefined || reason === "") return [];
    return [
      { id: place.id, name: place.name, from: place.from, adopted, reason: reason.slice(0, 120) },
    ];
  });
}
