// 1日の相談の回数の数え（routes/guard.ts の DailyLimiter）を残す口。
// インスタンスが止まって起動し直しても、その日の数を読み戻して、上限を数え直さないようにする。
//
//   dailyLimits/{枠}-{日}   counts（数えるキーごとの回数）・expiresAt
//
// キーは IP と利用者の ID から作った仮名のキー（DailyLimiter が作る）。日付が変わったら要らないので、2日で消す。
// Firestore の実装は firestoreDailyCounts.ts にある（Admin SDK を読み込むので、使うときだけ読み込む）。

/** 1日の回数の数えを残す期間。日付が変わったら要らない */
export const DAILY_COUNTS_TTL_MS = 2 * 24 * 60 * 60 * 1000;

export interface DailyCountStore {
  /** その日の、枠のキーごとの回数 */
  load(scope: string, day: string): Promise<Map<string, number>>;
  /** その日の、枠のキーの回数を1つ足す */
  add(scope: string, day: string, key: string): Promise<void>;
}

/** テストと手元用。メモリに置く */
export class MemoryDailyCountStore implements DailyCountStore {
  readonly #docs = new Map<string, Map<string, number>>();

  async load(scope: string, day: string): Promise<Map<string, number>> {
    return new Map(this.#docs.get(`${scope}-${day}`) ?? []);
  }

  async add(scope: string, day: string, key: string): Promise<void> {
    const id = `${scope}-${day}`;
    const counts = this.#docs.get(id) ?? new Map<string, number>();
    counts.set(key, (counts.get(key) ?? 0) + 1);
    this.#docs.set(id, counts);
  }
}
