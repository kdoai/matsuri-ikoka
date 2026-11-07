import { describe, expect, it } from "vitest";
import { readPatrolConfig } from "./config";

// 鍵の値はテストのためだけのもの。
const KEY = "test-only-not-a-real-key";

describe("readPatrolConfig", () => {
  it("鍵がなければ見回りを用意しない", () => {
    expect(readPatrolConfig({})).toBeNull();
    expect(readPatrolConfig({ PATROL_ANTHROPIC_API_KEY: "  " })).toBeNull();
  });

  it("鍵だけなら既定の予算と上限で動く", () => {
    expect(readPatrolConfig({ PATROL_ANTHROPIC_API_KEY: KEY })).toEqual({
      apiKey: KEY,
      sessionBudgetCents: 200,
      maxTargetsPerRun: 20,
      maxLodgingChecksPerRun: 10,
      checkIntervalMs: 6 * 60 * 60 * 1000,
    });
  });

  it("予算は米ドルで受けてセントにする。上限を超えた値は上限にする", () => {
    const config = (value: string) =>
      readPatrolConfig({ PATROL_ANTHROPIC_API_KEY: KEY, PATROL_SESSION_BUDGET_USD: value });

    expect(config("0.5")?.sessionBudgetCents).toBe(50);
    expect(config("9999")?.sessionBudgetCents).toBe(1000);
  });

  it("対象の数はスキーマの上限を超えない", () => {
    const config = (value: string) =>
      readPatrolConfig({ PATROL_ANTHROPIC_API_KEY: KEY, PATROL_MAX_TARGETS: value });

    expect(config("3")?.maxTargetsPerRun).toBe(3);
    expect(config("500")?.maxTargetsPerRun).toBe(20);
    expect(config("0.5")?.maxTargetsPerRun).toBe(1);
  });

  it("調べる間隔には1時間の下限がある", () => {
    const config = (value: string) =>
      readPatrolConfig({ PATROL_ANTHROPIC_API_KEY: KEY, PATROL_CHECK_INTERVAL_HOURS: value });

    expect(config("0.01")?.checkIntervalMs).toBe(60 * 60 * 1000);
    expect(config("12")?.checkIntervalMs).toBe(12 * 60 * 60 * 1000);
  });

  it.each(["abc", "-1", "0", ""])("読めない値「%s」は既定にして、サーバーを止めない", (value) => {
    const config = readPatrolConfig({
      PATROL_ANTHROPIC_API_KEY: KEY,
      PATROL_SESSION_BUDGET_USD: value,
      PATROL_MAX_TARGETS: value,
      PATROL_CHECK_INTERVAL_HOURS: value,
    });

    expect(config).toMatchObject({
      sessionBudgetCents: 200,
      maxTargetsPerRun: 20,
      checkIntervalMs: 6 * 60 * 60 * 1000,
    });
  });
});
