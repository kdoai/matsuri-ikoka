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

/** 会話の窓に出すセリフの長さの目安（文の数と文字数） */
export const SHORT_LINE_SENTENCES = 2;
export const SHORT_LINE_CHARS = 80;

/**
 * セリフを1〜2文に縮める。くわしい説明はカードとしおり、全文は会話の記録で読める。
 * 文の区切り（。！？!? と改行）で切り、それでも長ければ文字数で切って「…」を付ける。
 * 縮めなかったときは rest が null
 */
export function shortLine(text: string): { head: string; rest: string | null } {
  const trimmed = text.trim();
  const sentences = trimmed.match(/[^。！？!?\n]+[。！？!?]*[ 　]*|\n+/g) ?? [trimmed];
  let head = "";
  let count = 0;
  for (const sentence of sentences) {
    if (sentence.trim() === "") {
      if (head !== "") break;
      continue;
    }
    if (count >= SHORT_LINE_SENTENCES) break;
    head += sentence;
    count += 1;
  }
  head = head.trim();
  if (head.length > SHORT_LINE_CHARS) {
    head = `${head.slice(0, SHORT_LINE_CHARS).trimEnd()}…`;
  }
  return head === trimmed ? { head: trimmed, rest: null } : { head, rest: trimmed };
}
