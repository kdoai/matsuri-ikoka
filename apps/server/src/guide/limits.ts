import type { DailyGuideUsage, GuideUsage } from "../storage/types";

// ガイドの費用と回数の上限（docs/spec/guide.md の「失敗の扱い」）。利用者と旅ごとに、1日の分を数える。
// ログインしている人の分は保存の口に残し、再起動やインスタンスの増減で数え直されないようにする。
// ログインしていない人の分は、このインスタンスのメモリで IP ごとに数える。

export interface GuideLimits {
  turnsPerUser: number;
  turnsPerTrip: number;
  costUsdPerUser: number;
  costUsdPerTrip: number;
  /** お試し用のアカウントの、全員を合わせた1日の費用の上限。省くと既定の値 */
  costUsdTrialTotal?: number;
}

/** お試し用のアカウントの、全員を合わせた1日の費用の上限の既定 */
export const DEFAULT_TRIAL_GUIDE_COST_USD = 5;

/** 設定がないときの上限 */
export const DEFAULT_GUIDE_LIMITS: GuideLimits = {
  turnsPerUser: 60,
  turnsPerTrip: 40,
  costUsdPerUser: 3,
  costUsdPerTrip: 2,
  costUsdTrialTotal: DEFAULT_TRIAL_GUIDE_COST_USD,
};

/**
 * 結果が届かなかった発言（切断・時間切れ・失敗）に足す費用の見積もり（米ドル）。
 * 費用が分からなくても、モデルは動いているので、0 で数えない
 */
export const GUIDE_NO_RESULT_COST_USD = 0.02;

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

const maxUsage = (a: GuideUsage, b: GuideUsage): GuideUsage => ({
  turns: Math.max(a.turns, b.turns),
  costUsd: Math.max(a.costUsd, b.costUsd),
});

/**
 * ログインしている人の使った量。利用者の分（保存の口）に、IP の分（メモリ）を合わせる。
 * 登録し直して利用者が変わっても、同じ IP の分は数え直さない
 */
export function ownerAndIpLedger(owner: GuideUsageLedger, ip: GuideUsageLedger): GuideUsageLedger {
  return {
    read: async () => {
      const [mine, fromIp] = await Promise.all([owner.read(), ip.read()]);
      return { user: maxUsage(mine.user, fromIp.user), trip: mine.trip };
    },
    add: async (delta) => {
      await ip.add(delta);
      await owner.add(delta);
    },
  };
}

/** お試し用のアカウントの使った量を合わせて数えるキー */
const TRIAL_TOTAL_KEY = "trial:total";

/**
 * お試し用のアカウントの使った量。何人かで使うので IP ごとに数え、1人が使い切っても全員は止まらない。
 * 全員を合わせた費用にも上限を持ち、今日の残りが全員の残りより多くならないようにする
 */
export function trialLedger(
  usage: MemoryGuideUsage,
  ip: string,
  tripId: string,
  limits: GuideLimits,
): GuideUsageLedger {
  const mine = usage.ledger(ip, tripId);
  const total = usage.ledger(TRIAL_TOTAL_KEY, TRIAL_TOTAL_KEY);
  const totalLimit = limits.costUsdTrialTotal ?? DEFAULT_TRIAL_GUIDE_COST_USD;
  return {
    read: async () => {
      const [own, all] = await Promise.all([mine.read(), total.read()]);
      const totalLeft = totalLimit - all.user.costUsd;
      return {
        user: {
          turns: own.user.turns,
          costUsd: Math.max(own.user.costUsd, limits.costUsdPerUser - totalLeft),
        },
        trip: own.trip,
      };
    },
    add: async (delta) => {
      await mine.add(delta);
      await total.add(delta);
    },
  };
}

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
