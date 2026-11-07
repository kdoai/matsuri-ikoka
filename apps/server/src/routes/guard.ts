import { createHash, timingSafeEqual } from "node:crypto";
import { type IsoDate, isTrialAccount } from "@matsuri-ikoka/schema";
import type { MiddlewareHandler } from "hono";
import type { DailyCountStore } from "../storage/dailyCounts";
import { apiError } from "./errors";

// 公開している URL の入口：合言葉と、1日の相談の回数の上限（ADR 0004）。

export const PASSCODE_HEADER = "x-access-passcode";

/**
 * 合言葉と、中身によらず同じ時間で比べる。timingSafeEqual は同じ長さでしか比べられないので、
 * 送られた値を合言葉の長さにそろえて比べ、長さは別に確かめる
 */
function samePasscode(given: string, expected: Buffer): boolean {
  const received = Buffer.from(given);
  const sized = Buffer.alloc(expected.length);
  received.copy(sized);
  return timingSafeEqual(sized, expected) && received.length === expected.length;
}

/** 合言葉が設定されていれば、ヘッダーの値と比べる。設定がなければ通す */
export function passcodeGuard(passcode: string | null): MiddlewareHandler {
  const expected = passcode === null ? null : Buffer.from(passcode);
  return async (c, next) => {
    if (expected !== null && !samePasscode(c.req.header(PASSCODE_HEADER) ?? "", expected)) {
      return c.json(apiError("unauthorized", "合言葉が違います。", false), 401);
    }
    return next();
  };
}

/** 数えるキーを、残してよい形にする。IP や利用者の ID そのものは残さない */
export function countKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

/** 数えを残す先。scope は枠の名前（全体・利用者ごと・お試し用）で、置き場を分ける */
export interface DailyLimiterPersistence {
  store: DailyCountStore;
  scope: string;
  /** 残すのに失敗したとき。相談は止めない */
  onError?: (error: unknown) => void;
}

/**
 * 1日（日本の日付）の相談の回数を、キー（全体、または limitKey）ごとに数える。上限がなければ数えるだけ。
 * 日付が変わったら数え直す（前の日の数は捨てるので、キーの数だけメモリが増え続けることはない）。
 * 残す先（persistence）があれば、数えるたびに書き足し、起動のときに restore でその日の数を読み戻す。
 * 使えるかどうかはメモリの数で決め、書き足しを待たない（保存の口が失敗しても相談は止めない）
 */
export class DailyLimiter {
  readonly #limit: number | null;
  readonly #today: () => IsoDate;
  readonly #persistence: DailyLimiterPersistence | null;
  #day: IsoDate | null = null;
  #counts = new Map<string, number>();

  constructor(
    limit: number | null,
    today: () => IsoDate,
    persistence: DailyLimiterPersistence | null = null,
  ) {
    this.#limit = limit;
    this.#today = today;
    // 上限のない枠は、数えを残しても使い道がないので残さない
    this.#persistence = limit === null ? null : persistence;
  }

  #roll(): IsoDate {
    const today = this.#today();
    if (this.#day !== today) {
      this.#day = today;
      this.#counts = new Map();
    }
    return today;
  }

  /** まだ使えるか（数えない） */
  allows(key = "*"): boolean {
    this.#roll();
    return this.#limit === null || (this.#counts.get(countKey(key)) ?? 0) < this.#limit;
  }

  /** 1回分を使う。上限に達していれば false */
  consume(key = "*"): boolean {
    if (!this.allows(key)) return false;
    const day = this.#roll();
    const stored = countKey(key);
    this.#counts.set(stored, (this.#counts.get(stored) ?? 0) + 1);
    const persistence = this.#persistence;
    if (persistence !== null) {
      persistence.store.add(persistence.scope, day, stored).catch((error: unknown) => {
        persistence.onError?.(error);
      });
    }
    return true;
  }

  /**
   * その日の数を、残す先から読み戻す。読んだ数とメモリの数の多いほうを使う。
   * 残す先がなければ何もしない。読めなければ例外にする（呼ぶ側が、ログに残して続ける）
   */
  async restore(): Promise<void> {
    if (this.#persistence === null) return;
    const day = this.#roll();
    const saved = await this.#persistence.store.load(this.#persistence.scope, day);
    if (this.#day !== day) return;
    for (const [key, count] of saved) {
      this.#counts.set(key, Math.max(count, this.#counts.get(key) ?? 0));
    }
  }
}

/**
 * 起動のときに、1日の回数の数えを読み戻す。待つのは timeoutMs まで。
 * 読めなくても、間に合わなくても、起動は止めない（読み戻せなかった枠を返す。呼ぶ側がログに残す）
 */
export async function restoreDailyLimits(
  limiters: Readonly<Record<string, DailyLimiter>>,
  timeoutMs: number,
): Promise<{ failed: string[] }> {
  const failed: string[] = [];
  await Promise.all(
    Object.entries(limiters).map(async ([name, limiter]) => {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      });
      try {
        await Promise.race([limiter.restore(), late]);
      } catch {
        failed.push(name);
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return { failed: failed.sort() };
}

/** 上限を数える単位。ログインしていれば利用者、していなければ IP */
export function limitKey(viewer: string | null, ip: string): string {
  return viewer === null ? ip : `uid:${viewer}`;
}

/** 1回分の相談の枠。だれの分をどの枠で数えるかは turnQuota で決まっている */
export interface TurnQuota {
  /** 同時に作る数を数える単位 */
  client: string;
  /** 利用者の IP */
  ip: string;
  allows(): boolean;
  consume(): void;
}

/**
 * 相談の回数の数え方を決める。
 * - ログインしていない人：全体の枠と、IP の枠
 * - ログインしている人：全体の枠と、利用者の枠と、IP の枠。登録し直しても上限を回避できないよう、IP でも数える
 * - お試し用のアカウント：お試し用の全体の枠と、IP の枠。何人かで使うので利用者では数えず、
 *   全体の枠も分けて、お試し用だけでほかの人の相談の枠を使い切らないようにする
 */
export function turnQuota(
  limiters: {
    limiter: DailyLimiter;
    clientLimiter?: DailyLimiter | undefined;
    trialLimiter?: DailyLimiter | undefined;
  },
  viewer: string | null,
  ip: string,
): TurnQuota {
  const trial = viewer !== null && isTrialAccount(viewer);
  const pool = trial ? (limiters.trialLimiter ?? limiters.limiter) : limiters.limiter;
  const client = trial ? ip : limitKey(viewer, ip);
  const keys = client === ip ? [ip] : [ip, client];
  return {
    client,
    ip,
    allows: () =>
      pool.allows() && keys.every((key) => limiters.clientLimiter?.allows(key) !== false),
    consume: () => {
      pool.consume();
      for (const key of keys) limiters.clientLimiter?.consume(key);
    },
  };
}

/**
 * 同時に動かせる数を数える。live で同時に返事を作る数（Claude を呼ぶ数）を抑える。
 * 全体の上限と、1人（limitKey）の上限を持ち、1人が枠を使い切らないようにする
 */
export class ConcurrencyLimiter {
  readonly #max: number;
  readonly #maxPerClient: number;
  readonly #byClient = new Map<string, number>();
  #running = 0;

  /** maxPerClient を省くと、1人の上限は全体の上限と同じ */
  constructor(max: number, maxPerClient: number = max) {
    this.#max = max;
    this.#maxPerClient = maxPerClient;
  }

  get running(): number {
    return this.#running;
  }

  /** 1つ分を取る。空きがなければ null。取れたら、終わったときに返す関数を返す */
  tryAcquire(client = "*"): (() => void) | null {
    const mine = this.#byClient.get(client) ?? 0;
    if (this.#running >= this.#max || mine >= this.#maxPerClient) return null;
    this.#running += 1;
    this.#byClient.set(client, mine + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#running -= 1;
      const left = (this.#byClient.get(client) ?? 1) - 1;
      if (left > 0) {
        this.#byClient.set(client, left);
      } else {
        this.#byClient.delete(client);
      }
    };
  }
}

/**
 * 利用者の IP。前に置いたプロキシの数（trustedProxyHops）が分かっていれば、
 * X-Forwarded-For の右から数えてその位置の値を使う（左側は利用者が書き換えられるので使わない）。
 * プロキシがなければ、接続の相手のアドレスを使う
 */
export function clientIp(
  forwardedFor: string | undefined,
  remoteAddress: string | undefined,
  trustedProxyHops: number,
): string {
  if (trustedProxyHops > 0 && forwardedFor) {
    const hops = forwardedFor
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const ip = hops[hops.length - trustedProxyHops];
    if (ip) return ip;
  }
  return remoteAddress ?? "unknown";
}
