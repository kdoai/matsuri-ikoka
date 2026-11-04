import { randomBytes } from "node:crypto";
import {
  type ConversationStage,
  DEFAULT_PREFERENCES,
  type FestivalCandidate,
  type IsoDate,
  type Itinerary,
  type LodgingSearch,
  type NearbySpot,
  type PartialTripConditions,
  type Preferences,
  type Weather,
} from "@matsuri-ikoka/schema";

// 相談の状態。会話の状態・聞き取れた条件・こだわり・候補・旅程は、サーバーが持つ。
// 返事を作る間はメモリに置き、しばらく使われなかった相談は消す。
// 別のインスタンスでも相談を続けられるよう、途中の状態は保存の口にも残す（session/persistence.ts）。

/** 使われなくなった相談を消すまでの時間 */
export const SESSION_IDLE_MS = 6 * 60 * 60 * 1000;

export interface Session {
  id: string;
  createdAt: number;
  lastActiveAt: number;
  stage: ConversationStage;
  conditions: PartialTripConditions;
  preferences: Preferences;
  /** 最後に出した祭りの候補 */
  candidates: FestivalCandidate[];
  /** 利用者が選んだ祭り（寄り道を探した祭り） */
  selectedFestivalId: string | null;
  /** この相談の旅程の ID。保存した旅程は ItineraryStore にある */
  itineraryId: string | null;
  /** 調べた天気。キーは「祭りの ID@日付」 */
  weather: Map<string, Weather>;
  /** 調べた宿の空き。キーはチェックインの日。旅程を保存するとき、その日の泊まりに付ける */
  lodging: Map<IsoDate, LodgingSearch>;
  /** 周辺係が Web で調べて残した場所。キーは場所の ID（web-…）。旅程を保存するとき、祭りのデータの場所と同じく照らす */
  researchedSpots: Map<string, NearbySpot>;
  /** live：Agent SDK のセッション ID（resume に使う） */
  agentSessionId: string | null;
  /**
   * mock：再生しているサンプルの相談と、次に再生する発言の番号。
   * itineraryIds は、記録の旅程 ID からこの相談の旅程 ID への置き換え（相談どうしで旅程を取り違えないため）
   */
  replay: { sampleId: string; nextTurn: number; itineraryIds?: Record<string, string> } | null;
  /** 返答を作っている途中か。1つの相談で同時に返答は作らない */
  busy: boolean;
}

/** 推測されにくい ID（しおりの URL にも使う） */
export function randomId(prefix: string): string {
  return `${prefix}-${randomBytes(12).toString("base64url")}`;
}

/** メモリに置く相談の数の上限。超えたら、いちばん長く使われていない相談から消す */
export const MAX_SESSIONS = 1_000;
/** 共有のために置く旅程の期限（README の「共有のための旅程は30日で消す」） */
export const ITINERARY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** メモリに置く旅程の数の上限。超えたら、いちばん古く保存した旅程から消す */
export const MAX_ITINERARIES = 5_000;

export class SessionStore {
  /** 使った順（いちばん古いものが先頭）に並べる */
  readonly #sessions = new Map<string, Session>();
  readonly #now: () => number;
  readonly #max: number;
  readonly #onRemove: (session: Session) => void;

  /** onRemove は相談を消したときに呼ぶ（エージェントの会話の記録を消すのに使う） */
  constructor(
    options: { now?: () => number; max?: number; onRemove?: (session: Session) => void } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#max = options.max ?? MAX_SESSIONS;
    this.#onRemove = options.onRemove ?? (() => {});
  }

  get size(): number {
    return this.#sessions.size;
  }

  #remove(session: Session): void {
    this.#sessions.delete(session.id);
    this.#onRemove(session);
  }

  /** 上限なら、返事を作っている途中ではない、いちばん長く使われていない相談から消す */
  #makeRoom(): void {
    this.sweep();
    for (const oldest of this.#sessions.values()) {
      if (this.#sessions.size < this.#max) break;
      if (!oldest.busy) this.#remove(oldest);
    }
  }

  create(init: Partial<Pick<Session, "preferences" | "replay">> = {}): Session {
    this.#makeRoom();
    const now = this.#now();
    const session: Session = {
      id: randomId("s"),
      createdAt: now,
      lastActiveAt: now,
      stage: "hearing",
      conditions: {},
      preferences: { ...(init.preferences ?? DEFAULT_PREFERENCES) },
      candidates: [],
      selectedFestivalId: null,
      itineraryId: null,
      weather: new Map(),
      lodging: new Map(),
      researchedSpots: new Map(),
      agentSessionId: null,
      replay: init.replay ?? null,
      busy: false,
    };
    this.#sessions.set(session.id, session);
    return session;
  }

  /**
   * 保存の口に残した途中の状態から、相談をメモリに戻す。メモリにもうあれば、それを返す。
   * 天気・宿の空き・調べた寄り道と Agent SDK の会話は戻さない（エージェントは、相談の状態の要約から続ける）
   */
  restore(
    saved: Pick<
      Session,
      | "id"
      | "createdAt"
      | "stage"
      | "conditions"
      | "preferences"
      | "candidates"
      | "selectedFestivalId"
      | "itineraryId"
      | "replay"
    >,
  ): Session {
    const existing = this.get(saved.id);
    if (existing !== undefined) return existing;
    this.#makeRoom();
    const session: Session = {
      ...saved,
      lastActiveAt: this.#now(),
      weather: new Map(),
      lodging: new Map(),
      researchedSpots: new Map(),
      agentSessionId: null,
      busy: false,
    };
    this.#sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    const session = this.#sessions.get(id);
    if (session === undefined) return undefined;
    if (!session.busy && this.#now() - session.lastActiveAt > SESSION_IDLE_MS) {
      this.#remove(session);
      return undefined;
    }
    session.lastActiveAt = this.#now();
    // 使った相談を後ろへ移し、使った順を保つ
    this.#sessions.delete(id);
    this.#sessions.set(id, session);
    return session;
  }

  /** 使われなくなった相談を消す */
  sweep(): void {
    const now = this.#now();
    for (const session of [...this.#sessions.values()]) {
      if (!session.busy && now - session.lastActiveAt > SESSION_IDLE_MS) this.#remove(session);
    }
  }
}

/**
 * 相談で組んだ旅程の、このインスタンスの手元の写し。ツールとエージェントはここを読み書きする。
 * 版ごとではなく、最新の版だけを持つ。保存したら購読しているもの（保存の口に残す処理）に知らせる。
 * 最後に保存してから30日で消し、数の上限を超えたら古いものから消す
 */
export class ItineraryStore {
  /** 保存した順（いちばん古いものが先頭）に並べる */
  readonly #itineraries = new Map<string, { itinerary: Itinerary; savedAt: number }>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #listeners: ((itinerary: Itinerary) => void)[] = [];

  constructor(options: { now?: () => number; ttlMs?: number; max?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? ITINERARY_TTL_MS;
    this.#max = options.max ?? MAX_ITINERARIES;
  }

  get size(): number {
    return this.#itineraries.size;
  }

  /** 旅程を保存するたびに呼ぶ関数を足す */
  onSave(listener: (itinerary: Itinerary) => void): void {
    this.#listeners.push(listener);
  }

  save(itinerary: Itinerary): void {
    this.remember(itinerary);
    for (const listener of this.#listeners) listener(itinerary);
  }

  /** 保存の口から読んだ旅程を、手元の写しに置く（購読しているものには知らせない） */
  remember(itinerary: Itinerary): void {
    this.#itineraries.delete(itinerary.id);
    this.#itineraries.set(itinerary.id, { itinerary, savedAt: this.#now() });
    this.sweep();
    for (const id of this.#itineraries.keys()) {
      if (this.#itineraries.size <= this.#max) break;
      this.#itineraries.delete(id);
    }
  }

  get(id: string): Itinerary | undefined {
    const entry = this.#itineraries.get(id);
    if (entry === undefined) return undefined;
    if (this.#now() - entry.savedAt > this.#ttlMs) {
      this.#itineraries.delete(id);
      return undefined;
    }
    return entry.itinerary;
  }

  /** 期限を過ぎた旅程を消す */
  sweep(): void {
    const now = this.#now();
    for (const [id, entry] of this.#itineraries) {
      if (now - entry.savedAt > this.#ttlMs) this.#itineraries.delete(id);
    }
  }
}
