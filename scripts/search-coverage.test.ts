import { describe, expect, it } from "vitest";
import { REGION_PREFECTURES } from "../apps/server/src/domain/destination";
import { testFestival } from "../apps/server/src/domain/testFestivals";
import { PREFECTURES } from "../packages/schema/src";
import { COVERAGE_REGIONS, searchCoverage } from "./search-coverage";

const TODAY = "2026-07-01";

describe("searchCoverage", () => {
  it("すべての都道府県が、ちょうど1つの地方に入る", () => {
    const counted = COVERAGE_REGIONS.flatMap((r) => REGION_PREFECTURES[r] ?? []);
    expect([...counted].sort()).toEqual([...PREFECTURES].sort());
  });

  it("種類×季節×地方を数え、0件と少ない組み合わせを分ける", () => {
    const festivals = [
      testFestival({ id: "a", category: "fireworks", date: "2026-08-01" }),
      testFestival({ id: "stopped", category: "fireworks", date: "2026-08-01", optOut: true }),
      testFestival({ id: "over", category: "fireworks", date: "2026-08-01", status: "cancelled" }),
      testFestival({ id: "past", category: "fireworks", date: "2026-06-01" }),
    ];
    const coverage = searchCoverage(festivals, TODAY);
    expect(coverage.cells).toHaveLength(6 * 4 * 8);
    expect(coverage.festivals).toBe(3);
    expect(coverage.searchable).toBe(1);
    const cell = coverage.cells.find(
      (c) => c.kind === "fireworks" && c.season === "summer" && c.region === "近畿",
    );
    expect(cell).toMatchObject({ count: 1, strong: 1 });
    expect(coverage.few).toContainEqual(cell);
    expect(coverage.empty).toContainEqual(
      expect.objectContaining({ kind: "fireworks", season: "winter", region: "近畿", count: 0 }),
    );
    expect(coverage.kindTotals.fireworks).toEqual({ count: 1, strong: 1 });
    expect(coverage.kindTotals.famous).toEqual({ count: 0, strong: 0 });
  });
});
