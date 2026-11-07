import {
  type GuideNotice,
  type IsoDate,
  type Itinerary,
  MAX_NOTICES_PER_TRIP,
} from "@matsuri-ikoka/schema";
import { isFirmNotice, noticeToEvict } from "./notices";
import type { PatrolRecord, PatrolRun, WatchedTrip } from "./types";

// 見回りの保存の口。見回りに要るものだけを持つ狭い口にする。
//
//   users/{uid}/trips/{旅の ID}/watch/current   見回りの依頼（読むだけ。書くのはガイドの API）
//   users/{uid}/trips/{旅の ID}/notices/{ID}    通知（足すだけ。お知らせは種類ごとに畳む）
//   patrols/{祭りの ID}_{開催日}                 ページの比較の控え・調べた時刻・実行権。利用者の情報を持たない
//   patrolRuns/{見回りの ID}                     実行の記録。利用者の情報を持たない
//   patrolDeliveries/{配信の ID}                 Webhook の配信の受け取りの印
//
// 持ち主を型で分ける forOwner の口は使わない。見回りは、頼まれた旅を横断して読む裏の処理で、
// 利用者の操作から呼ばれない。旅の置き場を指す値（WatchedTrip.ref）は、この口の中でだけ使う。

/**
 * created 足した / replaced 同じ種類のお知らせを畳んだ / duplicate 同じ変化の通知がある /
 * full 上限に達して足せない / not_watching 依頼がない、または止められた旅なので足さない
 */
export type AddNoticeResult = "created" | "replaced" | "duplicate" | "full" | "not_watching";
export type DeliveryClaim = "claimed" | "duplicate";

export interface PatrolStore {
  /** 見回り中の旅。上限まで */
  listWatchedTrips(limit: number): Promise<WatchedTrip[]>;
  /** 旅のいまの旅程。読めなければ null */
  readItinerary(trip: WatchedTrip): Promise<Itinerary | null>;
  /** その旅に届いている通知 */
  listNotices(trip: WatchedTrip): Promise<GuideNotice[]>;
  /**
   * 通知を足す。依頼が見回り中のときだけ書く（旅を消したあとや止めたあとに書かない）。
   * 上限に達したら、開催の変更と中止だけは、古いお知らせか読んだ通知を押し出して足す
   */
  addNotice(trip: WatchedTrip, notice: GuideNotice, expiresAt: number): Promise<AddNoticeResult>;

  readRecord(key: string): Promise<PatrolRecord | null>;
  listRecordKeys(limit: number): Promise<string[]>;
  /** 実行権を取る。ほかの実行が持っていて切れていなければ null。切れた実行権は引き継ぐ */
  acquireLease(
    key: string,
    seed: { festivalId: string; date: IsoDate },
    holder: string,
    now: number,
    ttlMs: number,
  ): Promise<PatrolRecord | null>;
  /** 実行権を延ばす。もう持っていなければ false（作業をやめる） */
  renewLease(key: string, holder: string, now: number, ttlMs: number): Promise<boolean>;
  /** 実行権を持っているときだけ保存する。持っていなければ false */
  saveRecord(key: string, holder: string, record: PatrolRecord): Promise<boolean>;
  /** 控えを消す。ほかの実行が実行権を持っていれば消さない */
  deleteRecord(key: string, now: number): Promise<boolean>;

  createRun(run: PatrolRun, expiresAt: number): Promise<void>;
  readRun(patrolId: string): Promise<PatrolRun | null>;
  /** 実行の記録を更新する（セッションの ID、結果） */
  updateRun(patrolId: string, patch: Partial<PatrolRun>): Promise<void>;
  /** 結果の受け取りを始める。終わっている、またはほかの実行が受け取っていれば null */
  claimRun(patrolId: string, holder: string, now: number, ttlMs: number): Promise<PatrolRun | null>;
  listOpenRuns(limit: number): Promise<PatrolRun[]>;
  /** 終わったのに、セッションをまだ消していない実行 */
  listRunsToDispose(limit: number): Promise<PatrolRun[]>;

  /** 配信の受け取りを始める。終わった配信と、受け取っている途中の配信は duplicate */
  claimDelivery(id: string, now: number, ttlMs: number, expiresAt: number): Promise<DeliveryClaim>;
  finishDelivery(id: string): Promise<void>;
  /** 失敗した配信を放す。再送で受け取り直せる */
  releaseDelivery(id: string): Promise<void>;
}

/** 新しい控え */
export function newRecord(
  key: string,
  seed: { festivalId: string; date: IsoDate },
  lease: PatrolRecord["lease"],
): PatrolRecord {
  return {
    key,
    festivalId: seed.festivalId,
    date: seed.date,
    observed: null,
    cancelled: false,
    postponed: false,
    changeCount: 0,
    seenBaselines: [],
    undelivered: [],
    pages: [],
    lastCheckedAt: null,
    nextCheckAt: 0,
    failures: 0,
    groupFailures: 0,
    pending: null,
    lease,
  };
}

const clone = <T>(value: T): T => structuredClone(value);

/** メモリの保存の口。開発とテストで使う。再起動で消える */
export class MemoryPatrolStore implements PatrolStore {
  readonly #trips = new Map<string, { trip: WatchedTrip; itinerary: Itinerary | null }>();
  readonly #notices = new Map<string, Map<string, GuideNotice>>();
  readonly #records = new Map<string, PatrolRecord>();
  readonly #runs = new Map<string, PatrolRun>();
  readonly #deliveries = new Map<string, { done: boolean; until: number }>();

  /** 見回りの依頼を足す（依頼を書く API の代わり） */
  putWatchedTrip(trip: WatchedTrip, itinerary: Itinerary | null): void {
    this.#trips.set(trip.ref, { trip: clone(trip), itinerary: clone(itinerary) });
  }

  /** 依頼を消す（旅を消したとき） */
  removeWatchedTrip(ref: string): void {
    this.#trips.delete(ref);
  }

  /** その旅の通知（テストと開発で確かめるため） */
  noticesOf(ref: string): GuideNotice[] {
    return [...(this.#notices.get(ref)?.values() ?? [])].map(clone);
  }

  async listWatchedTrips(limit: number): Promise<WatchedTrip[]> {
    return [...this.#trips.values()]
      .filter(({ trip }) => trip.watch.status === "active")
      .slice(0, limit)
      .map(({ trip }) => clone(trip));
  }

  async readItinerary(trip: WatchedTrip): Promise<Itinerary | null> {
    return clone(this.#trips.get(trip.ref)?.itinerary ?? null);
  }

  async listNotices(trip: WatchedTrip): Promise<GuideNotice[]> {
    return this.noticesOf(trip.ref);
  }

  async addNotice(trip: WatchedTrip, notice: GuideNotice): Promise<AddNoticeResult> {
    if (this.#trips.get(trip.ref)?.trip.watch.status !== "active") return "not_watching";
    const notices = this.#notices.get(trip.ref) ?? new Map<string, GuideNotice>();
    const existing = notices.get(notice.id);
    if (existing !== undefined) {
      if (existing.fingerprint === notice.fingerprint || notice.content.kind !== "announcement") {
        return "duplicate";
      }
      notices.set(notice.id, clone({ ...notice, proposalId: existing.proposalId }));
      return "replaced";
    }
    if (notices.size >= MAX_NOTICES_PER_TRIP) {
      if (!isFirmNotice(notice)) return "full";
      const victim = noticeToEvict(
        [...notices.values()].map((item) => ({
          id: item.id,
          kind: item.content.kind,
          createdAt: item.createdAt,
          readAt: item.readAt,
        })),
      );
      if (victim === null) return "full";
      notices.delete(victim);
    }
    notices.set(notice.id, clone(notice));
    this.#notices.set(trip.ref, notices);
    return "created";
  }

  async readRecord(key: string): Promise<PatrolRecord | null> {
    return clone(this.#records.get(key) ?? null);
  }

  async listRecordKeys(limit: number): Promise<string[]> {
    return [...this.#records.keys()].slice(0, limit);
  }

  async acquireLease(
    key: string,
    seed: { festivalId: string; date: IsoDate },
    holder: string,
    now: number,
    ttlMs: number,
  ): Promise<PatrolRecord | null> {
    const record = this.#records.get(key) ?? newRecord(key, seed, null);
    if (record.lease !== null && record.lease.holder !== holder && record.lease.expiresAt > now) {
      return null;
    }
    record.lease = { holder, expiresAt: now + ttlMs };
    this.#records.set(key, record);
    return clone(record);
  }

  async renewLease(key: string, holder: string, now: number, ttlMs: number): Promise<boolean> {
    const record = this.#records.get(key);
    if (record?.lease?.holder !== holder) return false;
    record.lease = { holder, expiresAt: now + ttlMs };
    return true;
  }

  async saveRecord(key: string, holder: string, record: PatrolRecord): Promise<boolean> {
    if (this.#records.get(key)?.lease?.holder !== holder) return false;
    this.#records.set(key, clone(record));
    return true;
  }

  async deleteRecord(key: string, now: number): Promise<boolean> {
    const lease = this.#records.get(key)?.lease;
    if (lease !== undefined && lease !== null && lease.expiresAt > now) return false;
    return this.#records.delete(key);
  }

  async createRun(run: PatrolRun): Promise<void> {
    this.#runs.set(run.patrolId, clone(run));
  }

  async readRun(patrolId: string): Promise<PatrolRun | null> {
    return clone(this.#runs.get(patrolId) ?? null);
  }

  async updateRun(patrolId: string, patch: Partial<PatrolRun>): Promise<void> {
    const run = this.#runs.get(patrolId);
    if (run !== undefined) this.#runs.set(patrolId, { ...run, ...clone(patch) });
  }

  async claimRun(
    patrolId: string,
    holder: string,
    now: number,
    ttlMs: number,
  ): Promise<PatrolRun | null> {
    const run = this.#runs.get(patrolId);
    if (run === undefined || run.status !== "open") return null;
    if (run.claim !== null && run.claim.holder !== holder && run.claim.expiresAt > now) return null;
    run.claim = { holder, expiresAt: now + ttlMs };
    return clone(run);
  }

  async listOpenRuns(limit: number): Promise<PatrolRun[]> {
    return [...this.#runs.values()]
      .filter((run) => run.status === "open")
      .slice(0, limit)
      .map(clone);
  }

  async listRunsToDispose(limit: number): Promise<PatrolRun[]> {
    return [...this.#runs.values()]
      .filter((run) => run.needsDisposal && run.status !== "open")
      .slice(0, limit)
      .map(clone);
  }

  async claimDelivery(id: string, now: number, ttlMs: number): Promise<DeliveryClaim> {
    const delivery = this.#deliveries.get(id);
    if (delivery !== undefined && (delivery.done || delivery.until > now)) return "duplicate";
    this.#deliveries.set(id, { done: false, until: now + ttlMs });
    return "claimed";
  }

  async finishDelivery(id: string): Promise<void> {
    this.#deliveries.set(id, { done: true, until: 0 });
  }

  async releaseDelivery(id: string): Promise<void> {
    this.#deliveries.delete(id);
  }
}
