import type { Firestore } from "firebase-admin/firestore";
import { isDocumentId } from "./owner";

// 1日の相談の回数の数え（routes/guard.ts の DailyLimiter）を残す口。
// インスタンスが止まって起動し直しても、その日の数を読み戻して、上限を数え直さないようにする。
//
//   dailyLimits/{枠}-{日}   counts（数えるキーごとの回数）・expiresAt
//
// キーは IP と利用者の ID からハッシュで作ったもので、IP や利用者の ID そのものは残さない（DailyLimiter が作る）。
// 日付が変わったら要らないので、2日で消す。

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

const DAILY_LIMITS = "dailyLimits";

function countsOf(data: Record<string, unknown> | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  const raw = data?.counts;
  if (typeof raw !== "object" || raw === null) return counts;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) counts.set(key, value);
  }
  return counts;
}

/** Firestore に残す。読み書きはサーバーだけが Admin SDK で行う（firestore.rules はブラウザからの読み書きを断る） */
export class FirestoreDailyCountStore implements DailyCountStore {
  readonly #db: Firestore;
  readonly #now: () => number;

  constructor(db: Firestore, options: { now?: () => number } = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
  }

  #doc(scope: string, day: string) {
    const id = `${scope}-${day}`;
    if (!isDocumentId(id)) throw new Error("保存の置き場の ID の形が正しくありません");
    return this.#db.collection(DAILY_LIMITS).doc(id);
  }

  async load(scope: string, day: string): Promise<Map<string, number>> {
    return countsOf((await this.#doc(scope, day).get()).data());
  }

  async add(scope: string, day: string, key: string): Promise<void> {
    const doc = this.#doc(scope, day);
    await this.#db.runTransaction(async (tx) => {
      const counts = countsOf((await tx.get(doc)).data());
      counts.set(key, (counts.get(key) ?? 0) + 1);
      tx.set(doc, {
        counts: Object.fromEntries(counts),
        expiresAt: new Date(this.#now() + DAILY_COUNTS_TTL_MS),
      });
    });
  }
}
