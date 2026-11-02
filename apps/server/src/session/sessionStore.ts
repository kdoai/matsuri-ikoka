import { randomBytes } from "node:crypto";
import {
  type ConversationStage,
  DEFAULT_PREFERENCES,
  type FestivalCandidate,
  type Itinerary,
  type PartialTripConditions,
  type Preferences,
  type Weather,
} from "@matsuri-ikoka/schema";

// 相談の状態。会話の状態・聞き取れた条件・こだわり・候補・旅程は、サーバーが持つ。
// メモリだけに置き、しばらく使われなかった相談は消す。

/** 使われなくなった相談を消すまでの時間 */
const SESSION_IDLE_MS = 6 * 60 * 60 * 1000;

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

export class SessionStore {
  readonly #sessions = new Map<string, Session>();
  readonly #now: () => number;
  readonly #onRemove: (session: Session) => void;

  /** onRemove は相談を消したときに呼ぶ（エージェントの会話の記録を消すのに使う） */
  constructor(options: { now?: () => number; onRemove?: (session: Session) => void } = {}) {
    this.#now = options.now ?? Date.now;
    this.#onRemove = options.onRemove ?? (() => {});
  }

  #remove(session: Session): void {
    this.#sessions.delete(session.id);
    this.#onRemove(session);
  }

  create(init: Partial<Pick<Session, "preferences" | "replay">> = {}): Session {
    this.sweep();
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
      agentSessionId: null,
      replay: init.replay ?? null,
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

/** 保存した旅程。しおりの URL から読む。版ごとではなく、最新の版だけを持つ */
export class ItineraryStore {
  readonly #itineraries = new Map<string, Itinerary>();

  save(itinerary: Itinerary): void {
    this.#itineraries.set(itinerary.id, itinerary);
  }

  get(id: string): Itinerary | undefined {
    return this.#itineraries.get(id);
  }
}
