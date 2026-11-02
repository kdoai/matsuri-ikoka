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

/** 1日（日本の日付）の相談の回数を数える。上限がなければ数えるだけ */
export class DailyLimiter {
  readonly #limit: number | null;
  readonly #today: () => IsoDate;
  #day: IsoDate | null = null;
  #count = 0;

  constructor(limit: number | null, today: () => IsoDate) {
    this.#limit = limit;
    this.#today = today;
  }

  /** 1回分を使う。上限に達していれば false */
  consume(): boolean {
    const today = this.#today();
    if (this.#day !== today) {
      this.#day = today;
      this.#count = 0;
    }
    if (this.#limit !== null && this.#count >= this.#limit) return false;
    this.#count += 1;
    return true;
  }
}
