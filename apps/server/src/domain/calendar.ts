import { type IsoDate, type LocalTime, WEEKDAYS, type Weekday } from "@matsuri-ikoka/schema";

// 日付（YYYY-MM-DD）と時刻（HH:MM）の計算。時差の影響を受けないよう、日付は UTC の暦として扱う。

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const JAPAN_OFFSET_MS = 9 * 60 * 60 * 1000;

function toUtcMs(date: IsoDate): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day);
}

function fromUtcMs(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return fromUtcMs(toUtcMs(date) + days * MS_PER_DAY);
}

/** from から to までの日数（to が後なら正） */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / MS_PER_DAY);
}

export function laterDate(a: IsoDate, b: IsoDate): IsoDate {
  return a >= b ? a : b;
}

export function earlierDate(a: IsoDate, b: IsoDate): IsoDate {
  return a <= b ? a : b;
}

/** 曜日（mon〜sun）。定休日の判定に使う */
export function weekdayOf(date: IsoDate): Weekday {
  // getUTCDay は日曜が 0。WEEKDAYS は月曜始まり
  const day = new Date(toUtcMs(date)).getUTCDay();
  return WEEKDAYS[(day + 6) % 7] as Weekday;
}

/** 日本の今日の日付 */
export function todayInJapan(now: Date = new Date()): IsoDate {
  return fromUtcMs(now.getTime() + JAPAN_OFFSET_MS);
}

/** 日本の今の日時（ISO 8601、+09:00） */
export function nowInJapan(now: Date = new Date()): string {
  const local = new Date(now.getTime() + JAPAN_OFFSET_MS).toISOString().slice(0, 19);
  return `${local}+09:00`;
}

/** 「8月16日」の形 */
export function formatMonthDay(date: IsoDate): string {
  const [, month, day] = date.split("-").map(Number);
  return `${month}月${day}日`;
}

const WEEKDAY_LABELS: Record<Weekday, string> = {
  mon: "月",
  tue: "火",
  wed: "水",
  thu: "木",
  fri: "金",
  sat: "土",
  sun: "日",
};

/** 「8月16日（日）」の形 */
export function formatMonthDayWithWeekday(date: IsoDate): string {
  return `${formatMonthDay(date)}（${WEEKDAY_LABELS[weekdayOf(date)]}）`;
}

/** HH:MM を0時からの分に */
export function toMinutes(time: LocalTime): number {
  const [hours, minutes] = time.split(":").map(Number) as [number, number];
  return hours * 60 + minutes;
}

/** 0時からの分を HH:MM に（24時を超えた分は翌日の時刻にする） */
export function fromMinutes(total: number): LocalTime {
  const minutes = ((total % 1440) + 1440) % 1440;
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}
