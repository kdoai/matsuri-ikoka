import { randomUUID } from "node:crypto";
import { type GuideNotice, MAX_NOTICES_PER_TRIP } from "@matsuri-ikoka/schema";
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

const newTrip = (): WatchedTrip => {
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
  needsDisposal: false,
  ...over,
});

export interface PatrolStoreSetup {
  store: PatrolStore;
  /** 見回りの依頼を置く */
  putWatch(trip: WatchedTrip): Promise<void>;
  /** 見回りの依頼を消す（旅を消したとき） */
  removeWatch(trip: WatchedTrip): Promise<void>;
}

export function patrolStoreContract(make: () => PatrolStoreSetup): void {
  it("実行権は1つの実行だけが持てて、切れたら別の実行が引き継ぐ", async () => {
    const { store } = make();
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
    const { store } = make();
    const key = uniqueKey();

    const results = await Promise.all(
      ["a", "b", "c"].map((holder) => store.acquireLease(key, seed, holder, NOW, TTL)),
    );

    expect(results.filter((result) => result !== null)).toHaveLength(1);
  });

  it("実行権を延ばせるのは、持っている実行だけ", async () => {
    const { store } = make();
    const key = uniqueKey();
    await store.acquireLease(key, seed, "a", NOW, TTL);

    expect(await store.renewLease(key, "b", NOW + 1, TTL)).toBe(false);
    expect(await store.renewLease(key, "a", NOW + TTL - 1, TTL)).toBe(true);
    expect(await store.acquireLease(key, seed, "b", NOW + TTL + 1, TTL)).toBeNull();
  });

  it("実行権を失った実行は保存できない", async () => {
    const { store } = make();
    const key = uniqueKey();
    const record = await store.acquireLease(key, seed, "a", NOW, TTL);
    await store.acquireLease(key, seed, "b", NOW + TTL + 1, TTL);

    if (record === null) throw new Error("実行権を取れませんでした");
    expect(await store.saveRecord(key, "a", { ...record, lastCheckedAt: 1 })).toBe(false);
    expect((await store.readRecord(key))?.lastCheckedAt).toBeNull();
  });

  it("保存した控えを読める。実行権を放すと別の実行が取れる", async () => {
    const { store } = make();
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
        changeCount: 2,
        lease: null,
      }),
    ).toBe(true);

    expect(await store.readRecord(key)).toMatchObject({
      pages: [page],
      lastCheckedAt: NOW,
      changeCount: 2,
      cancelled: false,
      groupFailures: 0,
    });
    expect(await store.acquireLease(key, seed, "b", NOW + 1, TTL)).not.toBeNull();
  });

  it("実行権が残っている控えは消さない。一覧に出る", async () => {
    const { store } = make();
    const key = uniqueKey();
    await store.acquireLease(key, seed, "a", NOW, TTL);

    expect(await store.listRecordKeys(10_000)).toContain(key);
    expect(await store.deleteRecord(key, NOW + 1)).toBe(false);
    expect(await store.deleteRecord(key, NOW + TTL + 1)).toBe(true);
    expect(await store.readRecord(key)).toBeNull();
    expect(await store.deleteRecord(key, NOW + TTL + 1)).toBe(false);
  });

  const noticeOf = (trip: WatchedTrip, over: Partial<GuideNotice> = {}): GuideNotice => ({
    ...fictionalNotice(),
    tripId: trip.watch.tripId,
    ...over,
  });
  const announcement = (trip: WatchedTrip, over: Partial<GuideNotice>): GuideNotice =>
    noticeOf(trip, {
      content: {
        kind: "announcement",
        festivalId: "suzunari-toro",
        date: "2026-08-16",
        topic: "other",
      },
      proposalId: null,
      ...over,
    });

  it("声かけを止めた依頼は、見回り中の一覧でも止めたまま読む", async () => {
    const { store, putWatch } = make();
    const quiet = newTrip();
    const plain = newTrip();
    await putWatch({ ...quiet, watch: { ...quiet.watch, reminders: false } });
    await putWatch(plain);

    const listed = await store.listWatchedTrips(2_000);
    expect(listed.find((trip) => trip.ref === quiet.ref)?.watch.reminders).toBe(false);
    const other = listed.find((trip) => trip.ref === plain.ref);
    expect(other).toBeDefined();
    expect(other?.watch.reminders).toBeUndefined();
  });

  it("同じ通知は2度足さない。足した通知を読める", async () => {
    const { store, putWatch } = make();
    const trip = newTrip();
    await putWatch(trip);
    const notice = noticeOf(trip);

    expect(await store.addNotice(trip, notice, NOW)).toBe("created");
    expect(await store.addNotice(trip, notice, NOW)).toBe("duplicate");

    expect(await store.listNotices(trip)).toEqual([notice]);
  });

  it("依頼がない旅、止めた旅には通知を書かない", async () => {
    const { store, putWatch, removeWatch } = make();
    const never = newTrip();
    expect(await store.addNotice(never, noticeOf(never), NOW)).toBe("not_watching");
    expect(await store.listNotices(never)).toEqual([]);

    const removed = newTrip();
    await putWatch(removed);
    await removeWatch(removed);
    expect(await store.addNotice(removed, noticeOf(removed), NOW)).toBe("not_watching");

    const stopped = newTrip();
    await putWatch({
      ...stopped,
      watch: { ...stopped.watch, status: "stopped", stoppedAt: "2026-08-10T06:00:00+09:00" },
    });
    expect(await store.addNotice(stopped, noticeOf(stopped), NOW)).toBe("not_watching");
  });

  it("同じ種類のお知らせは置き換えて畳み、付いている提案は残す", async () => {
    const { store, putWatch } = make();
    const trip = newTrip();
    await putWatch(trip);
    const first = announcement(trip, {
      id: "n-a-1",
      fingerprint: "0123456789abcdef",
      proposalId: "proposal-1",
    });
    const second = announcement(trip, { id: "n-a-1", fingerprint: "fedcba9876543210" });

    expect(await store.addNotice(trip, first, NOW)).toBe("created");
    expect(await store.addNotice(trip, first, NOW)).toBe("duplicate");
    expect(await store.addNotice(trip, second, NOW)).toBe("replaced");

    const notices = await store.listNotices(trip);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      fingerprint: "fedcba9876543210",
      proposalId: "proposal-1",
    });
  });

  it("上限に達したら、お知らせは足さず、開催の変更と中止は古いお知らせを押し出して足す", async () => {
    const { store, putWatch } = make();
    const trip = newTrip();
    await putWatch(trip);
    for (let i = 0; i < MAX_NOTICES_PER_TRIP; i += 1) {
      await store.addNotice(
        trip,
        announcement(trip, {
          id: `n-a-${i}`,
          createdAt: `2026-08-01T${String(i % 24).padStart(2, "0")}:${String(i).padStart(2, "0")}:00+09:00`,
        }),
        NOW,
      );
    }

    expect(await store.addNotice(trip, announcement(trip, { id: "n-a-over" }), NOW)).toBe("full");

    const firm = noticeOf(trip, {
      id: "n-firm",
      content: { kind: "cancellation", festivalId: "suzunari-toro", date: "2026-08-16" },
    });
    expect(await store.addNotice(trip, firm, NOW)).toBe("created");

    const notices = await store.listNotices(trip);
    expect(notices).toHaveLength(MAX_NOTICES_PER_TRIP);
    expect(notices.map((notice) => notice.id)).toContain("n-firm");
    expect(notices.map((notice) => notice.id)).not.toContain("n-a-0");
  }, 60_000);

  it("上限に達しても、役目を終えた声かけは未読でも押し出して、新しい声かけと中止を足す", async () => {
    const { store, putWatch } = make();
    const trip = newTrip();
    await putWatch(trip);
    const reminder = (id: string, createdAt: string): GuideNotice =>
      noticeOf(trip, {
        id,
        content: { kind: "reminder", slot: "eve", date: "2026-08-16", at: "18:00", itemId: null },
        proposalId: null,
        createdAt,
      });
    // 届けたばかりの声かけ（いまの時刻）と、役目を終えた声かけ（ずっと前）
    const fresh = new Date().toISOString();
    for (let i = 0; i < MAX_NOTICES_PER_TRIP - 2; i += 1) {
      await store.addNotice(trip, noticeOf(trip, { id: `n-${i}` }), NOW);
    }
    await store.addNotice(trip, reminder("n-r-spent-1", "2026-08-01T00:00:00+09:00"), NOW);
    await store.addNotice(trip, reminder("n-r-spent-2", "2026-08-02T00:00:00+09:00"), NOW);

    expect(await store.addNotice(trip, reminder("n-r-new", fresh), NOW)).toBe("created");
    const firm = noticeOf(trip, {
      id: "n-firm",
      content: { kind: "cancellation", festivalId: "suzunari-toro", date: "2026-08-16" },
    });
    expect(await store.addNotice(trip, firm, NOW)).toBe("created");
    // 役目を終えた声かけがなくなれば、届けたばかりの声かけも、新しい声かけも押し出さない
    expect(await store.addNotice(trip, reminder("n-r-later", fresh), NOW)).toBe("full");

    const ids = (await store.listNotices(trip)).map((notice) => notice.id);
    expect(ids).toHaveLength(MAX_NOTICES_PER_TRIP);
    expect(ids).toEqual(expect.arrayContaining(["n-r-new", "n-firm"]));
    expect(ids).not.toContain("n-r-spent-1");
    expect(ids).not.toContain("n-r-spent-2");
  }, 60_000);

  it("上限まで未読の確かな通知なら、新しい通知も足せない", async () => {
    const { store, putWatch } = make();
    const trip = newTrip();
    await putWatch(trip);
    for (let i = 0; i < MAX_NOTICES_PER_TRIP; i += 1) {
      await store.addNotice(trip, noticeOf(trip, { id: `n-${i}` }), NOW);
    }

    expect(await store.addNotice(trip, noticeOf(trip, { id: "n-over" }), NOW)).toBe("full");
  }, 60_000);

  it("実行の記録を作り、受け取りは1つの実行に絞る", async () => {
    const { store } = make();
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

  it("終わったのにセッションを消していない実行を一覧にする", async () => {
    const { store } = make();
    const item = run({ sessionId: "session-1" });
    await store.createRun(item, NOW + TTL);
    const listed = async () => (await store.listRunsToDispose(10_000)).map((left) => left.patrolId);

    // 動いている間は出ない
    await store.updateRun(item.patrolId, { needsDisposal: true });
    expect(await listed()).not.toContain(item.patrolId);

    await store.updateRun(item.patrolId, { status: "done" });
    expect(await listed()).toContain(item.patrolId);

    await store.updateRun(item.patrolId, { needsDisposal: false });
    expect(await listed()).not.toContain(item.patrolId);
  });

  it("ない実行は読めず、受け取れない", async () => {
    const { store } = make();

    expect(await store.readRun("patrol-ffffffffffffffff")).toBeNull();
    expect(await store.claimRun("patrol-ffffffffffffffff", "a", NOW, TTL)).toBeNull();
  });

  it("同じ配信は受け取らない。失敗して放した配信は受け取り直せる", async () => {
    const { store } = make();
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
