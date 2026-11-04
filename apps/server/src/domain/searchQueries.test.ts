import { describe, expect, it } from "vitest";
import {
  bySourcePriority,
  MAX_VERIFICATION_QUERIES,
  nameVariants,
  reiwaYear,
  sourcePriority,
  verificationQueries,
} from "./searchQueries";
import { testFestival } from "./testFestivals";

describe("nameVariants", () => {
  it("括弧の中の読みを外し、「祭」と「祭り」の書き方を広げる", () => {
    expect(nameVariants("鈴鳴灯籠祭り（すずなりとうろうまつり）")).toEqual([
      "鈴鳴灯籠祭り（すずなりとうろうまつり）",
      "鈴鳴灯籠祭り",
      "鈴鳴灯籠祭",
    ]);
    expect(nameVariants("こがね祭")).toEqual(["こがね祭", "こがね祭り"]);
  });
});

describe("verificationQueries", () => {
  it("公式のサイトの中・年・令和の年・地域の名前・広報で、上限までの言葉に広げる", () => {
    const festival = testFestival({
      id: "suzunari",
      edit: (f) => {
        f.name = { ja: "鈴鳴灯籠祭り" };
      },
    });
    const queries = verificationQueries(festival, "2026-08-16");
    expect(queries[0]).toBe("site:example.com 鈴鳴灯籠祭り 2026");
    expect(queries).toContain("鈴鳴灯籠祭り 2026 日程");
    expect(queries.some((q) => q.includes("令和8年"))).toBe(true);
    expect(queries.length).toBeLessThanOrEqual(MAX_VERIFICATION_QUERIES);
    expect(new Set(queries).size).toBe(queries.length);
  });

  it("令和の年を数える", () => {
    expect(reiwaYear(2026)).toBe(8);
    expect(reiwaYear(2018)).toBeNull();
  });
});

describe("sourcePriority", () => {
  const official = new Set(["example.com", "kanko.example.org"]);

  it("主催者・自治体 → 観光協会 → 広報誌の PDF → メディア → ブログ・SNS の順", () => {
    expect(sourcePriority("https://example.com/news", official)).toBe(1);
    expect(sourcePriority("https://www.city.example.lg.jp/a", official)).toBe(1);
    expect(sourcePriority("https://kanko.example.org/event", official)).toBe(2);
    expect(sourcePriority("https://example.net/kouhou/2026-08.pdf", official)).toBe(3);
    expect(sourcePriority("https://news.example.net/a", official)).toBe(4);
    expect(sourcePriority("https://ameblo.jp/someone/entry", official)).toBe(5);
    expect(sourcePriority("not a url", official)).toBe(5);
  });

  it("優先順位の順に並べ、同じ順位の中は元の順を保つ", () => {
    const sorted = bySourcePriority(
      [
        { url: "https://news.example.net/a" },
        { url: "https://kanko.example.org/event" },
        { url: "https://example.com/news" },
        { url: "https://news.example.net/b" },
      ],
      official,
    );
    expect(sorted.map((s) => s.url)).toEqual([
      "https://example.com/news",
      "https://kanko.example.org/event",
      "https://news.example.net/a",
      "https://news.example.net/b",
    ]);
  });
});
