import type {
  IsoDate,
  LocalTime,
  NearbySpot,
  OpeningHours,
  Preferences,
} from "@matsuri-ikoka/schema";
import { toMinutes, weekdayOf } from "./calendar";
import { popularityRank, preferenceEffects } from "./preferences";

/** 予定に入れられる時間帯 */
export interface TimeWindow {
  from: LocalTime;
  to: LocalTime;
}

/** 寄り道として入れるのに、最低限ほしい滞在の時間（分） */
export const MIN_VISIT_MINUTES = 30;

export type NearbyExclusionReason = "closed_day" | "outside_hours" | "shop_meal_not_wanted";

export interface NearbySelection {
  spots: NearbySpot[];
  excluded: { spotId: string; name: string; reason: NearbyExclusionReason }[];
}

/** 営業時間（閉店が開店より前なら日をまたぐ）を [開店, 閉店, 最終入場] の分に */
function hoursInMinutes(hours: OpeningHours) {
  const open = toMinutes(hours.open);
  let close = toMinutes(hours.close);
  if (close <= open) close += 24 * 60;
  let lastEntry = hours.lastEntry === undefined ? close : toMinutes(hours.lastEntry);
  if (lastEntry < open) lastEntry += 24 * 60;
  return { open, close, lastEntry };
}

/** 時間帯の中で、営業時間内に最低限の滞在ができるか。営業時間が分からなければ判断しない */
export function fitsOpeningHours(hours: OpeningHours | null, window: TimeWindow): boolean {
  if (hours === null) return true;
  const { open, close, lastEntry } = hoursInMinutes(hours);
  const from = toMinutes(window.from);
  let to = toMinutes(window.to);
  if (to <= from) to += 24 * 60;
  const start = Math.max(open, from);
  const end = Math.min(close, to);
  return start <= lastEntry && end - start >= MIN_VISIT_MINUTES;
}

/** 定休日か。定休日が分からなければ休みとは判断しない */
export function isClosedOn(spot: Pick<NearbySpot, "closedDays">, date: IsoDate): boolean {
  return spot.closedDays?.includes(weekdayOf(date)) ?? false;
}

/**
 * 祭りの前後に寄れる場所を選ぶ。
 * 当日が休業の場所、時間帯に営業時間が合わない場所、屋台で十分なときの店を除き、こだわりに合う順に並べる。
 */
export function selectNearbySpots(
  spots: readonly NearbySpot[],
  options: { date: IsoDate; window?: TimeWindow; preferences: Preferences },
): NearbySelection {
  const { date, window, preferences } = options;
  const effects = preferenceEffects(preferences);
  const selected: NearbySpot[] = [];
  const excluded: NearbySelection["excluded"] = [];

  for (const spot of spots) {
    let reason: NearbyExclusionReason | null = null;
    if (isClosedOn(spot, date)) {
      reason = "closed_day";
    } else if (window !== undefined && !fitsOpeningHours(spot.hours, window)) {
      reason = "outside_hours";
    } else if (spot.kind === "food" && !effects.includeShopMeals) {
      reason = "shop_meal_not_wanted";
    }
    if (reason === null) {
      selected.push(spot);
    } else {
      excluded.push({ spotId: spot.id, name: spot.name, reason });
    }
  }

  const tagScore = (spot: NearbySpot) =>
    spot.tags.filter((tag) => effects.preferTags.includes(tag)).length;
  const walk = (spot: NearbySpot) => spot.walkMinutesFromVenue?.[1] ?? Number.POSITIVE_INFINITY;

  selected.sort((a, b) => {
    if (effects.maxWalkMinutes !== null && walk(a) !== walk(b)) return walk(a) - walk(b);
    const byTags = tagScore(b) - tagScore(a);
    if (byTags !== 0) return byTags;
    const byPopularity =
      popularityRank(a.popularity, preferences.spot) -
      popularityRank(b.popularity, preferences.spot);
    if (byPopularity !== 0) return byPopularity;
    return walk(a) - walk(b);
  });

  return { spots: selected, excluded };
}
