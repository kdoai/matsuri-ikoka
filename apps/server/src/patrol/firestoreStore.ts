import {
  type GuideNotice,
  type IsoDate,
  type Itinerary,
  ItinerarySchema,
  MAX_NOTICES_PER_TRIP,
  TripWatchSchema,
} from "@matsuri-ikoka/schema";
import type { DocumentSnapshot, Firestore } from "firebase-admin/firestore";
import { errorForLog } from "../log";
import { isDocumentId } from "../storage/owner";
import { tripOwner } from "../storage/types";
import { type AddNoticeResult, type DeliveryClaim, newRecord, type PatrolStore } from "./store";
import type { PatrolRecord, PatrolRun, WatchedTrip } from "./types";

// 見回りの保存の口の Firestore の実装。読み書きはサーバーだけが Admin SDK で行う（firestore.rules で外からは断る）。
// patrols と patrolRuns の中身は JSON の文字列（state）で持つ。行のハッシュの配列を索引に載せないため。
// patrolRuns.expiresAt・patrolDeliveries.expiresAt・notices.expiresAt は TTL ポリシーで消す時刻。

const PATROLS = "patrols";
const RUNS = "patrolRuns";
const DELIVERIES = "patrolDeliveries";
const ITINERARIES = "itineraries";
const VERSIONS = "versions";
const NOTICES = "notices";
const WATCH_GROUP = "watch";
const WATCH_DOC = "current";

/** watch の文書のパスから、持ち主と旅を取り出す。形が違えば null */
function tripPathOf(path: string): { uid: string; tripId: string; ref: string } | null {
  const match = /^users\/([^/]+)\/trips\/([^/]+)\/watch\/current$/.exec(path);
  if (match === null) return null;
  const [, uid = "", tripId = ""] = match;
  return { uid, tripId, ref: `users/${uid}/trips/${tripId}` };
}

function stateOf<T>(snapshot: DocumentSnapshot): T | null {
  const state = snapshot.data()?.state;
  return typeof state === "string" ? (JSON.parse(state) as T) : null;
}

function millis(value: unknown): number {
  const toMillis = (value as { toMillis?: unknown } | null)?.toMillis;
  return typeof toMillis === "function" ? Number(toMillis.call(value)) : 0;
}

function versionDocId(version: number): string {
  return String(version).padStart(6, "0");
}

export class FirestorePatrolStore implements PatrolStore {
  readonly #db: Firestore;

  constructor(db: Firestore) {
    this.#db = db;
  }

  #patrol(key: string) {
    return this.#db.collection(PATROLS).doc(key);
  }

  #run(patrolId: string) {
    return this.#db.collection(RUNS).doc(patrolId);
  }

  async listWatchedTrips(limit: number): Promise<WatchedTrip[]> {
    const snapshot = await this.#db
      .collectionGroup(WATCH_GROUP)
      .where("status", "==", "active")
      .limit(limit)
      .get();
    return snapshot.docs.flatMap((doc) => {
      const path = doc.id === WATCH_DOC ? tripPathOf(doc.ref.path) : null;
      if (path === null) return [];
      // 決まった項目だけを取り出す。ほかの項目があっても、依頼の形は変えない
      const { tripId, status, startedAt, endsOn, stoppedAt, lastCheckedAt } = doc.data();
      const watch = TripWatchSchema.safeParse({
        tripId,
        status,
        startedAt,
        endsOn,
        stoppedAt,
        lastCheckedAt,
      });
      if (!watch.success || watch.data.tripId !== path.tripId) {
        console.warn(JSON.stringify({ kind: "patrol_watch_invalid" }));
        return [];
      }
      return [{ ref: path.ref, watch: watch.data }];
    });
  }

  async readItinerary(trip: WatchedTrip): Promise<Itinerary | null> {
    const match = /^users\/([^/]+)\/trips\/([^/]+)$/.exec(trip.ref);
    if (match === null) return null;
    const [, uid = "", tripId = ""] = match;
    if (!isDocumentId(tripId)) return null;
    const head = await this.#db.collection(ITINERARIES).doc(tripId).get();
    const data = head.data();
    if (data === undefined) return null;
    // 依頼のパスの利用者の旅でなければ、読まない
    const owner = tripOwner({
      ownerUid: typeof data.ownerUid === "string" ? data.ownerUid : null,
      consultOwnerUid: typeof data.consultOwnerUid === "string" ? data.consultOwnerUid : null,
    });
    if (owner !== uid || typeof data.version !== "number") return null;
    const version = await head.ref.collection(VERSIONS).doc(versionDocId(data.version)).get();
    const json = version.data()?.itinerary;
    if (typeof json !== "string") return null;
    try {
      const parsed = ItinerarySchema.safeParse(JSON.parse(json));
      return parsed.success ? parsed.data : null;
    } catch (error) {
      console.warn(JSON.stringify({ kind: "patrol_itinerary_unreadable", ...errorForLog(error) }));
      return null;
    }
  }

  async addNotice(
    trip: WatchedTrip,
    notice: GuideNotice,
    expiresAt: number,
  ): Promise<AddNoticeResult> {
    const notices = this.#db.doc(trip.ref).collection(NOTICES);
    const doc = notices.doc(notice.id);
    return this.#db.runTransaction(async (tx): Promise<AddNoticeResult> => {
      if ((await tx.get(doc)).exists) return "duplicate";
      const existing = await tx.get(notices.select().limit(MAX_NOTICES_PER_TRIP));
      if (existing.size >= MAX_NOTICES_PER_TRIP) return "full";
      tx.create(doc, { ...notice, expiresAt: new Date(expiresAt) });
      return "created";
    });
  }

  async readRecord(key: string): Promise<PatrolRecord | null> {
    return stateOf<PatrolRecord>(await this.#patrol(key).get());
  }

  async listRecordKeys(limit: number): Promise<string[]> {
    const snapshot = await this.#db.collection(PATROLS).select().limit(limit).get();
    return snapshot.docs.map((doc) => doc.id);
  }

  async acquireLease(
    key: string,
    seed: { festivalId: string; date: IsoDate },
    holder: string,
    now: number,
    ttlMs: number,
  ): Promise<PatrolRecord | null> {
    const doc = this.#patrol(key);
    return this.#db.runTransaction(async (tx) => {
      const record = stateOf<PatrolRecord>(await tx.get(doc)) ?? newRecord(key, seed, null);
      if (record.lease !== null && record.lease.holder !== holder && record.lease.expiresAt > now) {
        return null;
      }
      const next = { ...record, lease: { holder, expiresAt: now + ttlMs } };
      tx.set(doc, { state: JSON.stringify(next), updatedAt: new Date(now) });
      return next;
    });
  }

  async renewLease(key: string, holder: string, now: number, ttlMs: number): Promise<boolean> {
    const doc = this.#patrol(key);
    return this.#db.runTransaction(async (tx) => {
      const record = stateOf<PatrolRecord>(await tx.get(doc));
      if (record?.lease?.holder !== holder) return false;
      const next = { ...record, lease: { holder, expiresAt: now + ttlMs } };
      tx.set(doc, { state: JSON.stringify(next), updatedAt: new Date(now) });
      return true;
    });
  }

  async saveRecord(key: string, holder: string, record: PatrolRecord): Promise<boolean> {
    const doc = this.#patrol(key);
    return this.#db.runTransaction(async (tx) => {
      const current = stateOf<PatrolRecord>(await tx.get(doc));
      if (current?.lease?.holder !== holder) return false;
      tx.set(doc, { state: JSON.stringify(record), updatedAt: new Date() });
      return true;
    });
  }

  async deleteRecord(key: string, now: number): Promise<boolean> {
    const doc = this.#patrol(key);
    return this.#db.runTransaction(async (tx) => {
      const snapshot = await tx.get(doc);
      if (!snapshot.exists) return false;
      const lease = stateOf<PatrolRecord>(snapshot)?.lease;
      if (lease !== undefined && lease !== null && lease.expiresAt > now) return false;
      tx.delete(doc);
      return true;
    });
  }

  async createRun(run: PatrolRun, expiresAt: number): Promise<void> {
    await this.#run(run.patrolId).create({
      state: JSON.stringify(run),
      status: run.status,
      createdAt: new Date(run.createdAt),
      expiresAt: new Date(expiresAt),
    });
  }

  async readRun(patrolId: string): Promise<PatrolRun | null> {
    if (!isDocumentId(patrolId)) return null;
    return stateOf<PatrolRun>(await this.#run(patrolId).get());
  }

  async updateRun(patrolId: string, patch: Partial<PatrolRun>): Promise<void> {
    const doc = this.#run(patrolId);
    await this.#db.runTransaction(async (tx) => {
      const run = stateOf<PatrolRun>(await tx.get(doc));
      if (run === null) return;
      const next = { ...run, ...patch };
      tx.update(doc, { state: JSON.stringify(next), status: next.status });
    });
  }

  async claimRun(
    patrolId: string,
    holder: string,
    now: number,
    ttlMs: number,
  ): Promise<PatrolRun | null> {
    if (!isDocumentId(patrolId)) return null;
    const doc = this.#run(patrolId);
    return this.#db.runTransaction(async (tx) => {
      const run = stateOf<PatrolRun>(await tx.get(doc));
      if (run === null || run.status !== "open") return null;
      if (run.claim !== null && run.claim.holder !== holder && run.claim.expiresAt > now) {
        return null;
      }
      const next: PatrolRun = { ...run, claim: { holder, expiresAt: now + ttlMs } };
      tx.update(doc, { state: JSON.stringify(next) });
      return next;
    });
  }

  async listOpenRuns(limit: number): Promise<PatrolRun[]> {
    const snapshot = await this.#db
      .collection(RUNS)
      .where("status", "==", "open")
      .limit(limit)
      .get();
    return snapshot.docs.flatMap((doc) => {
      const run = stateOf<PatrolRun>(doc);
      return run === null ? [] : [run];
    });
  }

  async claimDelivery(
    id: string,
    now: number,
    ttlMs: number,
    expiresAt: number,
  ): Promise<DeliveryClaim> {
    if (!isDocumentId(id)) return "duplicate";
    const doc = this.#db.collection(DELIVERIES).doc(id);
    return this.#db.runTransaction(async (tx): Promise<DeliveryClaim> => {
      const data = (await tx.get(doc)).data();
      if (data !== undefined && (data.done === true || millis(data.until) > now)) {
        return "duplicate";
      }
      tx.set(doc, { done: false, until: new Date(now + ttlMs), expiresAt: new Date(expiresAt) });
      return "claimed";
    });
  }

  async finishDelivery(id: string): Promise<void> {
    await this.#db.collection(DELIVERIES).doc(id).update({ done: true });
  }

  async releaseDelivery(id: string): Promise<void> {
    await this.#db.collection(DELIVERIES).doc(id).delete();
  }
}
