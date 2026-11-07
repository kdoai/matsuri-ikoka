import {
  type IsoDate,
  type Itinerary,
  type LocalTime,
  lastReturnMinutes,
  type ReminderSlot,
} from "@matsuri-ikoka/schema";
import { addDays, fromMinutes, toMinutes } from "./calendar";

// 旅程の時刻に合わせて、ガイドが声をかける時刻を決める（docs/spec/guide.md の「旅程の時刻に合わせた声かけ」）。
// 時刻はすべて旅程からコードで決め、モデルに決めさせない。定期の起動は、来た分（dueGuideCalls）だけを確かめる。
// 旅程が変わったら、毎回いまの旅程から計算し直すので、まだ来ていない時刻は自然に作り直される。

/** 出発の前日の夕方に声をかける時刻 */
export const EVE_CALL_TIME: LocalTime = "18:00";
/** 朝の声かけは、最初の予定の90分前。早すぎず遅すぎない幅に収める */
const MORNING_LEAD_MINUTES = 90;
const MORNING_EARLIEST = toMinutes("05:00");
const MORNING_LATEST = toMinutes("08:00");
/** 会場へ向かう移動のさらに前に、支度の時間を見る */
const DEPART_PREP_MINUTES = 30;
/** 移動の目安がない祭りは、開始の60分前に声をかける */
const DEPART_FALLBACK_MINUTES = 60;
/** 帰りの最終の60分前に声をかける */
const LAST_RETURN_LEAD_MINUTES = 60;
/**
 * 声をかける時刻を過ぎてから、まだ声をかけてよい時間。
 * 定期の起動が遅れたり止まったりしても、古い声かけをあとからまとめて届けない
 */
export const MAX_CALL_DELAY_MS = 2 * 60 * 60 * 1000;

export interface GuideCall {
  slot: ReminderSlot;
  /** 声をかける予定の日（旅程の日付） */
  date: IsoDate;
  /** 声をかける時刻（日本時間） */
  at: LocalTime;
  /** 声をかける時刻（エポックからのミリ秒） */
  atMs: number;
  /** これを過ぎたら、声をかけても役に立たない時刻（ミリ秒） */
  untilMs: number;
  /** 知らせる予定の ID。なければ null */
  itemId: string | null;
  /**
   * 旅の中で声かけを1つに決める値。同じ旅で同じ値の声かけは1回だけ。
   * 会場へ向かう前と帰りの最終の前は、対象の時刻を含める（時刻が変わったら、もう一度声をかける）
   */
  key: string;
}

/** 日本時間の日付と時刻を、エポックからのミリ秒に */
export function japanTimeMs(date: IsoDate, time: LocalTime): number {
  return Date.parse(`${date}T${time}:00+09:00`);
}

function call(
  slot: ReminderSlot,
  date: IsoDate,
  atDate: IsoDate,
  atMinutes: number,
  untilMs: number,
  itemId: string | null,
  /** 声かけの対象の時刻。あれば key に入れ、時刻が変わったときだけもう一度声をかける */
  target?: LocalTime,
): GuideCall {
  const at = fromMinutes(atMinutes);
  return {
    slot,
    date,
    at,
    atMs: japanTimeMs(atDate, at),
    untilMs,
    itemId,
    key: target === undefined ? `${slot}:${date}` : `${slot}:${date}:${target}`,
  };
}

/** 旅程から、声をかける時刻をすべて決める。時刻の早い順 */
export function guideCallSchedule(itinerary: Pick<Itinerary, "days">): GuideCall[] {
  const calls: GuideCall[] = [];
  const first = itinerary.days[0];
  if (first === undefined) return calls;

  const firstItem = first.items[0];
  if (firstItem !== undefined) {
    // 前日の夕方。当日の朝の声かけまでに届かなければ、もう出さない
    calls.push(
      call(
        "eve",
        first.date,
        addDays(first.date, -1),
        toMinutes(EVE_CALL_TIME),
        japanTimeMs(first.date, fromMinutes(MORNING_EARLIEST)),
        firstItem.id,
      ),
    );
  }

  for (const day of itinerary.days) {
    const head = day.items[0];
    if (head !== undefined) {
      const start = toMinutes(head.start);
      const at = Math.min(MORNING_LATEST, Math.max(MORNING_EARLIEST, start - MORNING_LEAD_MINUTES));
      // 最初の予定がとても早い日は、朝の声かけが間に合わないので出さない
      if (at < start) {
        calls.push(
          call("morning", day.date, day.date, at, japanTimeMs(day.date, head.start), head.id),
        );
      }
    }

    const festival = day.items.find((item) => item.type === "festival");
    if (festival !== undefined) {
      const start = toMinutes(festival.start);
      const lead =
        festival.move === null
          ? DEPART_FALLBACK_MINUTES
          : festival.move.minutes[1] + DEPART_PREP_MINUTES;
      const at = start - lead;
      if (at >= 0) {
        calls.push(
          call(
            "depart",
            day.date,
            day.date,
            at,
            japanTimeMs(day.date, festival.start),
            festival.id,
            festival.start,
          ),
        );
      }
    }

    const departBy = day.lastReturn?.departBy ?? null;
    if (departBy !== null) {
      const minutes = toMinutes(departBy);
      // 深夜0時を過ぎた最終は、その日の翌日の時刻（決まりは schema の lastReturnMinutes）
      const lastDate = lastReturnMinutes(departBy) >= 1440 ? addDays(day.date, 1) : day.date;
      const lastMs = japanTimeMs(lastDate, departBy);
      const atMs = lastMs - LAST_RETURN_LEAD_MINUTES * 60 * 1000;
      calls.push({
        slot: "last_return",
        date: day.date,
        at: fromMinutes(minutes - LAST_RETURN_LEAD_MINUTES),
        atMs,
        untilMs: lastMs,
        itemId: null,
        key: `last_return:${day.date}:${departBy}`,
      });
    }
  }
  return calls.sort((a, b) => a.atMs - b.atMs);
}

/** これを過ぎたら、その声かけはもう出さない時刻 */
function closesAt(item: GuideCall): number {
  return Math.min(item.untilMs, item.atMs + MAX_CALL_DELAY_MS);
}

/**
 * 出せる時間を過ぎた声かけのうち、過ぎてから lookbackMs の間のもの。
 * 定期の起動の間隔が空きすぎて出せなかった声かけを、ログで見つけるために使う
 */
export function closedGuideCalls(
  itinerary: Pick<Itinerary, "days">,
  nowMs: number,
  lookbackMs: number,
): GuideCall[] {
  return guideCallSchedule(itinerary).filter((item) => {
    const closed = closesAt(item);
    return item.atMs < closed && closed <= nowMs && nowMs < closed + lookbackMs;
  });
}

/**
 * いま声をかける時刻が来ているもの。時刻を過ぎていて、役に立つ時刻の前で、遅れすぎていないものだけ。
 * 2回確かめても同じ結果になるので、重ならないようにするのは呼ぶ側の実行済みの記録で行う
 */
export function dueGuideCalls(itinerary: Pick<Itinerary, "days">, nowMs: number): GuideCall[] {
  return guideCallSchedule(itinerary).filter(
    (item) => item.atMs <= nowMs && nowMs < closesAt(item),
  );
}
