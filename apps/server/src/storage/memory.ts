import { randomBytes } from "node:crypto";
import type { Itinerary } from "@matsuri-ikoka/schema";
import type { OwnerId } from "./owner";
import {
  type ClaimResult,
  type CreatedShare,
  MAX_VERSIONS,
  type OwnerTripStorage,
  SESSION_STATE_TTL_MS,
  type SessionSnapshot,
  SHARE_REUSE_MIN_REMAINING_MS,
  SHARE_TTL_MS,
  type SharedItinerary,
  type StoredTrip,
  type StoredTripDetail,
  summarize,
  type TripStorage,
  tripOwner,
} from "./types";

// メモリの保存の口。テストと、Firestore を用意していない手元で使う。
// 再起動で消え、インスタンスどうしでは分け合えない。数の上限を超えたら古いものから消す。

/** メモリに置く旅程・共有・相談の、それぞれの数の上限 */
export const MAX_MEMORY_ENTRIES = 5_000;

interface ItineraryEntry {
  head: StoredTrip;
  /** 版 → 旅程の JSON */
  versions: Map<number, string>;
}

interface ShareEntry {
  itineraryId: string;
  ownerUid: string | null;
  version: number;
  json: string;
  expiresAt: number;
}

/** 推測できない共有の ID */
export function newShareId(): string {
  return `sh-${randomBytes(18).toString("base64url")}`;
}

/** 古いもの（先に入れたもの）から消して、数を上限に収める */
function trim<V>(map: Map<string, V>, max: number): void {
  for (const key of map.keys()) {
    if (map.size <= max) break;
    map.delete(key);
  }
}

export class MemoryTripStorage implements TripStorage {
  readonly kind = "memory";
  readonly #itineraries = new Map<string, ItineraryEntry>();
  readonly #shares = new Map<string, ShareEntry>();
  readonly #sessions = new Map<
    string,
    { json: string; updatedAt: number; ownerUid: string | null }
  >();
  readonly #now: () => number;
  readonly #max: number;

  constructor(options: { now?: () => number; max?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#max = options.max ?? MAX_MEMORY_ENTRIES;
  }

  /** 残されていない旅程は、最後の保存から30日で消える */
  #alive(entry: ItineraryEntry | undefined): ItineraryEntry | undefined {
    if (entry === undefined) return undefined;
    if (entry.head.ownerUid === null && this.#now() - entry.head.updatedAt > SHARE_TTL_MS) {
      this.#itineraries.delete(entry.head.itineraryId);
      return undefined;
    }
    return entry;
  }

  #owned(uid: string, itineraryId: string): ItineraryEntry | undefined {
    const entry = this.#alive(this.#itineraries.get(itineraryId));
    return entry !== undefined && tripOwner(entry.head) === uid ? entry : undefined;
  }

  forOwner(owner: OwnerId): OwnerTripStorage {
    return {
      owner,
      claimTrip: (itineraryId) => this.#claimTrip(owner, itineraryId),
      listTrips: () => this.#listTrips(owner),
      getTrip: (itineraryId, version) => this.#getTrip(owner, itineraryId, version),
      deleteTrip: (itineraryId) => this.#deleteTrip(owner, itineraryId),
      deleteAllTrips: () => this.#deleteAllTrips(owner),
      createShare: (itineraryId) => this.#createShare(owner, itineraryId),
    };
  }

  async saveItinerary(itinerary: Itinerary, consultOwner: OwnerId | null): Promise<void> {
    const now = this.#now();
    const existing = this.#alive(this.#itineraries.get(itinerary.id));
    const entry: ItineraryEntry = existing ?? {
      head: {
        itineraryId: itinerary.id,
        ownerUid: null,
        consultOwnerUid: null,
        title: "",
        date: null,
        version: itinerary.version,
        createdAt: now,
        updatedAt: now,
      },
      versions: new Map(),
    };
    entry.versions.set(itinerary.version, JSON.stringify(itinerary));
    for (const version of [...entry.versions.keys()].sort((a, b) => a - b)) {
      if (entry.versions.size <= MAX_VERSIONS) break;
      entry.versions.delete(version);
    }
    if (itinerary.version >= entry.head.version || existing === undefined) {
      entry.head = { ...entry.head, ...summarize(itinerary), version: itinerary.version };
    }
    entry.head.updatedAt = now;
    entry.head.consultOwnerUid ??= consultOwner;
    // 保存した順を保つ（上限で消すのは、いちばん長く保存されていない旅程から）
    this.#itineraries.delete(itinerary.id);
    this.#itineraries.set(itinerary.id, entry);
    trim(this.#itineraries, this.#max);
  }

  async readShare(shareId: string): Promise<SharedItinerary | null> {
    const share = this.#shares.get(shareId);
    if (share === undefined) return null;
    if (this.#now() > share.expiresAt) {
      this.#shares.delete(shareId);
      return null;
    }
    return {
      itineraryId: share.itineraryId,
      version: share.version,
      itinerary: JSON.parse(share.json),
    };
  }

  async readUnowned(itineraryId: string): Promise<SharedItinerary | null> {
    const entry = this.#alive(this.#itineraries.get(itineraryId));
    if (entry === undefined || tripOwner(entry.head) !== null) return null;
    if (this.#now() - entry.head.updatedAt > SHARE_TTL_MS) return null;
    const json = entry.versions.get(entry.head.version);
    if (json === undefined) return null;
    return { itineraryId, version: entry.head.version, itinerary: JSON.parse(json) };
  }

  async #claimTrip(uid: string, itineraryId: string): Promise<ClaimResult> {
    const entry = this.#alive(this.#itineraries.get(itineraryId));
    if (entry === undefined) return { status: "not_found" };
    const owner = tripOwner(entry.head);
    if (owner !== null && owner !== uid) return { status: "not_found" };
    entry.head.ownerUid = uid;
    return { status: "saved", trip: { ...entry.head } };
  }

  async #listTrips(uid: string): Promise<StoredTrip[]> {
    return [...this.#itineraries.values()]
      .filter((entry) => entry.head.ownerUid === uid)
      .map((entry) => ({ ...entry.head }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async #getTrip(
    uid: string,
    itineraryId: string,
    version?: number,
  ): Promise<StoredTripDetail | null> {
    const entry = this.#owned(uid, itineraryId);
    if (entry === undefined) return null;
    const wanted = version ?? entry.head.version;
    const json = entry.versions.get(wanted);
    if (json === undefined) return null;
    return {
      trip: { ...entry.head },
      versions: [...entry.versions.keys()].sort((a, b) => a - b),
      version: wanted,
      itinerary: JSON.parse(json),
    };
  }

  #removeTrip(itineraryId: string): void {
    this.#itineraries.delete(itineraryId);
    for (const [id, share] of this.#shares) {
      if (share.itineraryId === itineraryId) this.#shares.delete(id);
    }
  }

  async #deleteTrip(uid: string, itineraryId: string): Promise<boolean> {
    if (this.#owned(uid, itineraryId) === undefined) return false;
    this.#removeTrip(itineraryId);
    return true;
  }

  async #deleteAllTrips(uid: string): Promise<number> {
    const kept = (await this.#listTrips(uid)).length;
    // 期限を過ぎた残す前の旅程も消すので、期限は見ず、見出しの持ち主で選ぶ
    for (const entry of [...this.#itineraries.values()]) {
      if (tripOwner(entry.head) === uid) this.#removeTrip(entry.head.itineraryId);
    }
    // 旅を消したあとに残った、この利用者の共有も消す
    for (const [id, share] of this.#shares) {
      if (share.ownerUid === uid) this.#shares.delete(id);
    }
    return kept;
  }

  async #createShare(uid: string, itineraryId: string): Promise<CreatedShare | null> {
    const entry = this.#owned(uid, itineraryId);
    const json = entry?.versions.get(entry.head.version);
    if (entry === undefined || json === undefined) return null;
    const now = this.#now();
    for (const [shareId, share] of this.#shares) {
      const same =
        share.itineraryId === itineraryId && share.ownerUid === uid && share.json === json;
      if (same && share.expiresAt - now >= SHARE_REUSE_MIN_REMAINING_MS) {
        return { shareId, expiresAt: share.expiresAt };
      }
    }
    const shareId = newShareId();
    const expiresAt = now + SHARE_TTL_MS;
    this.#shares.set(shareId, {
      itineraryId,
      ownerUid: uid,
      version: entry.head.version,
      json,
      expiresAt,
    });
    trim(this.#shares, this.#max);
    return { shareId, expiresAt };
  }

  async saveSession(snapshot: SessionSnapshot): Promise<void> {
    const ownerUid = this.#sessions.get(snapshot.id)?.ownerUid ?? snapshot.ownerUid ?? null;
    this.#sessions.delete(snapshot.id);
    this.#sessions.set(snapshot.id, {
      json: JSON.stringify({ ...snapshot, ownerUid }),
      updatedAt: snapshot.updatedAt,
      ownerUid,
    });
    trim(this.#sessions, this.#max);
  }

  async getSession(id: string): Promise<SessionSnapshot | null> {
    const entry = this.#sessions.get(id);
    if (entry === undefined) return null;
    if (this.#now() - entry.updatedAt > SESSION_STATE_TTL_MS) {
      this.#sessions.delete(id);
      return null;
    }
    return JSON.parse(entry.json) as SessionSnapshot;
  }
}
