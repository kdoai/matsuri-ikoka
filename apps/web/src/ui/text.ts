import type { Messages } from "../i18n";
import type { ChatEntry, Locale } from "../state/types";

// 画面に出す文を、ストアの値と辞書から組み立てる。

/**
 * エラーの一文。サーバーの一文は日本語なので、日本語の画面でだけ出す。
 * 英語の画面や、サーバーの一文がないときは辞書の文言を出す。
 */
export function errorText(
  entry: Extract<ChatEntry, { kind: "error" }>,
  locale: Locale,
  t: Messages,
): string {
  return locale === "ja" && entry.message !== null ? entry.message : t.chat.errors[entry.code];
}

/** 印刷したときに URL を読めるよう、タイトルのある出典にだけ URL を添える */
export function printedUrl(source: { url: string; title?: string }): string | null {
  return source.title === undefined ? null : source.url;
}
