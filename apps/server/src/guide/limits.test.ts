import { describe, expect, it } from "vitest";
import {
  DEFAULT_GUIDE_LIMITS,
  type GuideLimits,
  guideTurnBudgetUsd,
  MemoryGuideUsage,
  overGuideLimit,
  ownerAndIpLedger,
  trialLedger,
} from "./limits";

const LIMITS: GuideLimits = {
  turnsPerUser: 2,
  turnsPerTrip: 10,
  costUsdPerUser: 1,
  costUsdPerTrip: 10,
  costUsdTrialTotal: 1.5,
};
const usage = () => new MemoryGuideUsage(() => "2026-08-03");

describe("trialLedger", () => {
  it("IP ごとに数えるので、1人が使い切っても、ほかの IP の人は使える", async () => {
    const memory = usage();
    const mine = trialLedger(memory, "203.0.113.1", "trip-1", LIMITS);
    const other = trialLedger(memory, "203.0.113.2", "trip-2", LIMITS);

    await mine.add({ turns: 2, costUsd: 0.1 });

    expect(overGuideLimit(await mine.read(), LIMITS)).toBe(true);
    expect(overGuideLimit(await other.read(), LIMITS)).toBe(false);
  });

  it("全員を合わせた費用の上限で、今日の残りが減り、使い切ると全員が止まる", async () => {
    const memory = usage();
    const mine = trialLedger(memory, "203.0.113.1", "trip-1", LIMITS);
    const other = trialLedger(memory, "203.0.113.2", "trip-2", LIMITS);
    const third = trialLedger(memory, "203.0.113.3", "trip-3", LIMITS);

    await mine.add({ turns: 1, costUsd: 0.9 });
    expect(guideTurnBudgetUsd(await other.read(), LIMITS, undefined)).toBeCloseTo(0.6);

    await other.add({ turns: 1, costUsd: 0.6 });
    expect(overGuideLimit(await third.read(), LIMITS)).toBe(true);
  });

  it("全員の上限を省くと、既定の値を使う", async () => {
    const ledger = trialLedger(usage(), "203.0.113.1", "trip-1", DEFAULT_GUIDE_LIMITS);

    expect(overGuideLimit(await ledger.read(), DEFAULT_GUIDE_LIMITS)).toBe(false);
  });
});

describe("ownerAndIpLedger", () => {
  it("利用者が変わっても、同じ IP の分は数え直さない", async () => {
    const memory = usage();
    const stored = new MemoryGuideUsage(() => "2026-08-03");
    const alice = ownerAndIpLedger(
      stored.ledger("alice", "trip-1"),
      memory.ledger("203.0.113.1", "trip-1"),
    );
    const renamed = ownerAndIpLedger(
      stored.ledger("bob", "trip-2"),
      memory.ledger("203.0.113.1", "trip-2"),
    );
    const elsewhere = ownerAndIpLedger(
      stored.ledger("carol", "trip-3"),
      memory.ledger("203.0.113.2", "trip-3"),
    );

    await alice.add({ turns: 2, costUsd: 0.2 });

    expect((await renamed.read()).user).toEqual({ turns: 2, costUsd: 0.2 });
    expect((await renamed.read()).trip).toEqual({ turns: 0, costUsd: 0 });
    expect((await elsewhere.read()).user).toEqual({ turns: 0, costUsd: 0 });
  });
});
