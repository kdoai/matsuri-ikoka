import { fictionalSource } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { MESSAGES } from "../i18n";
import type { ChatEntry } from "../state/types";
import { shioriShareUrl } from "./links";
import { errorText, printedUrl, shortLine } from "./text";

const fromServer: Extract<ChatEntry, { kind: "error" }> = {
  kind: "error",
  id: "e-1",
  code: "rate_limited",
  message: "今日の相談の受付は終わりました。",
  retryable: false,
  resolved: false,
};

describe("エラーの一文", () => {
  it("日本語の画面では、サーバーの一文を出す", () => {
    expect(errorText(fromServer, "ja", MESSAGES.ja)).toBe("今日の相談の受付は終わりました。");
  });

  it("英語の画面では、サーバーの日本語ではなく辞書の文言を出す", () => {
    expect(errorText(fromServer, "en", MESSAGES.en)).toBe(MESSAGES.en.chat.errors.rate_limited);
  });

  it("サーバーの一文がなければ、辞書の文言を出す", () => {
    expect(errorText({ ...fromServer, message: null }, "ja", MESSAGES.ja)).toBe(
      MESSAGES.ja.chat.errors.rate_limited,
    );
  });
});

describe("印刷したときの出典", () => {
  it("タイトルのある出典にだけ、URL を文字で添える", () => {
    const source = fictionalSource("2026");
    expect(printedUrl(source)).toBeNull();
    expect(printedUrl({ ...source, title: "開催のお知らせ" })).toBe(source.url);
  });
});

describe("しおりの共有の URL", () => {
  it("接客サーバーのしおりの経路を指す", () => {
    expect(shioriShareUrl("trip 1", "https://example.com")).toBe(
      "https://example.com/shiori/trip%201",
    );
  });
});

describe("shortLine", () => {
  it("短いセリフはそのまま出す", () => {
    expect(shortLine("いらっしゃいませ！ 旅の相談ですね。")).toEqual({
      head: "いらっしゃいませ！ 旅の相談ですね。",
      rest: null,
    });
  });

  it("3文以上は2文に縮め、全文も残す", () => {
    const text = "候補を3つ見つけました。どれも川沿いの祭りです。会場までは電車で1時間ほどです。";
    expect(shortLine(text)).toEqual({
      head: "候補を3つ見つけました。どれも川沿いの祭りです。",
      rest: text,
    });
  });

  it("改行の段落で切る", () => {
    expect(shortLine("旅程を組みました！\n\n1. 会場へ向かう\n2. 屋台を回る").head).toBe(
      "旅程を組みました！",
    );
  });

  it("1文が長すぎるときは文字数で切る", () => {
    const line = shortLine("あ".repeat(120));
    expect(line.head).toBe(`${"あ".repeat(80)}…`);
    expect(line.rest).toBe("あ".repeat(120));
  });
});
