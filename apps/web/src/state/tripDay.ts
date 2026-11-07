import type { Itinerary } from "@matsuri-ikoka/schema";

// 旅の当日に最初に見せるもの（次の予定・出発の時刻・帰りの最終）を、旅程と今の時刻だけから決める。
// 電波がなくても、手元の旅程があれば出せる。文章は作らず、旅程の値をそのまま使う。

type Item = Itinerary["days"][number]["items"][number];

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
 * 帰りの最終。known 時刻が分かる / unknown 調べて分からなかった（その日のうちに帰る日）/
 * none その日は泊まるので帰りの最終はない
 */
export type TripDayLastReturn =
  | { status: "known"; station: string; departBy: string }
  | { status: "unknown"; station: string | null }
  | { status: "none" };

export interface TripDayGlance {
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

/** 終わりが始まりより前の予定は日をまたぐので、終わりを翌日の時刻として比べる */
function endsAfter(item: Item, time: string): boolean {
  if (item.end < item.start) return true;
  return item.end > time;
}

/** 旅の日でなければ null。旅の日なら、今の時刻からあとの予定を見せる */
export function tripDayGlance(
  itinerary: Pick<Itinerary, "days">,
  clock: { date: string; time: string },
): TripDayGlance | null {
  const day = itinerary.days.find((entry) => entry.date === clock.date);
  if (day === undefined) return null;

  const upcoming = day.items.find((item) => endsAfter(item, clock.time));
  const next: TripDayItem | null =
    upcoming === undefined
      ? null
      : {
          id: upcoming.id,
          start: upcoming.start,
          end: upcoming.end,
          name: upcoming.name,
          now: upcoming.start <= clock.time,
        };

  const move = day.items.find((item) => item.type === "move" && item.start >= clock.time);
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
  if (day.stay !== null) {
    lastReturn = { status: "none" };
  } else if (day.lastReturn?.departBy !== null && day.lastReturn?.departBy !== undefined) {
    lastReturn = {
      status: "known",
      station: day.lastReturn.station,
      departBy: day.lastReturn.departBy,
    };
  } else {
    lastReturn = { status: "unknown", station: day.lastReturn?.station ?? null };
  }

  return { date: day.date, next, departure, lastReturn };
}
