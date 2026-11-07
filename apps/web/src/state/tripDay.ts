import {
  dayTimeline,
  type Itinerary,
  LAST_RETURN_AFTER_MIDNIGHT_UNTIL_MINUTES,
  lastReturnMinutes,
  localTimeMinutes,
} from "@matsuri-ikoka/schema";
import { addDays } from "./consult";

// 旅の当日に最初に見せるもの（次の予定・出発の時刻・帰りの最終）を、旅程と今の時刻だけから決める。
// 電波がなくても、手元の旅程があれば出せる。文章は作らず、旅程の値をそのまま使う。
// 0時を過ぎた予定と最終は、サーバーの旅程の点検・声かけと同じ決まり（schema の dayTimeline・lastReturnMinutes）で、
// 旅の日の続きとして扱う。

type Day = Itinerary["days"][number];

export interface TripDayItem {
  id: string;
  start: string;
  end: string;
  name: string;
  /** 今まさにこの予定の時間の中にいる */
  now: boolean;
}

export interface TripDayDeparture {
  itemId: string;
  /** 出発の時刻 */
  at: string;
  from: string | null;
  to: string | null;
  /** 最初に乗る路線（分かるときだけ） */
  line: string | null;
}

/**
 * 帰りの最終。known 時刻が分かる / passed 時刻を過ぎた / unknown 調べて分からなかった（その日のうちに帰る日）/
 * none その日は泊まるので帰りの最終はない
 */
export type TripDayLastReturn =
  | { status: "known"; station: string; departBy: string }
  | { status: "passed"; station: string; departBy: string }
  | { status: "unknown"; station: string | null }
  | { status: "none" };

export interface TripDayGlance {
  /** 札に出す旅の日（0時を過ぎても、前の日の続きなら前の日） */
  date: string;
  /** その日の予定がもう残っていなければ null */
  next: TripDayItem | null;
  /** これから乗る移動がなければ null */
  departure: TripDayDeparture | null;
  lastReturn: TripDayLastReturn;
}

/** 日本の今の日付と時刻（YYYY-MM-DD と HH:MM） */
export function japanClock(now: Date = new Date()): { date: string; time: string } {
  const local = new Date(now.getTime() + 9 * 3_600_000).toISOString();
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
}

/** その旅の日の札。now は旅の日の0時からの分（前の日の続きなら 1440 を超える） */
function glanceOf(day: Day, now: number): TripDayGlance {
  const timeline = dayTimeline(day.items);
  const upcoming = timeline.find((timed) => timed.end > now);
  const next: TripDayItem | null =
    upcoming === undefined
      ? null
      : {
          id: upcoming.item.id,
          start: upcoming.item.start,
          end: upcoming.item.end,
          name: upcoming.item.name,
          now: upcoming.start <= now,
        };

  const ride = timeline.find((timed) => timed.item.type === "move" && timed.start >= now);
  const move = ride?.item;
  const departure: TripDayDeparture | null =
    move === undefined
      ? null
      : {
          itemId: move.id,
          at: move.start,
          from: move.move?.from ?? move.move?.legs?.[0]?.from ?? null,
          to: move.move?.to ?? move.move?.legs?.at(-1)?.to ?? null,
          line: move.move?.legs?.find((leg) => leg.line !== null)?.line ?? null,
        };

  let lastReturn: TripDayLastReturn;
  const departBy = day.lastReturn?.departBy ?? null;
  if (day.stay !== null) {
    lastReturn = { status: "none" };
  } else if (day.lastReturn !== undefined && day.lastReturn !== null && departBy !== null) {
    lastReturn = {
      status: lastReturnMinutes(departBy) <= now ? "passed" : "known",
      station: day.lastReturn.station,
      departBy,
    };
  } else {
    lastReturn = { status: "unknown", station: day.lastReturn?.station ?? null };
  }

  return { date: day.date, next, departure, lastReturn };
}

/** 旅の日でなければ null。旅の日なら、今の時刻からあとの予定を見せる */
export function tripDayGlance(
  itinerary: Pick<Itinerary, "days">,
  clock: { date: string; time: string },
): TripDayGlance | null {
  const minutes = localTimeMinutes(clock.time);
  const today = itinerary.days.find((day) => day.date === clock.date);
  // 0:00〜4:00 は、前の日の 24:00 以降として前の日を先に見る（帰りが0時を過ぎる日）
  if (minutes < LAST_RETURN_AFTER_MIDNIGHT_UNTIL_MINUTES) {
    const previous = itinerary.days.find((day) => day.date === addDays(clock.date, -1));
    if (previous !== undefined) {
      const carried = glanceOf(previous, minutes + 1440);
      const pending = carried.next !== null || carried.departure !== null;
      // 予定が残っているか、その日のうちに帰る日の続き（次の旅の日がない）なら、前の日を見せる
      if (pending || (today === undefined && carried.lastReturn.status !== "none")) return carried;
    }
  }
  return today === undefined ? null : glanceOf(today, minutes);
}
