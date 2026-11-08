import {
  AnchorPlanSchema,
  type ConversationStage,
  GuideMemoItemSchema,
  GuideNoticeSchema,
  GuideProposalSchema,
  GuideResumeSummarySchema,
  type Itinerary,
  ItinerarySchema,
  TripAnchorSchema,
  TripWatchSchema,
} from "@matsuri-ikoka/schema";
import { z } from "zod";
import { sessionRetentionUntil } from "../domain/retention";
import { errorForLog } from "../log";
import { type OwnerId, ownerIdOf } from "../storage/owner";
import {
  isShareId,
  lastDateOf,
  type OwnerTripStorage,
  type SessionSnapshot,
  type TripStorage,
} from "../storage/types";
import {
  type ItineraryStore,
  newSessionGuide,
  type Session,
  type SessionGuide,
  type SessionStore,
} from "./sessionStore";

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

/** 保存するガイドの状態の形。Agent SDK の会話の ID と費用は、インスタンスの中だけのものなので残さない */
const SavedGuideSchema = z.strictObject({
  resume: GuideResumeSummarySchema,
  memo: z.array(GuideMemoItemSchema),
  notices: z.array(GuideNoticeSchema),
  proposals: z.array(GuideProposalSchema),
  watch: TripWatchSchema.nullable(),
  replayedTurns: z.array(z.number().int().nonnegative()),
  replaySeeded: z.boolean(),
});

/** ガイドと話していなければ、保存の項目を増やさない */
function savedGuide(guide: SessionGuide): z.infer<typeof SavedGuideSchema> | undefined {
  const { agentSessionId: _id, agentCostUsd: _cost, ...saved } = guide;
  const unused =
    saved.resume.turns === 0 &&
    saved.memo.length === 0 &&
    saved.notices.length === 0 &&
    saved.proposals.length === 0 &&
    saved.watch === null &&
    !saved.replaySeeded;
  return unused ? undefined : saved;
}

/** 保存の口から読んだガイドの状態を、いまの形で確かめる。前の形のものは捨てて、話し始めからにする */
function restoredGuide(saved: unknown): SessionGuide {
  const parsed = SavedGuideSchema.safeParse(saved);
  return parsed.success ? { ...newSessionGuide(), ...parsed.data } : newSessionGuide();
}

export function snapshotOf(session: Session, now: number): SessionSnapshot {
  const guide = savedGuide(session.guide);
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
    ...(guide === undefined ? {} : { guide }),
  };
}

/** 旅程を読めない相談の段階。旅程がある前提の段階からは、聞き取りか候補へ戻す */
function stageWithoutItinerary(
  saved: Pick<SessionSnapshot, "stage" | "candidates">,
): ConversationStage {
  if (saved.stage === "hearing" || saved.stage === "candidates") return saved.stage;
  return saved.candidates.length > 0 ? "candidates" : "hearing";
}

/** 保存の口から読んだアンカーを、いまの形で確かめる。前の形のものは捨てる（組み立ては次の発言で計算し直す） */
function currentAnchorState(saved: SessionSnapshot): SessionSnapshot & { guide: SessionGuide } {
  const anchor = TripAnchorSchema.safeParse(saved.anchor);
  const plan = AnchorPlanSchema.safeParse(saved.anchorPlan);
  return {
    ...saved,
    anchor: anchor.success ? anchor.data : null,
    anchorPlan: anchor.success && plan.success ? plan.data : null,
    guide: restoredGuide(saved.guide),
  };
}

/**
 * ガイドが読む旅。kept は、その人が残した旅か（残した旅のデータだけを、旅の下に置く）。
 * none は保存の口に旅がない（消された）。unreadable は旅はあるが読めない形（消されたとは限らない）
 */
export type GuideTripRead =
  | { status: "found"; itinerary: Itinerary; kept: boolean }
  | { status: "none" }
  | { status: "unreadable" };

export class StoragePersistence {
  readonly #storage: TripStorage;
  readonly #sessions: SessionStore | undefined;
  readonly #itineraries: ItineraryStore;
  readonly #now: () => number;
  /** 旅程の ID → 書き込みの途中の Promise（同じ旅程の版を順に書く） */
  readonly #pending = new Map<string, Promise<void>>();
  /** 書き込みの途中の相談。すべて消す前に待ち、消したあとに戻らないようにする */
  readonly #pendingSessions = new Set<Promise<void>>();

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

  /**
   * 開いた相談の旅程の、手元の写し。相談を開く（load）と、読める旅程は写しに置かれる。
   * 相談の持ち主と確かめたあとの、その相談の旅程の ID にだけ使う
   */
  itineraryOf(itineraryId: string): Itinerary | undefined {
    return this.#itineraries.get(itineraryId);
  }

  /**
   * 旅を消す前に呼ぶ。その旅を指す相談に印を付けて流している返事を止め、手元の写しと相談の中のガイドのデータを捨てる。
   * 印のある間は旅程を保存しないので、返事の途中に消しても旅は作り直されない。
   * 相談の旅程は、次の発言の前に外す（releaseDeletedTrip）。ガイドの入口で「旅が消された」と分かるよう、それまで残す。
   * 持ち主と確かめた旅だけに呼ぶ
   */
  async forgetTrip(itineraryId: string): Promise<void> {
    this.#itineraries.forget(itineraryId);
    for (const session of this.#sessions?.matching((s) => s.itineraryId === itineraryId) ?? []) {
      const { agentSessionId, agentCostUsd } = session.guide;
      session.guide = { ...newSessionGuide(), agentSessionId, agentCostUsd };
      session.tripDeleted = true;
      session.stopTurn?.();
      await this.saveSession(session);
    }
  }

  /**
   * 利用者が消した旅を指す相談から、旅程を外す。発言とこだわりの変更の前に呼ぶ。
   * 消した旅が次の発言で作り直されないようにし、相談は聞き取りか候補の段階から旅程のないものとして続ける
   */
  async releaseDeletedTrip(session: Session): Promise<void> {
    if (!session.tripDeleted) return;
    session.tripDeleted = false;
    session.stage = stageWithoutItinerary(session);
    session.itineraryId = null;
    if (session.replay !== null) {
      // 記録の再生でも、消した旅の ID を使い回さない
      const { itineraryIds: _ids, ...replay } = session.replay;
      session.replay = replay;
    }
    await this.saveSession(session);
  }

  /**
   * すべて消す前に呼ぶ。その人の相談に印を付けて流している返事を止め、メモリから外す。
   * 印のある相談は、もう開けず、保存もしない。返事を作っている途中の相談は、返事が止まって保存しに来たときに外す
   */
  forgetOwner(owner: OwnerId): void {
    for (const session of this.#sessions?.matching((s) => s.ownerUid === owner) ?? []) {
      if (session.itineraryId !== null) this.#itineraries.forget(session.itineraryId);
      session.discarded = true;
      session.stopTurn?.();
      if (!session.busy) this.#sessions?.remove(session);
    }
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
    await Promise.all([...this.#pending.values(), ...this.#pendingSessions]);
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
   * しおりの URL（/shiori/{ID}）で出す旅程と、その URL で開ける期限（残した旅は null）。
   * readItinerary で読めるものに加え、持ち主が付く前に渡した旅程の ID の URL では、付く前の最新の版を出す
   * （付いたあとの版は、持ち主にしか見せない）
   */
  async readShioriItinerary(
    id: string,
    viewer: OwnerId | null,
  ): Promise<{ itinerary: Itinerary; expiresAt: number | null } | undefined> {
    await this.flush(id);
    const read = (stored: { itinerary: unknown; expiresAt: number | null } | null) => {
      if (stored === null) return undefined;
      const itinerary = parseStoredItinerary(stored.itinerary);
      return itinerary === undefined ? undefined : { itinerary, expiresAt: stored.expiresAt };
    };
    if (isShareId(id)) return read(await this.#storage.readShare(id));
    const unowned = await this.#storage.readUnowned(id);
    if (unowned !== null) return read(unowned);
    if (viewer !== null) {
      const own = await this.#storage.forOwner(viewer).getTrip(id);
      if (own !== null) return read({ itinerary: own.itinerary, expiresAt: own.trip.expiresAt });
    }
    return read(await this.#storage.readBeforeOwner(id));
  }

  /**
   * ガイドが読む旅を、保存の口から読む（別のインスタンスで版が増えていても、いまの版を読む）。
   * 読めるのは、viewer 自身の旅程と、持ち主のない旅程だけ。消した旅とほかの人の旅は undefined。
   * 保存の口の失敗は呼ぶ側に投げる
   */
  async readGuideTrip(id: string, viewer: OwnerId | null): Promise<GuideTripRead> {
    await this.flush(id);
    if (viewer !== null) {
      const own = await this.#storage.forOwner(viewer).getTrip(id);
      if (own !== null) {
        const itinerary = parseStoredItinerary(own.itinerary);
        return itinerary === undefined
          ? { status: "unreadable" }
          : { status: "found", itinerary, kept: own.trip.ownerUid === viewer };
      }
    }
    const unowned = await this.#storage.readUnowned(id);
    if (unowned === null) return { status: "none" };
    const itinerary = parseStoredItinerary(unowned.itinerary);
    return itinerary === undefined
      ? { status: "unreadable" }
      : { status: "found", itinerary, kept: false };
  }

  /**
   * ガイドが前の版に戻すときに、旅の版を指して読む。読めるのは readGuideTrip と同じく、
   * viewer 自身の旅程と、持ち主のない旅程だけ。残っていない版と読めない形は undefined
   */
  async readGuideTripVersion(
    id: string,
    viewer: OwnerId | null,
    version: number,
  ): Promise<Itinerary | undefined> {
    await this.flush(id);
    if (viewer !== null) {
      const own = await this.#storage.forOwner(viewer).getTrip(id, version);
      if (own !== null) {
        return own.version === version ? parseStoredItinerary(own.itinerary) : undefined;
      }
    }
    const unowned = await this.#storage.readUnowned(id, version);
    return unowned === null ? undefined : parseStoredItinerary(unowned.itinerary);
  }

  /**
   * 相談を引く。メモリになければ保存の口から戻し、その相談の旅程も手元の写しに置く。
   * 見つからなければ undefined。viewer は持ち主のない相談を開いた利用者で、その人の旅程なら戻せる。
   * 読めない旅程（消した・ほかの人の・前の形）は相談から外し、相談は旅程のないものとして続ける
   */
  async load(sessionId: string, viewer: OwnerId | null = null): Promise<Session | undefined> {
    if (this.#sessions === undefined) return undefined;
    const inMemory = this.#sessions.get(sessionId);
    if (inMemory?.discarded) return undefined;
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
    const write = this.#writeSession(session);
    this.#pendingSessions.add(write);
    await write.finally(() => this.#pendingSessions.delete(write));
  }

  async #writeSession(session: Session): Promise<void> {
    if (session.itineraryId !== null) await this.flush(session.itineraryId);
    // すべて消した相談は書かない。止まった返事の片付けで戻さない
    if (session.discarded) {
      this.#sessions?.remove(session);
      return;
    }
    try {
      const now = this.#now();
      // 旅程を持つ相談は、旅程と同じ期限まで残す（翌日以降も、その相談から旅を残し、続きを相談できる）
      const itinerary =
        session.itineraryId === null ? undefined : this.#itineraries.get(session.itineraryId);
      const trip =
        session.itineraryId === null
          ? null
          : { lastDate: itinerary === undefined ? null : lastDateOf(itinerary) };
      await this.#storage.saveSession({
        ...snapshotOf(session, now),
        expiresAt: sessionRetentionUntil(now, trip),
      });
    } catch (error) {
      console.error(
        JSON.stringify({ kind: "storage_failed", what: "session", ...errorForLog(error) }),
      );
    }
  }
}
