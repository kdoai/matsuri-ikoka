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
   * 相談を開く。ない相談も、ほかの人の相談も undefined を返し、呼ぶ側では区別できない。
   * 持ち主のない相談をログインした人が使ったら、その人の相談にする
   */
  async open(sessionId: string, viewer: OwnerId | null): Promise<Session | undefined> {
    const session = await this.#persistence.load(sessionId);
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
