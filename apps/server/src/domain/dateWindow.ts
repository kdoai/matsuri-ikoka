import {
  type Access,
  type DateWish,
  type Festival,
  type FestivalCandidate,
  type IsoDate,
  isOccurrenceConfirmed,
  MAX_CANDIDATES,
  type MinuteRange,
  type Occurrence,
  type Preferences,
  type Source,
  strongestConfidence,
  type TripConditions,
} from "@matsuri-ikoka/schema";
import { addDays, daysBetween, earlierDate, laterDate } from "./calendar";
import { popularityRank } from "./preferences";
import { type TravelEstimate, type TravelFit, travelFit } from "./travelEstimate";

/** 希望日の祭りが3件に満たないとき、前後に広げる日数 */
export const WISH_EXPANSION_DAYS = 14;
/** 日帰りで行ける、片道の移動時間の上限（分）の初期値 */
export const DAY_TRIP_MAX_TRAVEL_MINUTES = 150;

/**
 * 日帰りの片道の上限（分）。泊まりの旅は遠くても行けるので絞り込まず null。
 * 利用者が上限を言っていなければ、初期値（DAY_TRIP_MAX_TRAVEL_MINUTES）
 */
export function dayTripTravelLimit(
  nights: TripConditions["nights"],
  maxTravelMinutes: number | undefined,
): number | null {
  if (nights > 0) return null;
  return maxTravelMinutes ?? DAY_TRIP_MAX_TRAVEL_MINUTES;
}

export interface DateRange {
  from: IsoDate;
  to: IsoDate;
}

export interface SearchRanges {
  /** 希望日（期間）。今日より前は除く。すべて過去なら null */
  wish: DateRange | null;
  /** 補うときに探す範囲（前後2週間）。今日より前は除く */
  expanded: DateRange | null;
}

export function wishRange(wish: DateWish): DateRange {
  return wish.kind === "date"
    ? { from: wish.date, to: wish.date }
    : { from: wish.from, to: wish.to };
}

function clipToToday(range: DateRange, today: IsoDate): DateRange | null {
  const from = laterDate(range.from, today);
  return from <= range.to ? { from, to: range.to } : null;
}

/** 探す範囲。希望日を先に、足りなければ前後2週間。どちらも今日より前の日は含めない */
export function searchRanges(wish: DateWish, today: IsoDate): SearchRanges {
  const range = wishRange(wish);
  return {
    wish: clipToToday(range, today),
    expanded: clipToToday(
      {
        from: addDays(range.from, -WISH_EXPANSION_DAYS),
        to: addDays(range.to, WISH_EXPANSION_DAYS),
      },
      today,
    ),
  };
}

/** 希望日からのずれ（日）。期間の中なら 0、前なら負、後なら正 */
export function daysFromWish(date: IsoDate, wish: DateWish): number {
  const { from, to } = wishRange(wish);
  if (date < from) return daysBetween(from, date);
  if (date > to) return daysBetween(to, date);
  return 0;
}

function normalizePlace(name: string): string {
  return name.replace(/[\s　]/g, "").replace(/駅$/, "");
}

/** 出発地に当たる主要駅。名前の「駅」と空白の有無は問わない */
export function matchHub(access: Access, origin: string): Access["fromHubs"][number] | undefined {
  return access.fromHubs.find((h) => normalizePlace(h.hub) === normalizePlace(origin));
}

/**
 * 出発地から会場までの移動時間の目安（分の幅）。
 * 保存してある主要駅からの所要時間に、最寄り駅から会場までの徒歩を足す。出発地が主要駅にないときは null
 */
export function travelMinutesFrom(access: Access, origin: string): MinuteRange | null {
  const hub = matchHub(access, origin);
  if (hub === undefined) return null;
  const walk = access.stations[0]?.walkMinutes ?? [0, 0];
  return [hub.minutes[0] + walk[0], hub.minutes[1] + walk[1]];
}

export interface FestivalMatch {
  festival: Festival;
  occurrence: Occurrence;
  /** 行く日。複数日の開催なら、希望日にいちばん近い日 */
  date: IsoDate;
  daysFromWish: number;
  confirmed: boolean;
  /** 出発地からの移動時間の目安。分からなければ null */
  travelMinutes: MinuteRange | null;
  /** 移動時間の目安の根拠。data：祭りのデータ / estimate：駅の位置からの見積もり / null：分からない */
  travelBasis: TravelEstimate["basis"] | null;
  /** 日帰りの上限と比べた結果。泊まりの旅や、移動時間が分からないときは null */
  travelFit: TravelFit | null;
}

export interface FestivalSearchOptions {
  wish: DateWish;
  today: IsoDate;
  origin: string;
  /** 泊数。0（日帰り・お出かけ）は、片道の移動の上限を超える祭りを除く */
  nights: TripConditions["nights"];
  preferences: Preferences;
  /**
   * 日帰りの片道の上限（分）。利用者が言ったときだけ渡す。省略すると DAY_TRIP_MAX_TRAVEL_MINUTES。
   * 渡したときは、上限に収まると分かっている祭りを、所要時間の分からない祭りより先に並べる
   */
  maxTravelMinutes?: number;
  /**
   * 祭りごとの、出発地からの移動時間の目安。省略すると祭りのデータの主要駅からの所要時間だけを使う
   * （出発地が主要駅でなければ分からない）。接客サーバーは駅の位置からの見積もり（estimateTravel）を渡す
   */
  travelFor?: (festival: Festival) => TravelEstimate | null;
  /** 返す数。省略すると MAX_CANDIDATES（開催を確かめてから選ぶときは多めに取る） */
  limit?: number;
  /**
   * 片道の上限を超える祭りも matches に残す（travelFit は over。tooFar にも入れる）。
   * 条件の検査（searchConditions.ts）で外した理由を残し、「少し遠い」祭りとして紹介するときに使う
   */
  keepOverLimit?: boolean;
}

/** 祭りのデータの主要駅からの所要時間だけで決める、移動時間の目安 */
function dataTravel(festival: Festival, origin: string): TravelEstimate | null {
  const minutes = travelMinutesFrom(festival.access, origin);
  return minutes === null ? null : { minutes, basis: "data", nearestStation: null, viaHub: null };
}

export interface FestivalSearchResult {
  ranges: SearchRanges;
  /** 希望日の祭りを先に、こだわりに合う順で最大3件（limit を渡せばその数） */
  matches: FestivalMatch[];
  /** 日帰りの移動の上限を超えたので除いた祭り */
  tooFar: { festivalId: string; travelMinutes: MinuteRange }[];
  /** 日帰りで、出発地からの所要時間が分からないまま候補に残した祭り（matches のうち） */
  travelUnknown: string[];
  /** 日帰りで、見積もりの幅が上限をまたぐ（収まるか分からない）まま候補に残した祭り（matches のうち） */
  travelUncertain: string[];
}

/** 開催回のうち、範囲に入る日で希望日にいちばん近い日。なければ null */
function closestDayInRange(
  occurrence: Occurrence,
  range: DateRange,
  wish: DateWish,
): IsoDate | null {
  const from = laterDate(occurrence.date, range.from);
  const to = earlierDate(occurrence.endDate ?? occurrence.date, range.to);
  if (from > to) return null;
  const { from: wishFrom, to: wishTo } = wishRange(wish);
  if (to < wishFrom) return to;
  if (from > wishTo) return from;
  // 希望の期間と重なる：重なりの最初の日
  return laterDate(from, wishFrom);
}

/**
 * 日程のルールで祭りを探す。
 * 1. 希望日（期間）の祭りを先に並べる
 * 2. 3件に満たなければ、前後2週間の祭りで補う（ずれの日数を付ける）
 * 3. 今日より前の日、中止・延期、掲載停止の祭りは出さない
 * 4. 日帰りは、片道の移動時間の上限を超える祭りを除く。駅の位置からの見積もりは、下限でも超えるときだけ除く
 *    （移動時間が分からない祭りと、見積もりが境目の祭りは残す）。
 *    利用者が上限を言ったときは、必ず守る条件なので希望日より先に、上限に収まると分かっている祭り、
 *    境目の祭り、分からない祭りの順に並べる。
 *    泊まりの旅は絞り込まない
 */
export function searchFestivalDates(
  festivals: readonly Festival[],
  options: FestivalSearchOptions,
): FestivalSearchResult {
  const ranges = searchRanges(options.wish, options.today);
  const maxTravel = dayTripTravelLimit(options.nights, options.maxTravelMinutes);
  const preferKnownTravel = maxTravel !== null && options.maxTravelMinutes !== undefined;
  const tooFar: FestivalSearchResult["tooFar"] = [];
  const matches: FestivalMatch[] = [];

  if (ranges.expanded === null) {
    return { ranges, matches, tooFar, travelUnknown: [], travelUncertain: [] };
  }
  const travelFor =
    options.travelFor ?? ((festival: Festival) => dataTravel(festival, options.origin));

  for (const festival of festivals) {
    if (festival.optOut) continue;

    let best: FestivalMatch | null = null;
    const travel = travelFor(festival);
    for (const occurrence of festival.occurrences) {
      if (occurrence.status === "cancelled" || occurrence.status === "postponed") continue;
      const date = closestDayInRange(occurrence, ranges.expanded, options.wish);
      if (date === null) continue;
      const offset = daysFromWish(date, options.wish);
      if (best === null || Math.abs(offset) < Math.abs(best.daysFromWish)) {
        best = {
          festival,
          occurrence,
          date,
          daysFromWish: offset,
          confirmed: isOccurrenceConfirmed(occurrence),
          travelMinutes: travel?.minutes ?? null,
          travelBasis: travel?.basis ?? null,
          travelFit: travel === null || maxTravel === null ? null : travelFit(travel, maxTravel),
        };
      }
    }
    if (best === null) continue;

    if (best.travelFit === "over" && best.travelMinutes !== null) {
      tooFar.push({ festivalId: festival.id, travelMinutes: best.travelMinutes });
      if (!options.keepOverLimit) continue;
    }
    matches.push(best);
  }

  matches.sort((a, b) => {
    // 利用者が言った所要時間の上限は必ず守る条件なので、日のずれ（希望）より先に見る
    if (preferKnownTravel) {
      const byFit = fitRank(a.travelFit) - fitRank(b.travelFit);
      if (byFit !== 0) return byFit;
    }
    const byWish = Number(a.daysFromWish !== 0) - Number(b.daysFromWish !== 0);
    if (byWish !== 0) return byWish;
    const byDistance = Math.abs(a.daysFromWish) - Math.abs(b.daysFromWish);
    if (byDistance !== 0) return byDistance;
    const byConfirmed = Number(b.confirmed) - Number(a.confirmed);
    if (byConfirmed !== 0) return byConfirmed;
    const byPreference =
      popularityRank(a.festival.popularity, options.preferences.spot) -
      popularityRank(b.festival.popularity, options.preferences.spot);
    if (byPreference !== 0) return byPreference;
    const travelA = a.travelMinutes?.[1] ?? Number.POSITIVE_INFINITY;
    const travelB = b.travelMinutes?.[1] ?? Number.POSITIVE_INFINITY;
    if (travelA !== travelB) return travelA - travelB;
    return a.festival.id.localeCompare(b.festival.id);
  });

  const top = matches.slice(0, options.limit ?? MAX_CANDIDATES);
  const travelUnknown =
    maxTravel === null ? [] : top.filter((m) => m.travelMinutes === null).map((m) => m.festival.id);
  const travelUncertain = top.filter((m) => m.travelFit === "uncertain").map((m) => m.festival.id);
  return { ranges, matches: top, tooFar, travelUnknown, travelUncertain };
}

/** 上限に収まると分かっている祭りを先に、境目、分からない祭りの順 */
function fitRank(fit: TravelFit | null): number {
  return fit === "within" ? 0 : fit === "uncertain" ? 1 : fit === "over" ? 3 : 2;
}

/** 表示用の開催地（例：滋賀県鈴鳴町）。複数の市町村にまたがるときは「・」でつなぐ */
export function placeLabel(festival: Pick<Festival, "municipalities">): string {
  return festival.municipalities.map((m) => `${m.prefecture}${m.name}`).join("・");
}

/** 出典のうち、いちばん確度の強いもの */
function strongestSource(sources: readonly Source[]): Source {
  const best = strongestConfidence(sources);
  return (sources.find((s) => s.confidence === best) ?? sources[0]) as Source;
}

/** 候補カードの形にする */
export function toCandidate(match: FestivalMatch): FestivalCandidate {
  const { festival, occurrence } = match;
  return {
    festivalId: festival.id,
    name: festival.name.ja,
    date: match.date,
    start: occurrence.start,
    end: occurrence.end,
    venueName: festival.venue.name,
    place: placeLabel(festival),
    daysFromWish: match.daysFromWish,
    confidence: strongestConfidence(occurrence.sources) ?? "inferred",
    confirmed: match.confirmed,
    highlight: festival.highlights[0] as string,
    source: strongestSource(occurrence.sources),
  };
}
