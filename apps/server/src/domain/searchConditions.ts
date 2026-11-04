import {
  type CandidateTravel,
  type DateWish,
  type Festival,
  type FestivalCandidate,
  type IsoDate,
  MAX_CANDIDATES,
  MAX_SEARCH_ATTEMPTS,
  MAX_SEARCH_SUGGESTIONS,
  type MinuteRange,
  type Prefecture,
  type Preferences,
  SEARCH_CONDITIONS,
  type SearchCondition,
  type SearchMiss,
  type SearchRetry,
  type SearchSuggestion,
  type SearchSuggestionKind,
} from "@matsuri-ikoka/schema";
import { addDays, formatMonthDay, weekdayOf } from "./calendar";
import {
  dayTripTravelLimit,
  type FestivalMatch,
  type SearchRanges,
  searchFestivalDates,
  searchRanges,
  wishRange,
} from "./dateWindow";
import {
  DESTINATION_STAGES,
  type DestinationPick,
  type DestinationStage,
  festivalInPrefectures,
  neighborsOf,
  pickByDestination,
} from "./destination";
import type { TravelEstimate } from "./travelEstimate";

// 祭りを探すときの条件の守り方（docs/spec/agents.md の「条件の守り方」）。
// 1. 日程とこだわりで並べた祭りを、条件（希望の日程・片道の所要時間・行き先）に照らし、外れた点を残す
// 2. 条件にすべて合う祭りだけを候補にする。合う祭りがなければ、見つからなかったと正直に返す
// 3. 条件を1つだけ外せば出る祭りを「この祭りならやっています」として、外れている点を添えて返す
// 4. 次の手（日程を先に延ばす・片道の時間を延ばす・行き先を広げる・泊まりにする）を、
//    変えた条件で探し直して数え、祭りが見つかるものだけを出す（探す回数に上限を置く）
// 計算はすべてコードで行い、モデルには判断させない。

/** 探す条件 */
export interface SearchQuery {
  when: DateWish;
  origin: string;
  /** 泊数。0 は日帰り（片道の上限で絞る） */
  nights: number;
  /**
   * 利用者が言った日帰りの片道の上限（分）。言ったときは必ず守る条件なので、
   * 上限に収まると分かっている祭り（within）だけを候補にする。言っていなければ初期値で、明らかに遠い祭りだけを外す
   */
  maxTravelMinutes?: number;
  /** 行き先の都道府県。空ならおまかせ（どこでも） */
  prefectures: readonly Prefecture[];
  /** 行き先の呼び方（お客さまの言った名前） */
  destinationLabel: string;
  /** 了承を得て広げてよい段階 */
  widen: DestinationStage;
  preferences: Preferences;
}

export interface SearchDeps {
  today: IsoDate;
  /** 期間に開かれる祭り */
  festivalsOn: (from: IsoDate, to: IsoDate) => readonly Festival[];
  /** 出発の駅からの所要時間の見積もり。省略すると祭りのデータの主要駅からの所要時間だけを使う */
  travelFor?: (festival: Festival) => TravelEstimate | null;
  random: () => number;
}

/** 条件に照らした祭り */
export interface ScreenedMatch extends FestivalMatch {
  travel: CandidateTravel;
  /** 条件から外れている点（date・travel・area の順）。空なら条件に合う */
  misses: SearchMiss[];
}

export interface SearchAttempt {
  ranges: SearchRanges;
  /** 条件にすべて合う祭り。日程とこだわりの順（全国から選ぶときはランダム） */
  fits: ScreenedMatch[];
  /** 条件から外れた祭り。外れている点を添える */
  misses: ScreenedMatch[];
  /** 行き先で選んだ結果（広げる前の問いを作るのに使う） */
  destination: DestinationPick<ScreenedMatch>;
  /** 日帰りの片道の上限（分）。泊まりの旅は null */
  travelLimit: number | null;
}

/** 「少し遠い」とみなす、上限を超える幅（分）。見積もりの下限がこれより超える祭りは紹介しない */
export const NEAR_TRAVEL_SLACK_MINUTES = 60;
/** 片道の上限を延ばす幅（分） */
export const TRAVEL_WIDEN_STEP_MINUTES = 60;
/** 片道の上限の最大（MaxTravelMinutesSchema の上限） */
const MAX_TRAVEL_MINUTES = 600;
/** 日程を先に延ばすときの、ひと月先の日数（曜日がそろうように4週間） */
export const LATER_DATES_STEP_DAYS = 28;

/** 「2時間10分」「45分」の形 */
export function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}分`;
  return rest === 0 ? `${hours}時間` : `${hours}時間${rest}分`;
}

/** 「1時間50分〜2時間30分」の形。幅がなければ1つ */
export function formatMinuteRange([lower, upper]: MinuteRange): string {
  return lower === upper
    ? formatMinutes(lower)
    : `${formatMinutes(lower)}〜${formatMinutes(upper)}`;
}

/** 候補に出す、片道の所要時間を条件に照らした値 */
export function travelOf(match: FestivalMatch, limit: number | null): CandidateTravel {
  return {
    minutes: match.travelMinutes,
    basis: match.travelBasis,
    limitMinutes: limit,
    fit: limit === null ? null : (match.travelFit ?? "unknown"),
  };
}

function dateMiss(match: FestivalMatch): SearchMiss | null {
  const days = match.daysFromWish;
  if (days === 0) return null;
  const when = days > 0 ? `${days}日後` : `${-days}日前`;
  return {
    condition: "date",
    detail: `ご希望の日の${when}（${formatMonthDay(match.date)}）に開きます`,
  };
}

/**
 * 片道の所要時間の検査。利用者が上限を言ったときは、収まると分かっている祭りだけを通す。
 * 言っていないとき（初期値の上限）は、明らかに超える祭りだけを外す
 */
function travelMiss(travel: CandidateTravel, strict: boolean): SearchMiss | null {
  const { fit, limitMinutes, minutes, basis } = travel;
  if (fit === null || limitMinutes === null || fit === "within") return null;
  if (!strict && fit !== "over") return null;
  const limit = formatMinutes(limitMinutes);
  if (fit === "unknown" || minutes === null) {
    return {
      condition: "travel",
      detail: `出発の駅からの所要時間が分からず、片道${limit}以内に収まるか確かめられません`,
    };
  }
  const about = `片道およそ${formatMinuteRange(minutes)}${basis === "estimate" ? "（駅の位置からの見積もり）" : ""}`;
  return {
    condition: "travel",
    detail:
      fit === "over"
        ? `${about}で、上限の${limit}を超えます`
        : `${about}で、上限の${limit}を超えるかもしれません`,
  };
}

function areaMiss(match: FestivalMatch, label: string): SearchMiss {
  const prefectures = [...new Set(match.festival.municipalities.map((m) => m.prefecture))];
  return {
    condition: "area",
    detail: `行き先（${label}）の外の${prefectures.join("・")}にあります`,
  };
}

/** 了承を得た段階までの行き先の都道府県。おまかせ・全国なら null（どこでも） */
export function allowedPrefectures(
  prefectures: readonly Prefecture[],
  widen: DestinationStage,
): ReadonlySet<Prefecture> | null {
  if (prefectures.length === 0 || widen === "nationwide") return null;
  return new Set(
    widen === "neighbor" ? [...prefectures, ...neighborsOf(prefectures)] : prefectures,
  );
}

/** 条件に照らす（行き先を除く）。外れている点を date・travel の順に返す */
export function screenMatch(match: FestivalMatch, query: SearchQuery): ScreenedMatch {
  const limit = dayTripTravelLimit(query.nights, query.maxTravelMinutes);
  const travel = travelOf(match, limit);
  const misses = [dateMiss(match), travelMiss(travel, query.maxTravelMinutes !== undefined)].filter(
    (miss): miss is SearchMiss => miss !== null,
  );
  return { ...match, travel, misses };
}

/**
 * 条件で1回探す。日程の窓（前後2週間）の祭りを、上限を超える祭りも含めて並べ、条件に照らして分ける。
 * 行き先は、日程と所要時間の条件に合う祭りから、了承を得た段階まで選ぶ（pickByDestination）
 */
export function runSearch(query: SearchQuery, deps: SearchDeps): SearchAttempt {
  const ranges = searchRanges(query.when, deps.today);
  const pool = ranges.expanded ? deps.festivalsOn(ranges.expanded.from, ranges.expanded.to) : [];
  const found = searchFestivalDates(pool, {
    wish: query.when,
    today: deps.today,
    origin: query.origin,
    nights: query.nights,
    preferences: query.preferences,
    ...(query.maxTravelMinutes === undefined ? {} : { maxTravelMinutes: query.maxTravelMinutes }),
    ...(deps.travelFor === undefined ? {} : { travelFor: deps.travelFor }),
    limit: Number.POSITIVE_INFINITY,
    keepOverLimit: true,
  });
  const screened = found.matches.map((match) => screenMatch(match, query));
  const destination = pickByDestination(
    screened.filter((s) => s.misses.length === 0),
    { prefectures: query.prefectures, widen: query.widen, random: deps.random },
  );
  const fits = destination.kind === "matches" ? destination.matches : [];
  const fitIds = new Set(fits.map((f) => f.festival.id));
  const allowed = allowedPrefectures(query.prefectures, query.widen);
  const misses = screened
    .filter((s) => !fitIds.has(s.festival.id))
    .map((s) =>
      allowed !== null && !festivalInPrefectures(s.festival, allowed)
        ? { ...s, misses: [...s.misses, areaMiss(s, query.destinationLabel)] }
        : s,
    )
    .filter((s) => s.misses.length > 0);
  return {
    ranges,
    fits,
    misses,
    destination,
    travelLimit: dayTripTravelLimit(query.nights, query.maxTravelMinutes),
  };
}

/** 条件から外した祭りの数（いちばんはじめに外れた条件で数える） */
export function excludedCounts(misses: readonly ScreenedMatch[]): Record<SearchCondition, number> {
  const counts: Record<SearchCondition, number> = { date: 0, travel: 0, area: 0 };
  for (const m of misses) {
    const first = m.misses[0];
    if (first !== undefined) counts[first.condition] += 1;
  }
  return counts;
}

/**
 * 条件を1つだけ外せば出る祭り（「この祭りならやっています」）。最大3件。
 * 片道の時間で外れた祭りは、上限を少し（NEAR_TRAVEL_SLACK_MINUTES）超えるものまで。
 * 外れている条件がかたよらないよう、日程・所要時間・行き先から順に1件ずつ選ぶ
 */
export function nearMissesOf(
  attempt: Pick<SearchAttempt, "misses" | "travelLimit">,
  limit: number = MAX_CANDIDATES,
): { match: ScreenedMatch; miss: SearchMiss }[] {
  const groups = new Map<SearchCondition, ScreenedMatch[]>(SEARCH_CONDITIONS.map((c) => [c, []]));
  for (const m of attempt.misses) {
    const [miss] = m.misses;
    if (m.misses.length !== 1 || miss === undefined) continue;
    if (miss.condition === "travel" && attempt.travelLimit !== null) {
      const lower = m.travel.minutes?.[0];
      if (lower === undefined || lower > attempt.travelLimit + NEAR_TRAVEL_SLACK_MINUTES) continue;
    }
    groups.get(miss.condition)?.push(m);
  }
  const picked: { match: ScreenedMatch; miss: SearchMiss }[] = [];
  for (let round = 0; picked.length < limit; round += 1) {
    let added = false;
    for (const condition of SEARCH_CONDITIONS) {
      const m = groups.get(condition)?.[round];
      if (m === undefined || picked.length >= limit) continue;
      picked.push({ match: m, miss: m.misses[0] as SearchMiss });
      added = true;
    }
    if (!added) break;
  }
  return picked;
}

/**
 * 出す直前の候補が条件に合うかを、候補の形の値で確かめ直す。合わないものが混じっていたら出さない。
 * - 希望の日程の中（daysFromWish が 0）
 * - 日帰りの片道：上限を言われたら within、言われていなければ over でない
 * - 行き先：了承を得た段階までの都道府県の中
 */
export function withinConditions(
  candidate: FestivalCandidate,
  festival: Pick<Festival, "municipalities"> | undefined,
  query: SearchQuery,
): boolean {
  if (candidate.daysFromWish !== 0) return false;
  const limit = dayTripTravelLimit(query.nights, query.maxTravelMinutes);
  if (limit !== null) {
    const fit = candidate.travel?.fit ?? "unknown";
    if (query.maxTravelMinutes !== undefined ? fit !== "within" : fit === "over") return false;
  }
  const allowed = allowedPrefectures(query.prefectures, query.widen);
  if (allowed === null) return true;
  return festival !== undefined && festivalInPrefectures(festival, allowed);
}

// ---------------------------------------------------------------------------
// 次の手

interface PlannedStep {
  kind: Exclude<SearchSuggestionKind, "edit_conditions">;
  label: string;
  message: string;
  retry: SearchRetry;
}

function dateLabel(when: DateWish): string {
  const { from, to } = wishRange(when);
  return from === to ? formatMonthDay(from) : `${formatMonthDay(from)}〜${formatMonthDay(to)}`;
}

function laterDatesStep(when: DateWish, label: string): PlannedStep {
  return {
    kind: "later_dates",
    label: `${label}（${dateLabel(when)}）で探す`,
    message: `日程を${dateLabel(when)}に変えて、もう一度祭りを探してください。`,
    retry: { when },
  };
}

/** 希望の日程が終わったあとの、次の土日 */
export function nextWeekend(when: DateWish): DateWish {
  const { to } = wishRange(when);
  let saturday = addDays(to, 1);
  while (weekdayOf(saturday) !== "sat") saturday = addDays(saturday, 1);
  return { kind: "range", from: saturday, to: addDays(saturday, 1) };
}

/** 希望の日程を、曜日をそろえて4週間先にずらす */
export function shiftWish(when: DateWish, days: number): DateWish {
  return when.kind === "date"
    ? { kind: "date", date: addDays(when.date, days) }
    : { kind: "range", from: addDays(when.from, days), to: addDays(when.to, days) };
}

/** 試す順の次の手。日程を先に延ばす → 片道の時間を延ばす → 行き先を広げる → 泊まりにする */
export function plannedSteps(query: SearchQuery): PlannedStep[] {
  const steps: PlannedStep[] = [
    laterDatesStep(nextWeekend(query.when), "次の週末"),
    laterDatesStep(shiftWish(query.when, LATER_DATES_STEP_DAYS), "4週間後"),
  ];
  const limit = dayTripTravelLimit(query.nights, query.maxTravelMinutes);
  if (limit !== null && limit < MAX_TRAVEL_MINUTES) {
    const longer = Math.min(MAX_TRAVEL_MINUTES, limit + TRAVEL_WIDEN_STEP_MINUTES);
    steps.push({
      kind: "longer_travel",
      label: `片道${formatMinutes(longer)}まで広げる`,
      message: `片道${formatMinutes(longer)}以内まで広げて、もう一度祭りを探してください。`,
      retry: { maxTravelMinutes: longer },
    });
  }
  if (query.prefectures.length > 0) {
    const current = DESTINATION_STAGES.indexOf(query.widen);
    if (current < DESTINATION_STAGES.indexOf("neighbor")) {
      steps.push({
        kind: "wider_area",
        label: "隣の県まで広げる",
        message: "行き先を隣の県まで広げて、もう一度祭りを探してください。",
        retry: { widen: "neighbor" },
      });
    }
    if (current < DESTINATION_STAGES.indexOf("nationwide")) {
      steps.push({
        kind: "wider_area",
        label: "全国から探す",
        message: "行き先を全国に広げて、もう一度祭りを探してください。",
        retry: { widen: "nationwide" },
      });
    }
  }
  if (query.nights === 0) {
    steps.push({
      kind: "stay_over",
      label: "1泊の旅にする",
      message: "日帰りではなく1泊の旅にして、もう一度祭りを探してください。",
      retry: { nights: 1 },
    });
  }
  return steps;
}

/** 次の手の条件で探す条件を作る（渡した項目だけを変える。泊まりの旅では片道の上限は使われない） */
export function applyRetry(query: SearchQuery, retry: SearchRetry): SearchQuery {
  const maxTravelMinutes = retry.maxTravelMinutes ?? query.maxTravelMinutes;
  return {
    ...query,
    when: retry.when ?? query.when,
    nights: retry.nights ?? query.nights,
    widen: retry.widen ?? query.widen,
    ...(maxTravelMinutes === undefined ? {} : { maxTravelMinutes }),
  };
}

export const EDIT_CONDITIONS_SUGGESTION: SearchSuggestion = {
  kind: "edit_conditions",
  label: "条件を選び直す",
  retry: null,
  message: null,
  found: null,
};

/**
 * 次の手を、変えた条件で探し直して数え、条件に合う祭りが新しく見つかるものだけを返す（最後に「条件を選び直す」）。
 * 数えるのは、いまの候補（shown）にない祭り。探す回数は、はじめの検索を含めて MAX_SEARCH_ATTEMPTS まで。
 * 行き先を広げる手は、隣の県で見つかれば全国は試さない
 */
export function suggestNextSteps(
  query: SearchQuery,
  deps: SearchDeps,
  options: { maxAttempts?: number; shown?: ReadonlySet<string> } = {},
): { suggestions: SearchSuggestion[]; attempts: number } {
  const maxAttempts = options.maxAttempts ?? MAX_SEARCH_ATTEMPTS;
  const shown = options.shown ?? new Set<string>();
  const suggestions: SearchSuggestion[] = [];
  let attempts = 1;
  let widened = false;
  for (const step of plannedSteps(query)) {
    if (attempts >= maxAttempts) break;
    if (step.kind === "wider_area" && widened) continue;
    const found = runSearch(applyRetry(query, step.retry), deps).fits.filter(
      (f) => !shown.has(f.festival.id),
    ).length;
    attempts += 1;
    if (found === 0) continue;
    if (step.kind === "wider_area") widened = true;
    suggestions.push({ ...step, found });
  }
  return {
    suggestions: [...suggestions.slice(0, MAX_SEARCH_SUGGESTIONS - 1), EDIT_CONDITIONS_SUGGESTION],
    attempts,
  };
}
