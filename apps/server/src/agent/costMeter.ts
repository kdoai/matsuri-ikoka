import { AsyncLocalStorage } from "node:async_hooks";

// ツールの中で動かす1回きりの query() の費用を、呼んだ発言の費用に足す。
// ガイドの費用の上限は、ツールの中の調べの費用も含めて数える（docs/spec/guide.md の「失敗の扱い」）。
// 調べの部品はどの発言から呼ばれたかを知らないので、ツールを動かすときに測る先を文脈で渡す。

export class CostMeter {
  #usd = 0;

  get usd(): number {
    return this.#usd;
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
