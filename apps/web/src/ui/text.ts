import type { GuideToolName } from "@matsuri-ikoka/schema";
import type { Messages } from "../i18n";
import type { GuideErrorCode } from "../state/guide";
import type { ChatEntry, Locale, StaffCue } from "../state/types";

// 画面に出す文を、ストアの値と辞書から組み立てる。

/**
 * エラーの一文。サーバーの一文は日本語なので、日本語の画面でだけ出す。
 * 英語の画面や、サーバーの一文がないときは、種類（code）から辞書の文言を出す。
 * 送り直せる bad_request は、前の返事を作っている間に送ったときだけなので、そう言う
 */
export function errorText(
  entry: Pick<Extract<ChatEntry, { kind: "error" }>, "code" | "message"> & {
    retryable?: boolean;
  },
  locale: Locale,
  t: Messages,
): string {
  if (locale === "ja" && entry.message !== null) return entry.message;
  return entry.code === "bad_request" && entry.retryable === true
    ? t.chat.busy
    : t.chat.errors[entry.code];
}

/** スタッフの吹き出し。辞書に言い直す文があればそれを、なければサーバーが決まった型で作った文を出す */
export function staffLineText(text: string, cue: StaffCue | null, t: Messages): string {
  return (cue === null ? null : t.lines.bubble(cue)) ?? text;
}

/**
 * 店内のようすの窓に出す、くわしい文。辞書に文があれば辞書の文（くわしい文がなければ辞書の吹き出し）を、
 * なければサーバーのくわしい文か吹き出しを出す。吹き出しがなければ null
 */
export function staffDetailText(
  staff: { bubble: string | null; detail: string | null; cue: StaffCue | null },
  t: Messages,
): string | null {
  if (staff.bubble === null) return null;
  if (staff.cue !== null) {
    const own = t.lines.detail(staff.cue) ?? t.lines.bubble(staff.cue);
    if (own !== null) return own;
  }
  return staff.detail ?? staff.bubble;
}

/** ガイドの調べものの吹き出し。辞書に文があればそれを、なければサーバーの文を出す */
export function guideToolText(
  entry: { tool: GuideToolName; bubble: string; running?: boolean; ok?: boolean },
  t: Messages,
): string {
  const status = entry.running !== false ? "running" : entry.ok === false ? "failed" : "ok";
  return t.lines.guideTool(entry.tool, status) ?? entry.bubble;
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

/** ガイドの相談のエラーの一文。相談が切れたときは、次にできることを書いた文を出す */
export function guideErrorText(
  entry: { code: GuideErrorCode; message: string | null; retryable?: boolean },
  locale: Locale,
  t: Messages,
): string {
  return entry.code === "guide_gone"
    ? t.street.gone
    : errorText(
        {
          code: entry.code,
          message: entry.message,
          ...(entry.retryable === undefined ? {} : { retryable: entry.retryable }),
        },
        locale,
        t,
      );
}
