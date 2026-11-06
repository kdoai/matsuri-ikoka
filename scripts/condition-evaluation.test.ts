import { describe, expect, it } from "vitest";
import { testFestival } from "../apps/server/src/domain/testFestivals";
import {
  conditionCases,
  EVALUATION_MONTHS,
  EVALUATION_NIGHTS,
  EVALUATION_ORIGINS,
  evaluateConditions,
} from "./condition-evaluation";

const TODAY = "2026-08-20";

describe("conditionCases", () => {
  it("出発の駅×泊数×月ごとの「その月」と「最初の土曜日」を作る", () => {
    const cases = conditionCases(TODAY);
    expect(cases).toHaveLength(
      EVALUATION_ORIGINS.length * EVALUATION_NIGHTS.length * EVALUATION_MONTHS * 2,
    );
    expect(new Set(cases.map((c) => c.month)).size).toBe(EVALUATION_MONTHS);
  });

  it("基準の日より前の日を条件にしない", () => {
    const august = conditionCases(TODAY).filter((c) => c.month === "2026-08");
    expect(august.find((c) => c.shape === "month")?.when).toEqual({
      kind: "range",
      from: TODAY,
      to: "2026-08-31",
    });
    expect(august.find((c) => c.shape === "saturday")?.when).toEqual({
      kind: "date",
      date: "2026-08-22",
    });
  });

  it("年をまたいでも月と日付を正しく作る", () => {
    const january = conditionCases(TODAY).find((c) => c.month === "2027-01" && c.shape === "month");
    expect(january?.when).toEqual({ kind: "range", from: "2027-01-01", to: "2027-01-31" });
  });
});

describe("evaluateConditions", () => {
  const saturday = "2026-09-05";

  it("祭りがない条件の組は候補なしに数え、次の手がなければそれも数えない", () => {
    const result = evaluateConditions([], { today: TODAY });
    expect(result.found.count).toBe(0);
    expect(result.found.total).toBe(conditionCases(TODAY).length);
    expect(result.nextStepWhenNone).toEqual({ count: 0, total: result.found.total });
    expect(result.candidates).toBe(0);
  });

  it("泊まりなら、データにない出発の駅からでも候補に出す", () => {
    const result = evaluateConditions([testFestival({ id: "a", date: saturday })], {
      today: TODAY,
    });
    expect(result.byNights[1]?.count).toBeGreaterThan(0);
    expect(result.byMonth["2026-09"]?.count).toBeGreaterThan(0);
    expect(result.byMonth["2026-10"]?.count).toBe(0);
    expect(result.violations).toEqual([]);
  });

  it("候補が出ない月でも、先の日程で見つかるなら次の手を示せたと数える", () => {
    const result = evaluateConditions([testFestival({ id: "a", date: saturday })], {
      today: TODAY,
    });
    expect(result.nextStepWhenNone.count).toBeGreaterThan(0);
  });

  it("掲載停止と中止の祭りは候補に出さない", () => {
    const result = evaluateConditions(
      [
        testFestival({ id: "stopped", date: saturday, optOut: true }),
        testFestival({ id: "over", date: saturday, status: "cancelled" }),
      ],
      { today: TODAY },
    );
    expect(result.found.count).toBe(0);
    expect(result.violations).toEqual([]);
  });

  it("3件そろった条件の組だけを threeOrMore に数える", () => {
    const festivals = ["a", "b", "c"].map((id) => testFestival({ id, date: saturday }));
    const result = evaluateConditions(festivals, { today: TODAY });
    const two = evaluateConditions(festivals.slice(0, 2), { today: TODAY });
    expect(result.threeOrMore.count).toBeGreaterThan(0);
    expect(two.threeOrMore.count).toBe(0);
    expect(two.found.count).toBe(result.found.count);
  });

  it("見込みの開催と、片道の上限に収まるか分からない日帰りを分けて数える", () => {
    const result = evaluateConditions(
      [
        testFestival({ id: "known", date: saturday }),
        testFestival({ id: "expected", date: saturday, status: "expected", fromHubMinutes: null }),
      ],
      { today: TODAY },
    );
    expect(result.confirmedCandidates.total).toBe(result.candidates);
    expect(result.confirmedCandidates.count).toBeGreaterThan(0);
    expect(result.confirmedCandidates.count).toBeLessThan(result.candidates);
    expect(result.dayTripWithinLimit.count).toBe(0);
    expect(result.dayTripWithinLimit.total).toBeGreaterThan(0);
  });

  it("同じデータなら同じ数字になる", () => {
    const festivals = [testFestival({ id: "a", date: saturday })];
    expect(evaluateConditions(festivals, { today: TODAY })).toEqual(
      evaluateConditions(festivals, { today: TODAY }),
    );
  });
});
