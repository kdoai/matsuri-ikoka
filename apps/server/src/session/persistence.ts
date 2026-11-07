import {
  AnchorPlanSchema,
  type ConversationStage,
  type Itinerary,
  ItinerarySchema,
  TripAnchorSchema,
} from "@matsuri-ikoka/schema";
import { errorForLog } from "../log";
import { type OwnerId, ownerIdOf } from "../storage/owner";
import {
  isShareId,
  type OwnerTripStorage,
  type SessionSnapshot,
  type TripStorage,
} from "../storage/types";
import type { ItineraryStore, Session, SessionStore } from "./sessionStore";

// 相談と旅程を、保存の口（storage/）に残す。
// - 旅程：ツールが手元の写し（ItineraryStore）に保存するたびに、版を保存の口に書く。同じ旅程の書き込みは順に並べる
// - 相談：作ったときと、返事を作り終えたときに、途中の状態（条件・旅程の ID・段階など）を書く。会話の文章は書かない
// - 別のインスタンスに届いた相談は、保存の口から戻してから返事を作る
// 保存の口に書けなくても、相談はこのインスタンスのメモリで続ける（ログに残す）。

/** 保存の口から読んだ旅程を、いまの形で確かめる。前の形で保存したものは undefined */
export function parseStoredItinerary(value: unknown): Itinerary | undefined {
  const parsed = ItinerarySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function snapshotOf(session: Session, now: number): SessionSnapshot {
  return {
    id: session.id,
    ownerUid: session.ownerUid,
    createdAt: session.createdAt,
    updatedAt: now,
    stage: session.stage,
    conditions: session.conditions,
    preferences: session.preferences,
    candidates: session.candidates,
    selectedFestivalId: session.selectedFestivalId,
    itineraryId: session.itineraryId,
    anchor: session.anchor,
    anchorPlan: session.anchorPlan,
    anchorCheck: session.anchorCheck,
    cancelledAnchor: session.cancelledAnchor,
    replay: session.replay,
  };
}

/** 旅程を読めない相談の段階。旅程がある前提の段階からは、聞き取りか候補へ戻す */
function stageWithoutItinerary(saved: SessionSnapshot): ConversationStage {
  if (saved.stage === "hearing" || saved.stage === "candidates") return saved.stage;
  return saved.candidates.length > 0 ? "candidates" : "hearing";
}

/** 保存の口から読んだアンカーを、いまの形で確かめる。前の形のものは捨てる（組み立ては次の発言で計算し直す） */
function currentAnchorState(saved: SessionSnapshot): SessionSnapshot {
  const anchor = TripAnchorSchema.safeParse(saved.anchor);
  const plan = AnchorPlanSchema.safeParse(saved.anchorPlan);
  return {
    ...saved,
    anchor: anchor.success ? anchor.data : null,
    anchorPlan: anchor.success && plan.success ? plan.data : null,
  };
}

export class StoragePersistence {
  readonly #storage: TripStorage;
  readonly #sessions: SessionStore | undefined;
  readonly #itineraries: ItineraryStore;
  readonly #now: () => number;
  /** 旅程の ID → 書き込みの途中の Promise（同じ旅程の版を順に書く） */
  readonly #pending = new Map<string, Promise<void>>();

  constructor(deps: {
    storage: TripStorage;
    itineraries: ItineraryStore;
    sessions?: SessionStore;
    now?: () => number;
  }) {
    this.#storage = deps.storage;
    this.#sessions = deps.sessions;
    this.#itineraries = deps.itineraries;
    this.#now = deps.now ?? Date.now;
    deps.itineraries.onSave((itinerary, owner) => this.#writeItinerary(itinerary, owner));
  }

  /** 持ち主を決めて、利用者の旅の口を受け取る */
  forOwner(owner: OwnerId): OwnerTripStorage {
    return this.#storage.forOwner(owner);
  }

  #writeItinerary(itinerary: Itinerary, owner: OwnerId | null): void {
    const previous = this.#pending.get(itinerary.id) ?? Promise.resolve();
    const next = previous
      .then(() => this.#storage.saveItinerary(itinerary, owner))
      .catch((error: unknown) => {
        console.error(
          JSON.stringify({ kind: "storage_failed", what: "itinerary", ...errorForLog(error) }),
        );
      })
      .finally(() => {
        if (this.#pending.get(itinerary.id) === next) this.#pending.delete(itinerary.id);
      });
    this.#pending.set(itinerary.id, next);
  }

  /** この旅程の、このインスタンスからの書き込みが終わるのを待つ（id を省くとすべて） */
  async flush(itineraryId?: string): Promise<void> {
    if (itineraryId !== undefined) {
      await this.#pending.get(itineraryId);
      return;
    }
    await Promise.all(this.#pending.values());
  }

  /**
   * ID から、いまの形の旅程を読む。読めるのは、共有の ID、持ち主のない旅程の ID、
   * viewer（確かめた利用者）自身の旅程の ID だけ。ほかの人の旅程は、ないものとして扱う
   */
  async readItinerary(id: string, viewer: OwnerId | null): Promise<Itinerary | undefined> {
    await this.flush(id);
    if (isShareId(id)) {
      const shared = await this.#storage.readShare(id);
      return shared === null ? undefined : parseStoredItinerary(shared.itinerary);
    }
    const unowned = await this.#storage.readUnowned(id);
    if (unowned !== null) return parseStoredItinerary(unowned.itinerary);
    if (viewer === null) return undefined;
    const own = await this.#storage.forOwner(viewer).getTrip(id);
    return own === null ? undefined : parseStoredItinerary(own.itinerary);
  }

  /**
   * 相談を引く。メモリになければ保存の口から戻し、その相談の旅程も手元の写しに置く。
   * 見つからなければ undefined。viewer は持ち主のない相談を開いた利用者で、その人の旅程なら戻せる。
   * 読めない旅程（消した・ほかの人の・前の形）は相談から外し、相談は旅程のないものとして続ける
   */
  async load(sessionId: string, viewer: OwnerId | null = null): Promise<Session | undefined> {
    if (this.#sessions === undefined) return undefined;
    const inMemory = this.#sessions.get(sessionId);
    if (inMemory !== undefined) return inMemory;
    let saved: SessionSnapshot | null;
    try {
      saved = await this.#storage.getSession(sessionId);
    } catch (error) {
      console.error(
        JSON.stringify({ kind: "storage_failed", what: "session_read", ...errorForLog(error) }),
      );
      return undefined;
    }
    if (saved === null) return undefined;
    // 保存した相談の持ち主は、書くときに確かめた利用者なので、そのまま持ち主に戻す
    const ownerUid = saved.ownerUid ? ownerIdOf(saved.ownerUid) : null;
    if (saved.itineraryId !== null && this.#itineraries.get(saved.itineraryId) === undefined) {
      const itinerary = await this.#readForRestore(saved.itineraryId, ownerUid ?? viewer);
      if (itinerary === undefined) {
        return this.#sessions.restore({
          ...currentAnchorState(saved),
          ownerUid,
          itineraryId: null,
          stage: stageWithoutItinerary(saved),
        });
      }
      this.#itineraries.remember(itinerary);
    }
    return this.#sessions.restore({ ...currentAnchorState(saved), ownerUid });
  }

  /** 戻す相談の旅程を読む。読みに失敗したら、読めない旅程と同じに扱う（相談は止めない） */
  async #readForRestore(id: string, viewer: OwnerId | null): Promise<Itinerary | undefined> {
    try {
      return await this.readItinerary(id, viewer);
    } catch (error) {
      console.error(
        JSON.stringify({ kind: "storage_failed", what: "itinerary_read", ...errorForLog(error) }),
      );
      return undefined;
    }
  }

  /**
   * 相談の途中の状態を書く。別のインスタンスが続きを受けたときに旅程を読めるよう、旅程の書き込みを先に終える。
   * 失敗してもログに残すだけにする
   */
  async saveSession(session: Session): Promise<void> {
    if (session.itineraryId !== null) await this.flush(session.itineraryId);
    try {
      await this.#storage.saveSession(snapshotOf(session, this.#now()));
    } catch (error) {
      console.error(
        JSON.stringify({ kind: "storage_failed", what: "session", ...errorForLog(error) }),
      );
    }
  }
}
