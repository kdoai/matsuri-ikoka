import type { DailyGuideUsage, GuideUsage } from "../storage/types";

// ガイドの費用と回数の上限（docs/spec/guide.md の「失敗の扱い」）。利用者と旅ごとに、1日の分を数える。
// ログインしている人の分は保存の口に残し、再起動やインスタンスの増減で数え直されないようにする。
// ログインしていない人の分は、このインスタンスのメモリで IP ごとに数える。

export interface GuideLimits {
  turnsPerUser: number;
  turnsPerTrip: number;
  costUsdPerUser: number;
  costUsdPerTrip: number;
}

/** 設定がないときの上限。緊急の案内は、上限に達しても断らない */
export const DEFAULT_GUIDE_LIMITS: GuideLimits = {
  turnsPerUser: 60,
  turnsPerTrip: 40,
  costUsdPerUser: 3,
  costUsdPerTrip: 2,
};

/** 上限に達しているか */
export function overGuideLimit(usage: DailyGuideUsage, limits: GuideLimits): boolean {
  return (
    usage.user.turns >= limits.turnsPerUser ||
    usage.trip.turns >= limits.turnsPerTrip ||
    usage.user.costUsd >= limits.costUsdPerUser ||
    usage.trip.costUsd >= limits.costUsdPerTrip
  );
}

/** この発言に使える費用（米ドル）。1回の上限と、今日の残りの小さいほう */
export function guideTurnBudgetUsd(
  usage: DailyGuideUsage,
  limits: GuideLimits,
  perTurnUsd: number | undefined,
): number {
  const remaining = Math.min(
    limits.costUsdPerUser - usage.user.costUsd,
    limits.costUsdPerTrip - usage.trip.costUsd,
  );
  return perTurnUsd === undefined ? remaining : Math.min(perTurnUsd, remaining);
}

/** 使った量の読み書きの口。呼ぶ側は、だれの分かを知らない */
export interface GuideUsageLedger {
  read(): Promise<DailyGuideUsage>;
  add(delta: GuideUsage): Promise<void>;
}

const noUsage = (): GuideUsage => ({ turns: 0, costUsd: 0 });

/** メモリに置く、使った量の数の上限 */
const MAX_MEMORY_USAGE_KEYS = 20_000;

/** ログインしていない人の使った量。日付が変わったら数え直す（前の日の分は捨てる） */
export class MemoryGuideUsage {
  readonly #today: () => string;
  #day: string | null = null;
  #counts = new Map<string, GuideUsage>();

  constructor(today: () => string) {
    this.#today = today;
  }

  #roll(): Map<string, GuideUsage> {
    const today = this.#today();
    if (this.#day !== today) {
      this.#day = today;
      this.#counts = new Map();
    }
    return this.#counts;
  }

  /** client は上限を数える単位（IP）、tripId は旅 */
  ledger(client: string, tripId: string): GuideUsageLedger {
    const userKey = `user:${client}`;
    const tripKey = `trip:${tripId}`;
    return {
      read: async () => {
        const counts = this.#roll();
        return {
          user: { ...(counts.get(userKey) ?? noUsage()) },
          trip: { ...(counts.get(tripKey) ?? noUsage()) },
        };
      },
      add: async (delta) => {
        const counts = this.#roll();
        for (const key of [userKey, tripKey]) {
          const current = counts.get(key) ?? noUsage();
          counts.set(key, {
            turns: current.turns + delta.turns,
            costUsd: current.costUsd + delta.costUsd,
          });
        }
        for (const key of counts.keys()) {
          if (counts.size <= MAX_MEMORY_USAGE_KEYS) break;
          counts.delete(key);
        }
      },
    };
  }
}
