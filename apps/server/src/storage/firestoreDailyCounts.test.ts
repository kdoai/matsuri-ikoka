import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DAILY_COUNTS_TTL_MS, MemoryDailyCountStore } from "./dailyCounts";
import { FirestoreDailyCountStore } from "./firestoreDailyCounts";

// Firestore のエミュレーターがあるときだけ回す（FIRESTORE_EMULATOR_HOST。docs/spec/account.md の「手元で動かす」）。
// Admin SDK は読み込みに時間がかかるので、エミュレーターがあるときだけ読み込む
const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const db = emulator
  ? await (async () => {
      const { initializeApp } = await import("firebase-admin/app");
      const { getFirestore } = await import("firebase-admin/firestore");
      return getFirestore(initializeApp({ projectId: "demo-matsuri-ikoka" }, "daily-counts"));
    })()
  : null;

describe.skipIf(db === null)("FirestoreDailyCountStore（エミュレーター）", () => {
  if (db === null) return;

  it("同時に足しても数を落とさず、期限を付けて残す", async () => {
    const now = Date.UTC(2026, 7, 3);
    const store = new FirestoreDailyCountStore(db, { now: () => now });
    const scope = `chat${randomUUID().slice(0, 8)}`;

    await Promise.all(Array.from({ length: 30 }, () => store.add(scope, "2026-08-03", "k1")));
    await store.add(scope, "2026-08-03", "k2");

    expect(await store.load(scope, "2026-08-03")).toEqual(
      new Map([
        ["k1", 30],
        ["k2", 1],
      ]),
    );
    const saved = (await db.doc(`dailyLimits/${scope}-2026-08-03`).get()).data();
    expect(saved?.expiresAt.toMillis()).toBe(now + DAILY_COUNTS_TTL_MS);
    expect(await store.load(scope, "2026-08-04")).toEqual(new Map());
  });

  it("メモリの実装と同じ数を読む", async () => {
    const firestore = new FirestoreDailyCountStore(db);
    const memory = new MemoryDailyCountStore();
    const scope = `client${randomUUID().slice(0, 8)}`;
    const keys = ["a", "b", "a", "c", "a", "b"];

    for (const key of keys) {
      await firestore.add(scope, "2026-08-03", key);
      await memory.add(scope, "2026-08-03", key);
    }

    expect(await firestore.load(scope, "2026-08-03")).toEqual(
      await memory.load(scope, "2026-08-03"),
    );
  });
});
