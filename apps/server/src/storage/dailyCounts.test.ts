import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DAILY_COUNTS_TTL_MS,
  FirestoreDailyCountStore,
  MemoryDailyCountStore,
} from "./dailyCounts";

describe("MemoryDailyCountStore", () => {
  it("枠と日ごとに、キーの回数を足して読む", async () => {
    const store = new MemoryDailyCountStore();
    await store.add("chat", "2026-08-03", "k1");
    await store.add("chat", "2026-08-03", "k1");
    await store.add("chat", "2026-08-04", "k1");
    await store.add("client", "2026-08-03", "k2");

    expect(await store.load("chat", "2026-08-03")).toEqual(new Map([["k1", 2]]));
    expect(await store.load("client", "2026-08-03")).toEqual(new Map([["k2", 1]]));
    expect(await store.load("trial", "2026-08-03")).toEqual(new Map());
  });
});

// Firestore のエミュレーターがあるときだけ回す（FIRESTORE_EMULATOR_HOST。docs/spec/account.md の「手元で動かす」）
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

    await Promise.all([1, 2, 3].map(() => store.add(scope, "2026-08-03", "k1")));
    await store.add(scope, "2026-08-03", "k2");

    expect(await store.load(scope, "2026-08-03")).toEqual(
      new Map([
        ["k1", 3],
        ["k2", 1],
      ]),
    );
    const saved = (await db.doc(`dailyLimits/${scope}-2026-08-03`).get()).data();
    expect(saved?.expiresAt.toMillis()).toBe(now + DAILY_COUNTS_TTL_MS);
    expect(await store.load(scope, "2026-08-04")).toEqual(new Map());
  });
});
