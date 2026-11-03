import { randomBytes } from "node:crypto";
import type { Itinerary } from "@matsuri-ikoka/schema";
import {
  type ClaimResult,
  type CreatedShare,
  MAX_VERSIONS,
  SESSION_STATE_TTL_MS,
  type SessionSnapshot,
  SHARE_TTL_MS,
  type SharedItinerary,
  type StoredTrip,
  type StoredTripDetail,
  summarize,
  type TripStorage,
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
  readonly #sessions = new Map<string, { json: string; updatedAt: number }>();
  readonly #now: () => number;
  readonly #max: number;

  constructor(options: { now?: () => number; max?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#max = options.max ?? MAX_MEMORY_ENTRIES;
  }

  /** 持ち主のない旅程は、最後の保存から30日で消える */
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
    return entry?.head.ownerUid === uid ? entry : undefined;
  }

  async saveItinerary(itinerary: Itinerary): Promise<void> {
    const now = this.#now();
    const existing = this.#alive(this.#itineraries.get(itinerary.id));
    const entry: ItineraryEntry = existing ?? {
      head: {
        itineraryId: itinerary.id,
        ownerUid: null,
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
    // 保存した順を保つ（上限で消すのは、いちばん長く保存されていない旅程から）
    this.#itineraries.delete(itinerary.id);
    this.#itineraries.set(itinerary.id, entry);
    trim(this.#itineraries, this.#max);
  }

  async getShared(id: string): Promise<SharedItinerary | null> {
    const now = this.#now();
    if (id.startsWith("sh-")) {
      const share = this.#shares.get(id);
      if (share === undefined) return null;
      if (now > share.expiresAt) {
        this.#shares.delete(id);
        return null;
      }
      return {
        itineraryId: share.itineraryId,
        version: share.version,
        itinerary: JSON.parse(share.json),
      };
    }
    const entry = this.#alive(this.#itineraries.get(id));
    if (entry === undefined || now - entry.head.updatedAt > SHARE_TTL_MS) return null;
    const json = entry.versions.get(entry.head.version);
    if (json === undefined) return null;
    return { itineraryId: id, version: entry.head.version, itinerary: JSON.parse(json) };
  }

  async claimTrip(uid: string, itineraryId: string): Promise<ClaimResult> {
    const entry = this.#alive(this.#itineraries.get(itineraryId));
    if (entry === undefined) return { status: "not_found" };
    if (entry.head.ownerUid !== null && entry.head.ownerUid !== uid) return { status: "forbidden" };
    entry.head.ownerUid = uid;
    return { status: "saved", trip: { ...entry.head } };
  }

  async listTrips(uid: string): Promise<StoredTrip[]> {
    return [...this.#itineraries.values()]
      .filter((entry) => entry.head.ownerUid === uid)
      .map((entry) => ({ ...entry.head }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getTrip(
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

  async deleteTrip(uid: string, itineraryId: string): Promise<boolean> {
    if (this.#owned(uid, itineraryId) === undefined) return false;
    this.#itineraries.delete(itineraryId);
    for (const [id, share] of this.#shares) {
      if (share.itineraryId === itineraryId) this.#shares.delete(id);
    }
    return true;
  }

  async deleteAllTrips(uid: string): Promise<number> {
    const trips = await this.listTrips(uid);
    for (const trip of trips) await this.deleteTrip(uid, trip.itineraryId);
    // 旅を消したあとに残った、この利用者の共有も消す
    for (const [id, share] of this.#shares) {
      if (share.ownerUid === uid) this.#shares.delete(id);
    }
    return trips.length;
  }

  async createShare(uid: string, itineraryId: string): Promise<CreatedShare | null> {
    const entry = this.#owned(uid, itineraryId);
    const json = entry?.versions.get(entry.head.version);
    if (entry === undefined || json === undefined) return null;
    const shareId = newShareId();
    const expiresAt = this.#now() + SHARE_TTL_MS;
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
    this.#sessions.delete(snapshot.id);
    this.#sessions.set(snapshot.id, {
      json: JSON.stringify(snapshot),
      updatedAt: snapshot.updatedAt,
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
