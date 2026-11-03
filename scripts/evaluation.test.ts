import { describe, expect, it } from "vitest";
import { type Festival, FestivalSchema } from "../packages/schema/src";
import { fictionalFestival, fictionalSource } from "../packages/schema/src/testing";
import { evaluateFestivals, formatRatio, nextOccurrence } from "./evaluation";

// 架空の祭りの開催は 2026-08-16（発表済み・公式）
const TODAY = "2026-04-02";

function festival(edit: (f: ReturnType<typeof fictionalFestival>) => void = () => {}): Festival {
  const input = fictionalFestival();
  edit(input);
  return FestivalSchema.parse(input);
}

describe("nextOccurrence", () => {
  const twoYears = festival((f) => {
    f.occurrences.push({
      date: "2027-08-15",
      start: null,
      end: null,
      status: "expected",
      rainPolicy: null,
      sources: [fictionalSource("2027", "inferred")],
    });
  });

  it("基準の日に終わっていない開催回のうち、いちばん早いものを選ぶ", () => {
    expect(nextOccurrence(twoYears, TODAY).date).toBe("2026-08-16");
    expect(nextOccurrence(twoYears, "2026-08-16").date).toBe("2026-08-16");
    expect(nextOccurrence(twoYears, "2026-08-17").date).toBe("2027-08-15");
  });

  it("すべて過ぎていれば、いちばん新しい開催回を選ぶ", () => {
    expect(nextOccurrence(twoYears, "2028-01-01").date).toBe("2027-08-15");
  });

  it("複数日の開催は、最終日まで次の開催回として扱う", () => {
    const multiDay = festival((f) => {
      const [first] = f.occurrences;
      if (first) first.endDate = "2026-08-17";
    });
    expect(nextOccurrence(multiDay, "2026-08-17").date).toBe("2026-08-16");
  });
});

describe("evaluateFestivals", () => {
  it("架空の祭り1件：開催は確かめられ、作法はすべて分かっている", () => {
    const result = evaluateFestivals([festival()], { today: TODAY });
    expect(result.festivals).toBe(1);
    expect(result.local).toEqual({ count: 1, total: 1 });
    expect(result.confirmed).toEqual({ count: 1, total: 1 });
    expect(result.occurrenceConfidence).toEqual({
      official: 1,
      corroborated: 0,
      single: 0,
      inferred: 0,
    });
    expect(result.etiquetteKnown).toEqual({ count: 7, total: 7 });
    expect(result.gapsPerFestival).toBe(1);
  });

  it("見込みや単独の出典の開催回は、確かめられた数に入れない", () => {
    const expected = festival((f) => {
      const [first] = f.occurrences;
      if (first) first.status = "expected";
    });
    const single = festival((f) => {
      const [first] = f.occurrences;
      if (first) first.sources = [fictionalSource("2026", "single")];
    });
    const result = evaluateFestivals([expected, single], { today: TODAY });
    expect(result.confirmed).toEqual({ count: 0, total: 2 });
    expect(result.occurrenceConfidence.official).toBe(1);
    expect(result.occurrenceConfidence.single).toBe(1);
  });

  it("unknown の作法の項目は分かっている数に入れず、見学だけの howToJoin は分母から除く", () => {
    const watchOnly = festival((f) => {
      f.etiquette.participation = "watch_only";
      f.etiquette.howToJoin = null;
      f.etiquette.dress = "unknown";
      f.etiquette.photo = "unknown";
    });
    const result = evaluateFestivals([watchOnly], { today: TODAY });
    expect(result.etiquetteKnown).toEqual({ count: 4, total: 6 });
    expect(result.etiquetteKnownByItem.howToJoin).toEqual({ count: 0, total: 0 });
    expect(result.etiquetteKnownByItem.dress).toEqual({ count: 0, total: 1 });
  });

  it("掲載停止の祭りは数えない", () => {
    const optedOut = festival((f) => {
      f.id = "suzunari-opt-out";
      f.optOut = true;
      f.popularity = "major";
    });
    const result = evaluateFestivals([festival(), optedOut], { today: TODAY });
    expect(result.festivals).toBe(1);
    expect(result.local).toEqual({ count: 1, total: 1 });
  });

  it("祭りがなければ、どの数も0", () => {
    const result = evaluateFestivals([], { today: TODAY });
    expect(result.festivals).toBe(0);
    expect(result.confirmed).toEqual({ count: 0, total: 0 });
    expect(result.gapsPerFestival).toBe(0);
  });
});

describe("formatRatio", () => {
  it("件数と、四捨五入した割合を出す", () => {
    expect(formatRatio({ count: 2, total: 3 })).toBe("2 / 3（67%）");
  });

  it("分母が0なら割合を出さない", () => {
    expect(formatRatio({ count: 0, total: 0 })).toBe("0 / 0（—）");
  });
});
