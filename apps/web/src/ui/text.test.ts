import { fictionalSource } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { MESSAGES } from "../i18n";
import type { ChatEntry } from "../state/types";
import { shioriShareUrl } from "./links";
import { errorText, printedUrl } from "./text";

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
  it("接客サーバーにつないでいるときだけ作る", () => {
    expect(shioriShareUrl("server", "trip-1", "https://example.com")).toBe(
      "https://example.com/shiori/trip-1",
    );
    expect(shioriShareUrl("mock", "trip-1", "https://example.com")).toBeNull();
  });
});
