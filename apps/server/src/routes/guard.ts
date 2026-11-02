import { createHash, timingSafeEqual } from "node:crypto";
import type { IsoDate } from "@matsuri-ikoka/schema";
import type { MiddlewareHandler } from "hono";
import { apiError } from "./errors";

// 公開している URL の入口：合言葉と、1日の相談の回数の上限（ADR 0004）。

export const PASSCODE_HEADER = "x-access-passcode";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** 合言葉が設定されていれば、ヘッダーの値と比べる。設定がなければ通す */
export function passcodeGuard(passcode: string | null): MiddlewareHandler {
  const expected = passcode === null ? null : digest(passcode);
  return async (c, next) => {
    if (expected !== null) {
      const given = c.req.header(PASSCODE_HEADER) ?? "";
      if (!timingSafeEqual(digest(given), expected)) {
        return c.json(apiError("unauthorized", "合言葉が違います。", false), 401);
      }
    }
    return next();
  };
}

/**
 * 1日（日本の日付）の相談の回数を、キー（全体、または IP）ごとに数える。上限がなければ数えるだけ。
 * 日付が変わったら数え直す（前の日の数は捨てるので、キーの数だけメモリが増え続けることはない）
 */
export class DailyLimiter {
  readonly #limit: number | null;
  readonly #today: () => IsoDate;
  #day: IsoDate | null = null;
  #counts = new Map<string, number>();

  constructor(limit: number | null, today: () => IsoDate) {
    this.#limit = limit;
    this.#today = today;
  }

  #roll(): void {
    const today = this.#today();
    if (this.#day !== today) {
      this.#day = today;
      this.#counts = new Map();
    }
  }

  /** まだ使えるか（数えない） */
  allows(key = "*"): boolean {
    this.#roll();
    return this.#limit === null || (this.#counts.get(key) ?? 0) < this.#limit;
  }

  /** 1回分を使う。上限に達していれば false */
  consume(key = "*"): boolean {
    if (!this.allows(key)) return false;
    this.#counts.set(key, (this.#counts.get(key) ?? 0) + 1);
    return true;
  }
}

/** 同時に動かせる数を数える。live で同時に返事を作る数（Claude を呼ぶ数）を抑える */
export class ConcurrencyLimiter {
  readonly #max: number;
  #running = 0;

  constructor(max: number) {
    this.#max = max;
  }

  get running(): number {
    return this.#running;
  }

  /** 1つ分を取る。空きがなければ null。取れたら、終わったときに返す関数を返す */
  tryAcquire(): (() => void) | null {
    if (this.#running >= this.#max) return null;
    this.#running += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#running -= 1;
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
