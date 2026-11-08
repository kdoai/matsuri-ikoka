import type { IsoDate } from "@matsuri-ikoka/schema";
import { addDays, todayInJapan } from "./calendar";

// 残さなかった旅程・しおりの共有・旅程を持つ相談を、いつまで読めるようにするか（docs/spec/account.md の「残すもの」）。
// 先の祭りの旅でも、旅の当日にしおりを開けるよう、「最後の保存から30日」と「旅の最終日の数日後」の遅い方にする。

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const JAPAN_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 最後の保存から読める日数 */
export const RETENTION_AFTER_SAVE_DAYS = 30;
/** 旅の最終日のあと、読める日数（帰ってから見返せるように） */
export const RETENTION_AFTER_TRIP_DAYS = 3;
/** 旅程のない相談の途中の状態を残す時間（最後に使ってから） */
export const SESSION_WITHOUT_TRIP_MS = 6 * 60 * 60 * 1000;

/** 日本の、その日の終わり（翌日の 0:00）の時刻（ミリ秒） */
function endOfJapanDay(date: IsoDate): number {
  const [year, month, day] = addDays(date, 1).split("-").map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day) - JAPAN_OFFSET_MS;
}

/**
 * 残さなかった旅程・共有の期限（ミリ秒）。savedAt は最後の保存（共有なら作った）時刻、
 * lastDate は旅の最終日（分からなければ null）。最終日の数日後の日本の1日の終わりまでと、保存から30日の遅い方
 */
export function retentionUntil(savedAt: number, lastDate: IsoDate | null): number {
  const afterSave = savedAt + RETENTION_AFTER_SAVE_DAYS * MS_PER_DAY;
  if (lastDate === null || !/^\d{4}-\d{2}-\d{2}$/.test(lastDate)) return afterSave;
  return Math.max(afterSave, endOfJapanDay(addDays(lastDate, RETENTION_AFTER_TRIP_DAYS)));
}

/**
 * 相談の途中の状態の期限（ミリ秒）。旅程を持つ相談は旅程と同じ期限まで残し、
 * 翌日以降もその相談から旅を残したり、続きを相談したりできるようにする
 */
export function sessionRetentionUntil(
  savedAt: number,
  trip: { lastDate: IsoDate | null } | null,
): number {
  if (trip === null) return savedAt + SESSION_WITHOUT_TRIP_MS;
  return retentionUntil(savedAt, trip.lastDate);
}

/** 期限（ミリ秒）の時点で、まだ開ける最後の日（日本の日付）。画面に「〜まで開けます」と出すのに使う */
export function lastOpenDay(expiresAt: number): IsoDate {
  return todayInJapan(new Date(expiresAt - 1));
}
