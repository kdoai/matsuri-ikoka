import { randomUUID } from "node:crypto";
import { MAX_NOTICES_PER_TRIP } from "@matsuri-ikoka/schema";
import { fictionalNotice, fictionalTripWatch } from "@matsuri-ikoka/schema/testing";
import { expect, it } from "vitest";
import type { PatrolStore } from "./store";
import type { PatrolRun, WatchedTrip } from "./types";

// 見回りの保存の口が満たすこと。メモリの実装と Firestore の実装（エミュレーター）の両方で同じテストを回す。
// Firestore ではテストどうしでデータを分けないので、ID は毎回新しく作る。

const NOW = Date.UTC(2026, 7, 10);
const TTL = 5 * 60 * 1000;

const seed = { festivalId: "suzunari-toro", date: "2026-08-16" };
const uniqueKey = () => `suzunari-toro-${randomUUID()}_2026-08-16`;

const trip = (): WatchedTrip => {
  const tripId = `trip-${randomUUID()}`;
  return {
    ref: `users/user-${randomUUID()}/trips/${tripId}`,
    watch: { ...fictionalTripWatch(), tripId },
  };
};

const run = (over: Partial<PatrolRun> = {}): PatrolRun => ({
  patrolId: `patrol-${randomUUID().replaceAll("-", "").slice(0, 16)}`,
  sessionId: null,
  status: "open",
  targets: [],
  createdAt: NOW,
  finishedAt: null,
  claim: null,
  failure: null,
  counts: {},
  costCents: null,
  ...over,
});

export function patrolStoreContract(make: () => PatrolStore): void {
  it("実行権は1つの実行だけが持てて、切れたら別の実行が引き継ぐ", async () => {
    const store = make();
    const key = uniqueKey();

    const first = await store.acquireLease(key, seed, "a", NOW, TTL);
    expect(first).toMatchObject({ key, festivalId: seed.festivalId, lease: { holder: "a" } });
    expect(await store.acquireLease(key, seed, "b", NOW + 1, TTL)).toBeNull();
    // 同じ実行は取り直せる
    expect(await store.acquireLease(key, seed, "a", NOW + 1, TTL)).not.toBeNull();

    const taken = await store.acquireLease(key, seed, "b", NOW + 1 + TTL + 1, TTL);
    expect(taken?.lease?.holder).toBe("b");
  });

  it("同時に取りに来ても、実行権を持てるのは1つだけ", async () => {
    const store = make();
    const key = uniqueKey();

    const results = await Promise.all(
      ["a", "b", "c"].map((holder) => store.acquireLease(key, seed, holder, NOW, TTL)),
    );

    expect(results.filter((result) => result !== null)).toHaveLength(1);
  });

  it("実行権を延ばせるのは、持っている実行だけ", async () => {
    const store = make();
    const key = uniqueKey();
    await store.acquireLease(key, seed, "a", NOW, TTL);

    expect(await store.renewLease(key, "b", NOW + 1, TTL)).toBe(false);
    expect(await store.renewLease(key, "a", NOW + TTL - 1, TTL)).toBe(true);
    expect(await store.acquireLease(key, seed, "b", NOW + TTL + 1, TTL)).toBeNull();
  });

  it("実行権を失った実行は保存できない", async () => {
    const store = make();
    const key = uniqueKey();
    const record = await store.acquireLease(key, seed, "a", NOW, TTL);
    await store.acquireLease(key, seed, "b", NOW + TTL + 1, TTL);

    if (record === null) throw new Error("実行権を取れませんでした");
    expect(await store.saveRecord(key, "a", { ...record, lastCheckedAt: 1 })).toBe(false);
    expect((await store.readRecord(key))?.lastCheckedAt).toBeNull();
  });

  it("保存した控えを読める。実行権を放すと別の実行が取れる", async () => {
    const store = make();
    const key = uniqueKey();
    const record = await store.acquireLease(key, seed, "a", NOW, TTL);
    if (record === null) throw new Error("実行権を取れませんでした");
    const page = {
      url: "https://example.com/suzunari/2026",
      lineHashes: ["0123456789abcdef"],
      pendingHashes: null,
      failures: 0,
      nextTryAt: 0,
    };

    expect(
      await store.saveRecord(key, "a", {
        ...record,
        pages: [page],
        lastCheckedAt: NOW,
        lease: null,
      }),
    ).toBe(true);

    expect(await store.readRecord(key)).toMatchObject({ pages: [page], lastCheckedAt: NOW });
    expect(await store.acquireLease(key, seed, "b", NOW + 1, TTL)).not.toBeNull();
  });

  it("実行権が残っている控えは消さない。一覧に出る", async () => {
    const store = make();
    const key = uniqueKey();
    await store.acquireLease(key, seed, "a", NOW, TTL);

    expect(await store.listRecordKeys(10_000)).toContain(key);
    expect(await store.deleteRecord(key, NOW + 1)).toBe(false);
    expect(await store.deleteRecord(key, NOW + TTL + 1)).toBe(true);
    expect(await store.readRecord(key)).toBeNull();
    expect(await store.deleteRecord(key, NOW + TTL + 1)).toBe(false);
  });

  it("同じ通知は2度足さない。上限に達した旅には足さない", async () => {
    const store = make();
    const target = trip();
    const notice = { ...fictionalNotice(), tripId: target.watch.tripId };

    expect(await store.addNotice(target, notice, NOW)).toBe("created");
    expect(await store.addNotice(target, notice, NOW)).toBe("duplicate");

    for (let i = 1; i < MAX_NOTICES_PER_TRIP; i += 1) {
      await store.addNotice(target, { ...notice, id: `n-${i}` }, NOW);
    }
    expect(await store.addNotice(target, { ...notice, id: "n-over" }, NOW)).toBe("full");
  });

  it("実行の記録を作り、受け取りは1つの実行に絞る", async () => {
    const store = make();
    const item = run();
    await store.createRun(item, NOW + TTL);

    expect((await store.listOpenRuns(10_000)).map((open) => open.patrolId)).toContain(
      item.patrolId,
    );
    expect(await store.claimRun(item.patrolId, "a", NOW, TTL)).toMatchObject({
      claim: { holder: "a" },
    });
    expect(await store.claimRun(item.patrolId, "b", NOW + 1, TTL)).toBeNull();
    expect(await store.claimRun(item.patrolId, "b", NOW + TTL + 1, TTL)).not.toBeNull();

    await store.updateRun(item.patrolId, {
      status: "done",
      sessionId: "session-1",
      counts: { notices: 2 },
    });

    expect(await store.readRun(item.patrolId)).toMatchObject({
      status: "done",
      sessionId: "session-1",
      counts: { notices: 2 },
    });
    expect((await store.listOpenRuns(10_000)).map((open) => open.patrolId)).not.toContain(
      item.patrolId,
    );
    expect(await store.claimRun(item.patrolId, "c", NOW + TTL * 3, TTL)).toBeNull();
  });

  it("ない実行は読めず、受け取れない", async () => {
    const store = make();

    expect(await store.readRun("patrol-ffffffffffffffff")).toBeNull();
    expect(await store.claimRun("patrol-ffffffffffffffff", "a", NOW, TTL)).toBeNull();
  });

  it("同じ配信は受け取らない。失敗して放した配信は受け取り直せる", async () => {
    const store = make();
    const id = `whe_${randomUUID()}`;

    expect(await store.claimDelivery(id, NOW, TTL, NOW + TTL)).toBe("claimed");
    expect(await store.claimDelivery(id, NOW + 1, TTL, NOW + TTL)).toBe("duplicate");

    await store.releaseDelivery(id);
    expect(await store.claimDelivery(id, NOW + 2, TTL, NOW + TTL)).toBe("claimed");

    // 途中で止まった配信は、印が切れたら受け取り直せる
    expect(await store.claimDelivery(id, NOW + TTL + 3, TTL, NOW + TTL)).toBe("claimed");

    await store.finishDelivery(id);
    expect(await store.claimDelivery(id, NOW + TTL * 3, TTL, NOW + TTL)).toBe("duplicate");
  });
}
