import { createFestivalStore } from "../apps/server/src/data/festivalStore";
import { addDays } from "../apps/server/src/domain/calendar";
import {
  runSearch,
  type SearchDeps,
  type SearchQuery,
  suggestNextSteps,
} from "../apps/server/src/domain/searchConditions";
import { estimateTravel, type StationPointIndex } from "../apps/server/src/domain/travelEstimate";
import {
  type DateWish,
  DEFAULT_PREFERENCES,
  type Festival,
  type IsoDate,
} from "../packages/schema/src";
import type { Ratio } from "./evaluation";

// 相談でよくある条件の組を祭りの検索に流し、候補を出せた割合と、条件を守れたかを集計する。
// 接客と同じ検索（runSearch・suggestNextSteps）を使う。モデルも通信も使わないので、同じデータなら同じ数字になる。
// エージェントの選び方や、公式の情報での確かめは測らない。

/** 評価に使う出発の駅。9つの地方から1つずつ（中部は東海と北陸の2つ） */
export const EVALUATION_ORIGINS = [
  "札幌",
  "仙台",
  "東京",
  "名古屋",
  "金沢",
  "大阪",
  "広島",
  "高松",
  "福岡",
  "那覇空港",
] as const;

/** 評価に使う泊数：日帰りと1泊 */
export const EVALUATION_NIGHTS = [0, 1] as const;

/** 先の何か月ぶんを測るか（基準の日の月を含む） */
export const EVALUATION_MONTHS = 12;

export type WishShape = "month" | "saturday";

export interface ConditionCase {
  /** YYYY-MM */
  month: string;
  shape: WishShape;
  when: DateWish;
  origin: string;
  nights: number;
}

export interface ConditionEvaluation {
  today: IsoDate;
  /** 候補が1件以上出た条件の組 */
  found: Ratio;
  /** 候補を3件（画面に並べる数）そろえられた条件の組 */
  threeOrMore: Ratio;
  /** 候補が出なかった組のうち、探し直せる次の手を示せた組 */
  nextStepWhenNone: Ratio;
  /** 候補の数の合計と、そのうち条件を破っていた候補 */
  candidates: number;
  violations: string[];
  /** 候補のうち、開催が公式か複数の情報源で確かめられているもの（残りは例年からの見込み） */
  confirmedCandidates: Ratio;
  /** 日帰りの候補のうち、片道の上限に収まると分かっているもの（残りは収まるか確かめきれない） */
  dayTripWithinLimit: Ratio;
  byNights: Record<number, Ratio>;
  byShape: Record<WishShape, Ratio>;
  byOrigin: Record<string, Ratio>;
  byMonth: Record<string, Ratio>;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 月の1日からの、その月の日付。基準の日より前は基準の日に詰める */
function monthDays(year: number, month: number, today: IsoDate) {
  const first = `${year}-${pad(month)}-01`;
  const next = month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`;
  return { from: first < today ? today : first, to: addDays(next, -1) };
}

/** 期間の中で最初の土曜日。なければ null */
function firstSaturday(from: IsoDate, to: IsoDate): IsoDate | null {
  for (let date = from; date <= to; date = addDays(date, 1)) {
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === 6) return date;
  }
  return null;
}

/** 評価する条件の組：出発の駅 × 泊数 × 月ごとの「その月のどこか」と「最初の土曜日」 */
export function conditionCases(today: IsoDate): ConditionCase[] {
  const cases: ConditionCase[] = [];
  const startYear = Number(today.slice(0, 4));
  const startMonth = Number(today.slice(5, 7));
  for (let offset = 0; offset < EVALUATION_MONTHS; offset += 1) {
    const index = startMonth - 1 + offset;
    const year = startYear + Math.floor(index / 12);
    const month = (index % 12) + 1;
    const { from, to } = monthDays(year, month, today);
    const saturday = firstSaturday(from, to);
    const wishes: { shape: WishShape; when: DateWish }[] = [
      { shape: "month", when: { kind: "range", from, to } },
      ...(saturday === null
        ? []
        : [{ shape: "saturday" as const, when: { kind: "date" as const, date: saturday } }]),
    ];
    for (const origin of EVALUATION_ORIGINS) {
      for (const nights of EVALUATION_NIGHTS) {
        for (const wish of wishes) {
          cases.push({ month: `${year}-${pad(month)}`, origin, nights, ...wish });
        }
      }
    }
  }
  return cases;
}

function bump(group: Record<string | number, Ratio>, key: string | number, hit: boolean): void {
  const ratio = group[key] ?? { count: 0, total: 0 };
  ratio.total += 1;
  if (hit) ratio.count += 1;
  group[key] = ratio;
}

function wishBounds(when: DateWish): { from: IsoDate; to: IsoDate } {
  return when.kind === "date" ? { from: when.date, to: when.date } : when;
}

/**
 * 候補が条件を破っていないかを、検索とは別に確かめる。
 * 破っていれば、どの条件の組のどの祭りかを1行で返す
 */
function violationOf(
  item: ConditionCase,
  today: IsoDate,
  fit: ReturnType<typeof runSearch>["fits"][number],
): string | null {
  const { from, to } = wishBounds(item.when);
  const label = `${item.origin} ${item.nights}泊 ${from}〜${to} ${fit.festival.id}`;
  if (fit.festival.optOut) return `${label}：掲載停止の祭りが出た`;
  const occurrence = fit.festival.occurrences.find(
    (o) => o.date <= fit.date && fit.date <= (o.endDate ?? o.date),
  );
  if (occurrence === undefined) return `${label}：${fit.date} の開催回がない`;
  if (occurrence.status === "cancelled" || occurrence.status === "postponed") {
    return `${label}：中止か延期の回が出た`;
  }
  if (fit.date < today) return `${label}：過ぎた日が出た`;
  if (fit.date < from || to < fit.date) return `${label}：希望の日から外れた（${fit.date}）`;
  if (item.nights === 0 && fit.travelFit === "over") {
    return `${label}：日帰りの片道の上限を超えた`;
  }
  return null;
}

export function evaluateConditions(
  festivals: readonly Festival[],
  { today, stations }: { today: IsoDate; stations?: StationPointIndex | undefined },
): ConditionEvaluation {
  const store = createFestivalStore(festivals);
  const result: ConditionEvaluation = {
    today,
    found: { count: 0, total: 0 },
    threeOrMore: { count: 0, total: 0 },
    nextStepWhenNone: { count: 0, total: 0 },
    candidates: 0,
    violations: [],
    confirmedCandidates: { count: 0, total: 0 },
    dayTripWithinLimit: { count: 0, total: 0 },
    byNights: {},
    byShape: { month: { count: 0, total: 0 }, saturday: { count: 0, total: 0 } },
    byOrigin: {},
    byMonth: {},
  };

  for (const item of conditionCases(today)) {
    const query: SearchQuery = {
      when: item.when,
      origin: item.origin,
      nights: item.nights,
      prefectures: [],
      destinationLabel: "",
      widen: "area",
      preferences: DEFAULT_PREFERENCES,
    };
    const deps: SearchDeps = {
      today,
      festivalsOn: (from, to) => store.onDates(from, to),
      ...(stations === undefined
        ? {}
        : {
            travelFor: (festival: Festival) =>
              estimateTravel(
                { access: festival.access, venue: festival.venue, origin: item.origin },
                stations,
              ),
          }),
      // 全国から選ぶときの並びを決めるだけで、数には効かない。同じ数字になるように固定する
      random: () => 0,
    };

    const { fits } = runSearch(query, deps);
    const hit = fits.length > 0;
    result.found.total += 1;
    result.threeOrMore.total += 1;
    if (hit) result.found.count += 1;
    if (fits.length >= 3) result.threeOrMore.count += 1;
    bump(result.byNights, item.nights, hit);
    bump(result.byShape, item.shape, hit);
    bump(result.byOrigin, item.origin, hit);
    bump(result.byMonth, item.month, hit);

    result.candidates += fits.length;
    for (const fit of fits) {
      const violation = violationOf(item, today, fit);
      if (violation !== null) result.violations.push(violation);
      result.confirmedCandidates.total += 1;
      if (fit.confirmed) result.confirmedCandidates.count += 1;
      if (item.nights === 0) {
        result.dayTripWithinLimit.total += 1;
        if (fit.travelFit === "within") result.dayTripWithinLimit.count += 1;
      }
    }

    if (!hit) {
      result.nextStepWhenNone.total += 1;
      // 「条件を選び直す」は必ず付くので数えず、探し直して祭りが見つかる手（found がある）だけを数える
      const { suggestions } = suggestNextSteps(query, deps);
      if (suggestions.some((s) => (s.found ?? 0) > 0)) result.nextStepWhenNone.count += 1;
    }
  }
  return result;
}
