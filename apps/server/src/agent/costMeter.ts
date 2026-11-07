import { AsyncLocalStorage } from "node:async_hooks";

// ツールの中で動かす1回きりの query() の費用を、呼んだ発言の費用に足し、今日の残りで抑える。
// ガイドの費用の上限は、ツールの中の調べの費用も含めて数える（docs/spec/guide.md の「費用と回数の上限」）。
// 調べの部品はどの発言から呼ばれたかを知らないので、ツールを動かすときに測る先を文脈で渡す。

export class CostMeter {
  readonly #limitUsd: number | null;
  #usd = 0;

  /** limitUsd は、ツールの中の調べに使ってよい費用（米ドル）。省くと抑えない */
  constructor(limitUsd: number | null = null) {
    this.#limitUsd = limitUsd;
  }

  get usd(): number {
    return this.#usd;
  }

  /** まだ使える費用。抑えないときは null */
  get remainingUsd(): number | null {
    return this.#limitUsd === null ? null : this.#limitUsd - this.#usd;
  }

  add(usd: number): void {
    if (Number.isFinite(usd) && usd > 0) this.#usd += usd;
  }
}

const current = new AsyncLocalStorage<CostMeter>();

/** fn の中で動いた1回きりの query() の費用を、meter に足す */
export function withCostMeter<T>(meter: CostMeter, fn: () => T): T {
  return current.run(meter, fn);
}

/** 1回きりの query() の費用を、いまの測る先に足す。測る先がなければ何もしない */
export function chargeCost(usd: number): void {
  current.getStore()?.add(usd);
}

/** 1回きりの query() に使ってよい費用。抑えないときは null */
export function remainingCostBudget(): number | null {
  return current.getStore()?.remainingUsd ?? null;
}
