import { describe, expect, it } from "vitest";
import { comparableUrl, createWebActivityLog, ungroundedSources } from "./grounding";

describe("createWebActivityLog", () => {
  it("検索した語と、読みに行った URL を控える", () => {
    const log = createWebActivityLog();
    log.record("WebSearch", { query: " 鈴鳴灯籠まつり 2026 " });
    log.record("WebFetch", { url: "https://example.com/suzunari/2026", prompt: "開催日" });
    log.record("WebFetch", { url: "https://example.com/suzunari/2026", prompt: "雨天" });

    expect(log.searches).toEqual(["鈴鳴灯籠まつり 2026"]);
    expect(log.fetchedUrls).toEqual(["https://example.com/suzunari/2026"]);
  });

  it("Web 以外のツールや、形の違う入力は無視する", () => {
    const log = createWebActivityLog();
    log.record("mcp__matsuri__search_festivals", { query: "x" });
    log.record("WebFetch", { href: "https://example.com" });
    log.record("WebSearch", null);

    expect(log.searches).toEqual([]);
    expect(log.fetchedUrls).toEqual([]);
  });

  it("検索だけして本文を読んでいないことが分かる", () => {
    const log = createWebActivityLog();
    expect(log.searchedWithoutReading()).toBe(false);
    log.record("WebSearch", { query: "鈴鳴灯籠まつり" });
    expect(log.searchedWithoutReading()).toBe(true);
    log.record("WebFetch", { url: "https://example.com/suzunari/2026" });
    expect(log.searchedWithoutReading()).toBe(false);
  });
});

describe("comparableUrl", () => {
  it("スキーム・フラグメント・末尾のスラッシュの違いを同じとみなす", () => {
    expect(comparableUrl("https://Example.com/a/#top")).toBe(comparableUrl("http://example.com/a"));
  });

  it("クエリが違えば別のページとみなす", () => {
    expect(comparableUrl("https://example.com/a?year=2026")).not.toBe(
      comparableUrl("https://example.com/a?year=2025"),
    );
  });

  it("URL として読めなければ null", () => {
    expect(comparableUrl("not a url")).toBeNull();
  });
});

describe("ungroundedSources", () => {
  const fetched = ["https://example.com/suzunari/2026", "https://example.com/suzunari/access/"];

  it("読みに行ったページの出典だけなら、空を返す", () => {
    const sources = [
      { url: "https://example.com/suzunari/2026#date" },
      { url: "http://example.com/suzunari/access" },
    ];
    expect(ungroundedSources(sources, fetched)).toEqual([]);
  });

  it("読んでいないページの出典を返す", () => {
    const sources = [
      { url: "https://example.com/suzunari/2026" },
      { url: "https://example.com/suzunari/history" },
      { url: "壊れた URL" },
    ];
    expect(ungroundedSources(sources, fetched)).toEqual([
      "https://example.com/suzunari/history",
      "壊れた URL",
    ]);
  });
});
