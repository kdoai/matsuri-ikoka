import type { ConversationStage, Itinerary } from "@matsuri-ikoka/schema";
import type { OwnerId } from "../storage/owner";
import type { StoragePersistence } from "./persistence";
import type { Session, SessionStore } from "./sessionStore";

// 相談の入口。経路は相談をここからしか受け取らない（docs/spec/account.md の「相談の持ち主」）。
// ログインして使った相談は、その利用者に結びつける。一度決まった持ち主は変わらない。
// ログインなしの相談は、推測できない ID を知っている人が続けられる。

export class Consultations {
  readonly #sessions: SessionStore;
  readonly #persistence: StoragePersistence;

  constructor(deps: { sessions: SessionStore; persistence: StoragePersistence }) {
    this.#sessions = deps.sessions;
    this.#persistence = deps.persistence;
  }

  /** 相談を始める。ログインしていれば、はじめからその利用者の相談にする */
  async start(owner: OwnerId | null, replay: Session["replay"]): Promise<Session> {
    const session = this.#sessions.create({ replay, ownerUid: owner });
    await this.#persistence.saveSession(session);
    return session;
  }

  /**
   * 持ち主が残した旅（持ち主と確かめた旅程）から、続きを相談できる新しい相談を始める。
   * 旅程の条件（出発地・帰り・同行者・予算）とこだわりを相談に戻し、確定した旅程ならしおりの段階から続ける。
   * stage を渡すと、その段階から続ける（ガイドは、しおりのあとの旅として開く）
   */
  async resumeTrip(
    owner: OwnerId,
    itinerary: Itinerary,
    options: { stage?: ConversationStage } = {},
  ): Promise<Session> {
    const session = this.#sessions.create({ replay: null, ownerUid: owner });
    session.itineraryId = itinerary.id;
    session.selectedFestivalId = itinerary.mainFestivalId;
    const { verification } = itinerary;
    const handed =
      (verification.status === "as_planned" || verification.status === "needs_check") &&
      verification.sources.length > 0;
    session.stage = options.stage ?? (handed ? "shiori" : "itinerary");
    session.preferences = itinerary.preferences;
    // 組み直しや提案を、今の旅程の条件で確かめられるようにする
    session.conditions = {
      origin: itinerary.origin,
      returnTo: itinerary.returnTo,
      party: itinerary.party,
      ...(itinerary.budget === undefined ? {} : { budget: itinerary.budget }),
    };
    await this.#persistence.saveSession(session);
    return session;
  }

  /**
   * 相談を開く。ない相談も、ほかの人の相談も undefined を返し、呼ぶ側では区別できない。
   * 持ち主のない相談をログインした人が使ったら、その人の相談にする
   */
  async open(sessionId: string, viewer: OwnerId | null): Promise<Session | undefined> {
    const session = await this.#persistence.load(sessionId, viewer);
    if (session === undefined) return undefined;
    if (session.ownerUid === null) {
      if (viewer !== null) {
        session.ownerUid = viewer;
        await this.#persistence.saveSession(session);
      }
      return session;
    }
    return session.ownerUid === viewer ? session : undefined;
  }
}
