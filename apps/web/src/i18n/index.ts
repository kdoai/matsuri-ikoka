import type { Locale } from "../state/types";
import { en } from "./en";
import { ja, type Messages } from "./ja";

export type { Messages };

export const MESSAGES: Record<Locale, Messages> = { ja, en };

export const LOCALES: readonly Locale[] = ["ja", "en"];

export function otherLocale(locale: Locale): Locale {
  return locale === "ja" ? "en" : "ja";
}

/** ブラウザの言語から、最初に出す言語を決める。日本語以外は英語 */
export function detectLocale(languages: readonly string[]): Locale {
  const first = languages[0]?.toLowerCase() ?? "ja";
  return first.startsWith("ja") ? "ja" : "en";
}

// 日付は日本の暦で読む（祭りの日付は現地の日付）
const TIME_ZONE = "Asia/Tokyo";

function toDate(isoDate: string): Date {
  return new Date(`${isoDate}T12:00:00+09:00`);
}

/** 日付（YYYY-MM-DD）を、言語に合わせて曜日つきで書く */
export function formatDate(isoDate: string, locale: Locale): string {
  const date = toDate(isoDate);
  if (Number.isNaN(date.getTime())) {
    return isoDate;
  }
  return new Intl.DateTimeFormat(locale === "ja" ? "ja-JP" : "en-US", {
    timeZone: TIME_ZONE,
    month: locale === "ja" ? "numeric" : "short",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

/** 日時（ISO 8601）を、言語に合わせて書く */
export function formatDateTime(isoDateTime: string, locale: Locale): string {
  const date = new Date(isoDateTime);
  if (Number.isNaN(date.getTime())) {
    return isoDateTime;
  }
  return new Intl.DateTimeFormat(locale === "ja" ? "ja-JP" : "en-US", {
    timeZone: TIME_ZONE,
    month: locale === "ja" ? "numeric" : "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
