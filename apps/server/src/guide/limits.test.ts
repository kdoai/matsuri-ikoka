import { describe, expect, it } from "vitest";
import {
  DEFAULT_GUIDE_LIMITS,
  guideTurnBudgetUsd,
  MemoryGuideUsage,
  overGuideLimit,
} from "./limits";

const usage = (user: [number, number], trip: [number, number]) => ({
  user: { turns: user[0], costUsd: user[1] },
  trip: { turns: trip[0], costUsd: trip[1] },
});
const limits = { turnsPerUser: 5, turnsPerTrip: 3, costUsdPerUser: 2, costUsdPerTrip: 1 };

describe("overGuideLimit", () => {
  it("利用者と旅の、回数と費用のどれかが上限に達したら止める", () => {
    expect(overGuideLimit(usage([4, 1.9], [2, 0.9]), limits)).toBe(false);
    expect(overGuideLimit(usage([5, 0], [0, 0]), limits)).toBe(true);
    expect(overGuideLimit(usage([0, 2], [0, 0]), limits)).toBe(true);
    expect(overGuideLimit(usage([0, 0], [3, 0]), limits)).toBe(true);
    expect(overGuideLimit(usage([0, 0], [0, 1]), limits)).toBe(true);
  });

  it("既定の上限があり、上限なしにはならない", () => {
    expect(DEFAULT_GUIDE_LIMITS.turnsPerUser).toBeGreaterThan(0);
    expect(DEFAULT_GUIDE_LIMITS.costUsdPerTrip).toBeGreaterThan(0);
  });
});

describe("guideTurnBudgetUsd", () => {
  it("1回の上限と、今日の残りの小さいほうを使う", () => {
    expect(guideTurnBudgetUsd(usage([0, 0], [0, 0]), limits, 0.5)).toBe(0.5);
    expect(guideTurnBudgetUsd(usage([0, 1.8], [0, 0]), limits, 0.5)).toBeCloseTo(0.2);
    expect(guideTurnBudgetUsd(usage([0, 0], [0, 0.9]), limits, 0.5)).toBeCloseTo(0.1);
    expect(guideTurnBudgetUsd(usage([0, 0], [0, 0]), limits, undefined)).toBe(1);
  });
});

describe("MemoryGuideUsage", () => {
  it("利用者と旅ごとに数え、日付が変わったら数え直す", async () => {
    let today = "2026-08-03";
    const memory = new MemoryGuideUsage(() => today);
    const mine = memory.ledger("203.0.113.1", "trip-a");

    await mine.add({ turns: 1, costUsd: 0.25 });
    await memory.ledger("203.0.113.1", "trip-b").add({ turns: 1, costUsd: 0.25 });
    await memory.ledger("203.0.113.2", "trip-c").add({ turns: 1, costUsd: 1 });

    expect(await mine.read()).toEqual(usage([2, 0.5], [1, 0.25]));
    today = "2026-08-04";
    expect(await mine.read()).toEqual(usage([0, 0], [0, 0]));
  });
});
