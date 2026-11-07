import { checkPublicWebUrl, comparableUrl } from "@matsuri-ikoka/agent-kit";
import {
  CONFIDENCE_LEVELS,
  type Confidence,
  type Festival,
  type IsoDate,
  type Itinerary,
  MAX_PATROL_PAGES_PER_TARGET,
  type Occurrence,
  type Source,
} from "@matsuri-ikoka/schema";
import type { FestivalStore } from "../data/festivalStore";
import type { ScheduleBaseline, WatchedTrip } from "./types";

// 頼まれた旅から、見回る対象を作る。同じ祭りと開催日は、いくつの旅で見張っていても1つにまとめる。
// 開催日は祭りのデータの開催回から取る。旅程の日付は利用者の予定で、公開の情報ではないので、
// 開催回に当たらない日は対象にしない（見回り係への依頼と控えに入れない）。

export interface PlannedPage {
  url: string;
  confidence: Confidence;
}

export interface WatchedItinerary {
  trip: WatchedTrip;
  itinerary: Itinerary;
}

export interface PatrolPlan {
  key: string;
  festivalId: string;
  festivalName: string;
  date: IsoDate;
  /** 祭りのデータの開催の日時 */
  baseline: ScheduleBaseline;
  pages: PlannedPage[];
  /** この対象を見張っている旅。見回り係には渡さない */
  trips: WatchedItinerary[];
}

export interface TargetPlanning {
  plans: PatrolPlan[];
  /** 旅程の祭りの予定のうち、開催回に当たらず対象にしなかった数 */
  unmatched: number;
}

/** 見回りの控えの文書の ID */
export function patrolKey(festivalId: string, date: IsoDate): string {
  return `${festivalId}_${date}`;
}

/** 読むページ：確度の高い順に、推定を除いて、上限まで。同じページは1つにする */
function patrolPages(sources: readonly Source[]): PlannedPage[] {
  const pages = new Map<string, PlannedPage>();
  const ranked = sources
    .filter((source) => source.confidence !== "inferred")
    .sort(
      (a, b) => CONFIDENCE_LEVELS.indexOf(a.confidence) - CONFIDENCE_LEVELS.indexOf(b.confidence),
    );
  for (const source of ranked) {
    const key = comparableUrl(source.url);
    if (key === null || pages.has(key) || !checkPublicWebUrl(source.url).ok) continue;
    pages.set(key, { url: source.url, confidence: source.confidence });
  }
  return [...pages.values()].slice(0, MAX_PATROL_PAGES_PER_TARGET);
}

function occurrenceOn(festival: Festival, date: IsoDate): Occurrence | undefined {
  return festival.occurrences.find(
    (occurrence) => occurrence.date <= date && date <= (occurrence.endDate ?? occurrence.date),
  );
}

/** 見回る対象を、開催の近い順に作る。掲載停止の祭りは祭りのデータにないので、対象にならない */
export function planTargets(
  watched: readonly WatchedItinerary[],
  festivals: FestivalStore,
  today: IsoDate,
): TargetPlanning {
  const plans = new Map<string, PatrolPlan>();
  let unmatched = 0;
  for (const entry of watched) {
    const { watch } = entry.trip;
    if (watch.status !== "active" || today >= watch.endsOn) continue;
    const seen = new Set<string>();
    for (const day of entry.itinerary.days) {
      for (const item of day.items) {
        if (item.type !== "festival" || item.festivalId === undefined) continue;
        const festival = festivals.get(item.festivalId);
        if (festival === undefined) continue;
        const occurrence = occurrenceOn(festival, day.date);
        if (occurrence === undefined) {
          unmatched += 1;
          continue;
        }
        const { date } = occurrence;
        if ((occurrence.endDate ?? date) < today) continue;
        const key = patrolKey(festival.id, date);
        if (seen.has(key)) continue;
        seen.add(key);
        const existing = plans.get(key);
        if (existing !== undefined) {
          existing.trips.push(entry);
          continue;
        }
        const pages = patrolPages([...occurrence.sources, ...festival.sources]);
        if (pages.length === 0) continue;
        plans.set(key, {
          key,
          festivalId: festival.id,
          festivalName: festival.name.ja.slice(0, 100),
          date,
          baseline: { date, start: occurrence.start, end: occurrence.end },
          pages,
          trips: [entry],
        });
      }
    }
  }
  return {
    plans: [...plans.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    unmatched,
  };
}
