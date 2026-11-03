import { describe, expect, it } from "vitest";
import { testFestival } from "./testFestivals";
import { decideVerification, officialHosts, YEAR_NOT_STATED_NOTE } from "./verification";

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

  it("公式の出典でも、今年の開催と書かれていなければ予定どおりと認めず、確認できずにする", () => {
    const report = {
      result: "as_planned" as const,
      sources: [{ url: "https://example.com/suzunari/" }],
      note: "例年8月16日に開催",
    };
    const notStated = decideVerification(festival, { ...report, yearStated: false }, today);
    const unknown = decideVerification(festival, report, today);

    for (const decision of [notStated, unknown]) {
      expect(decision.result).toBe("not_found");
      expect(decision.note).toBe(YEAR_NOT_STATED_NOTE);
      expect(decision.sources[0]?.confidence).toBe("official");
    }
  });

  it("公式でない出典1つだけでは予定どおりと認めず、確認できずにする", () => {
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
