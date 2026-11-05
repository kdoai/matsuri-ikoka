import { describe, expect, it } from "vitest";
import { testFestival } from "./testFestivals";
import {
  DATA_CONFIRMED_NOTE,
  DATA_UNOFFICIAL_NOTE,
  dataConfirmation,
  decideVerification,
  officialHosts,
  statesYear,
  UNOFFICIAL_NOTE,
  YEAR_NOT_STATED_NOTE,
  yearStatedOnPage,
} from "./verification";

// 架空の祭り。公式の出典は example.com にある
const festival = testFestival({ id: "suzunari-toro" });
const today = "2026-08-03";

describe("decideVerification", () => {
  it("公式のホストの出典があれば、予定どおりと認め、確度を official にする", () => {
    const decision = decideVerification(
      festival,
      {
        result: "as_planned",
        sources: [{ url: "https://example.com/suzunari/2026", title: "開催のお知らせ" }],
        yearStated: true,
      },
      today,
    );

    expect(decision).toEqual({
      result: "as_planned",
      sources: [
        {
          url: "https://example.com/suzunari/2026",
          title: "開催のお知らせ",
          checkedAt: today,
          confidence: "official",
        },
      ],
    });
  });

  it("公式の出典でも、今年の開催と書かれていなければ予定どおりと認めず、要事前確認にする", () => {
    const report = {
      result: "as_planned" as const,
      sources: [{ url: "https://example.com/suzunari/" }],
      note: "例年8月16日に開催",
    };
    const notStated = decideVerification(festival, { ...report, yearStated: false }, today);
    const unknown = decideVerification(festival, report, today);

    for (const decision of [notStated, unknown]) {
      expect(decision.result).toBe("needs_check");
      expect(decision.note).toBe(YEAR_NOT_STATED_NOTE);
      expect(decision.sources[0]?.confidence).toBe("official");
    }
  });

  it("公式でない出典に今年の開催が書かれていれば、要事前確認にする", () => {
    const stated = decideVerification(
      festival,
      { result: "as_planned", sources: [{ url: "https://example.net/news" }], yearStated: true },
      today,
    );
    expect(stated).toMatchObject({ result: "needs_check", note: UNOFFICIAL_NOTE });
    expect(stated.sources[0]?.confidence).toBe("single");
  });

  it("自治体のサイトは、データになくても公式の出典として扱う", () => {
    const decision = decideVerification(
      festival,
      {
        result: "as_planned",
        sources: [{ url: "https://www.town.example.lg.jp/event" }],
        yearStated: true,
      },
      today,
    );
    expect(decision.result).toBe("as_planned");
  });

  it("公式でない出典1つだけで、年も書かれていなければ確認できずにする", () => {
    const decision = decideVerification(
      festival,
      { result: "as_planned", sources: [{ url: "https://example.net/blog" }] },
      today,
    );

    expect(decision.result).toBe("not_found");
    expect(decision.sources[0]?.confidence).toBe("single");
  });

  it("公式でないホストがいくつ一致しても、予定どおりとは認めない", () => {
    const decision = decideVerification(
      festival,
      {
        result: "as_planned",
        sources: [
          { url: "https://example.net/a" },
          { url: "https://example.org/b" },
          { url: "https://blog.example.net/c" },
        ],
      },
      today,
    );

    expect(decision.result).toBe("not_found");
    expect(decision.sources.every((s) => s.confidence === "single")).toBe(true);
  });

  it("http(s) でない URL と重複は捨てる", () => {
    const decision = decideVerification(
      festival,
      {
        result: "as_planned",
        sources: [
          { url: "javascript:alert(1)" },
          { url: "https://example.com/suzunari/2026" },
          { url: "https://example.com/suzunari/2026" },
        ],
      },
      today,
    );

    expect(decision.sources).toHaveLength(1);
  });

  it("変更・中止は出典があるときだけ認める", () => {
    const withSource = decideVerification(
      festival,
      {
        result: "cancelled",
        sources: [{ url: "https://example.com/suzunari/news" }],
        note: "荒天のため中止",
      },
      today,
    );
    const withoutSource = decideVerification(festival, { result: "changed", sources: [] }, today);

    expect(withSource).toMatchObject({ result: "cancelled", note: "荒天のため中止" });
    expect(withoutSource.result).toBe("not_found");
  });
});

describe("officialHosts", () => {
  it("公式の確度の出典のホストだけを集める", () => {
    expect([...officialHosts(festival)]).toEqual(["example.com"]);
  });
});

describe("statesYear", () => {
  it.each([
    "2026年8月16日（日）",
    "２０２６年８月１６日",
    "2026/8/16",
    "令和8年8月16日",
    "令和 8 年",
    "令和八年八月十六日",
  ])("「%s」には2026年が書かれている", (text) => {
    expect(statesYear(text, 2026)).toBe(true);
  });

  it.each([
    "毎年8月16日",
    "例年8月中旬",
    "8月16日（日）",
    "2025年8月16日",
    "26年8月16日",
    "12026年",
    "令和18年",
  ])("「%s」には2026年が書かれていない", (text) => {
    expect(statesYear(text, 2026)).toBe(false);
  });

  it("令和元年と、十のつく令和の年を読む", () => {
    expect(statesYear("令和元年5月", 2019)).toBe(true);
    expect(statesYear("令和十一年", 2029)).toBe(true);
    expect(statesYear("令和二十年", 2038)).toBe(true);
  });
});

describe("yearStatedOnPage", () => {
  const page = "鈴鳴灯籠まつり　２０２６年８月１６日（日）18時30分から。雨天決行。";

  it("写した文が読んだページにあり、年が書かれていれば true（全角と半角・空白の違いはならす）", () => {
    expect(
      yearStatedOnPage({ dateText: "2026年8月16日 （日）", pages: [page], date: "2026-08-16" }),
    ).toBe(true);
  });

  it("写した文が読んだページにないなら、年があっても false", () => {
    expect(
      yearStatedOnPage({
        dateText: "2026年8月16日",
        pages: ["毎年8月16日に開かれます"],
        date: "2026-08-16",
      }),
    ).toBe(false);
  });

  it("確かめる日と違う年の文なら false", () => {
    expect(yearStatedOnPage({ dateText: "2026年8月16日", pages: [page], date: "2027-08-16" })).toBe(
      false,
    );
  });

  it("文がない・空なら false", () => {
    expect(yearStatedOnPage({ dateText: undefined, pages: [page], date: "2026-08-16" })).toBe(
      false,
    );
    expect(yearStatedOnPage({ dateText: " ", pages: [page], date: "2026-08-16" })).toBe(false);
  });
});

describe("祭りのデータの公式の出典で確かめる（dataConfirmation）", () => {
  // 開催回の公式の出典を、今日の5日前に確かめた架空の祭り
  const recent = testFestival({
    id: "kogane-matsuri",
    edit: (f) => {
      for (const o of f.occurrences) {
        o.sources = [{ ...o.sources[0]!, checkedAt: "2026-07-29", confidence: "official" }];
      }
    },
  });

  it("発表済みで、最近確かめた公式の出典があれば、その出典を返す", () => {
    expect(dataConfirmation(recent, "2026-08-16", today)).toHaveLength(1);
  });

  it("出典が古いとき・見込みのとき・その日の開催回がないときは返さない", () => {
    expect(dataConfirmation(festival, "2026-08-16", today)).toEqual([]);
    const expected = testFestival({ id: "kogane-yotei", status: "expected" });
    expect(dataConfirmation(expected, "2026-08-16", today)).toEqual([]);
    expect(dataConfirmation(recent, "2026-09-01", today)).toEqual([]);
  });

  it("Web で確認できなくても、データの公式の出典で確かめてあれば予定どおりにする", () => {
    const decision = decideVerification(
      recent,
      {
        result: "as_planned",
        sources: [{ url: "https://example.com/suzunari/top" }],
        yearStated: false,
      },
      today,
      "2026-08-16",
    );
    expect(decision.result).toBe("as_planned");
    expect(decision.note).toBe(DATA_CONFIRMED_NOTE);
    expect(decision.sources[0]?.checkedAt).toBe("2026-07-29");
  });

  it("変更・中止の知らせは、データより Web の結果を優先する", () => {
    const decision = decideVerification(
      recent,
      { result: "cancelled", sources: [{ url: "https://example.com/suzunari/news" }] },
      today,
      "2026-08-16",
    );
    expect(decision.result).toBe("cancelled");
  });

  it("データの出典が公式でなければ、確認できずを要事前確認にする", () => {
    const single = testFestival({
      id: "kogane-single",
      edit: (f) => {
        for (const o of f.occurrences) {
          o.sources = [{ ...o.sources[0]!, checkedAt: "2026-07-29", confidence: "single" }];
        }
      },
    });
    const decision = decideVerification(
      single,
      { result: "not_found", sources: [] },
      today,
      "2026-08-16",
    );
    expect(decision).toMatchObject({ result: "needs_check", note: DATA_UNOFFICIAL_NOTE });
  });

  it("確かめる日を渡さなければ、データでは確かめない", () => {
    expect(decideVerification(recent, { result: "not_found", sources: [] }, today).result).toBe(
      "not_found",
    );
  });
});
