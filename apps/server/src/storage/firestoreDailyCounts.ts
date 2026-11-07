import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { DAILY_COUNTS_TTL_MS, type DailyCountStore } from "./dailyCounts";
import { isDocumentId } from "./owner";

// 1日の相談の回数の数えを Firestore に残す。読み書きはサーバーだけが Admin SDK で行う
// （firestore.rules はブラウザからの読み書きを断る）。
//
//   dailyLimits/{枠}-{日}   counts（数えるキーごとの回数）・expiresAt
//
// 足すときは文書を読まずに、キーの回数だけを1回の書き込みで増やす。相談が同時に入っても、
// 取り合いで書き込みがやり直しになって数え漏れることがない。
// counts のキーは IP の数だけ増えるので、索引から外す（scripts/setup-firestore.sh）。

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
    await this.#doc(scope, day).set(
      {
        counts: { [key]: FieldValue.increment(1) },
        expiresAt: new Date(this.#now() + DAILY_COUNTS_TTL_MS),
      },
      { merge: true },
    );
  }
}
