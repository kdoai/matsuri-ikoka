import { randomBytes } from "node:crypto";
import type { Itinerary } from "@matsuri-ikoka/schema";
import { isDocumentId, type OwnerId, ownerTripPath } from "./owner";
import {
  type ClaimResult,
  type CreatedShare,
  type DailyGuideUsage,
  GUIDE_USAGE_TTL_MS,
  type GuideUsage,
  MAX_TRIP_DOCS,
  MAX_VERSIONS,
  type OwnerTripDocs,
  type OwnerTripStorage,
  SESSION_STATE_TTL_MS,
  type SessionSnapshot,
  SHARE_REUSE_MIN_REMAINING_MS,
  SHARE_TTL_MS,
  type SharedItinerary,
  type StoredTrip,
  type StoredTripDetail,
  summarize,
  type TripDocKind,
  TripGoneError,
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

interface TripDocEntry {
  json: string;
  expiresAt: number | null;
}

interface UsageEntry extends GuideUsage {
  trips: Map<string, GuideUsage>;
  expiresAt: number;
}

const noUsage = (): GuideUsage => ({ turns: 0, costUsd: 0 });

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
  /** 持ち主の旅の置き場のパス → 「種類/ID」→ 文書 */
  readonly #tripDocs = new Map<string, Map<string, TripDocEntry>>();
  /** 「持ち主/日」→ ガイドの使った量 */
  readonly #guideUsage = new Map<string, UsageEntry>();
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
      tripDocs: (tripId) => this.#docsOf(owner, tripId),
      readGuideUsage: async (tripId, day) => this.#readUsage(owner, tripId, day),
      addGuideUsage: async (tripId, day, delta) => this.#addUsage(owner, tripId, day, delta),
      claimTrip: (itineraryId) => this.#claimTrip(owner, itineraryId),
      listTrips: () => this.#listTrips(owner),
      getTrip: (itineraryId, version) => this.#getTrip(owner, itineraryId, version),
      deleteTrip: (itineraryId) => this.#deleteTrip(owner, itineraryId),
      deleteAllTrips: () => this.#deleteAllTrips(owner),
      createShare: (itineraryId) => this.#createShare(owner, itineraryId),
    };
  }

  #docsOf(owner: OwnerId, tripId: string): OwnerTripDocs {
    const path = ownerTripPath(owner, tripId);
    const keyOf = (kind: TripDocKind, id: string) => `${kind}/${id}`;
    const alive = (entry: TripDocEntry) =>
      entry.expiresAt === null || this.#now() <= entry.expiresAt;
    return {
      get: async (kind, id) => {
        if (!isDocumentId(id)) return null;
        const entry = this.#tripDocs.get(path)?.get(keyOf(kind, id));
        return entry !== undefined && alive(entry) ? JSON.parse(entry.json) : null;
      },
      list: async (kind) => {
        const prefix = `${kind}/`;
        return [...(this.#tripDocs.get(path)?.entries() ?? [])]
          .filter(([key, entry]) => key.startsWith(prefix) && alive(entry))
          .slice(0, MAX_TRIP_DOCS)
          .map(([, entry]) => JSON.parse(entry.json) as unknown);
      },
      put: async (kind, id, value, options = {}) => {
        if (!isDocumentId(id)) throw new Error("保存の置き場の ID の形が正しくありません");
        if (this.#owned(owner, tripId) === undefined) throw new TripGoneError();
        const docs = this.#tripDocs.get(path) ?? new Map<string, TripDocEntry>();
        docs.set(keyOf(kind, id), {
          json: JSON.stringify(value),
          expiresAt: options.expiresAt ?? null,
        });
        // 使った順を保つ（上限で消すのは、いちばん長く書かれていない旅の分から）
        this.#tripDocs.delete(path);
        this.#tripDocs.set(path, docs);
        trim(this.#tripDocs, this.#max);
      },
      delete: async (kind, id) =>
        isDocumentId(id) && (this.#tripDocs.get(path)?.delete(keyOf(kind, id)) ?? false),
    };
  }

  #readUsage(owner: OwnerId, tripId: string, day: string): DailyGuideUsage {
    const entry = this.#guideUsage.get(`${owner}/${day}`);
    if (entry === undefined || this.#now() > entry.expiresAt) {
      return { user: noUsage(), trip: noUsage() };
    }
    return {
      user: { turns: entry.turns, costUsd: entry.costUsd },
      trip: { ...(entry.trips.get(tripId) ?? noUsage()) },
    };
  }

  #addUsage(owner: OwnerId, tripId: string, day: string, delta: GuideUsage): void {
    const key = `${owner}/${day}`;
    const entry: UsageEntry = this.#guideUsage.get(key) ?? {
      ...noUsage(),
      trips: new Map<string, GuideUsage>(),
      expiresAt: this.#now() + GUIDE_USAGE_TTL_MS,
    };
    const trip = entry.trips.get(tripId) ?? noUsage();
    entry.turns += delta.turns;
    entry.costUsd += delta.costUsd;
    entry.trips.set(tripId, {
      turns: trip.turns + delta.turns,
      costUsd: trip.costUsd + delta.costUsd,
    });
    this.#guideUsage.delete(key);
    this.#guideUsage.set(key, entry);
    trim(this.#guideUsage, this.#max);
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

  #removeTrip(owner: OwnerId, itineraryId: string): void {
    this.#itineraries.delete(itineraryId);
    for (const [id, share] of this.#shares) {
      if (share.itineraryId === itineraryId) this.#shares.delete(id);
    }
    // 旅の下のデータ（手帳・通知・提案・見回りの依頼）をまるごと消す
    this.#tripDocs.delete(ownerTripPath(owner, itineraryId));
  }

  async #deleteTrip(owner: OwnerId, itineraryId: string): Promise<boolean> {
    if (this.#owned(owner, itineraryId) === undefined) return false;
    this.#removeTrip(owner, itineraryId);
    return true;
  }

  async #deleteAllTrips(owner: OwnerId): Promise<number> {
    const kept = (await this.#listTrips(owner)).length;
    // 期限を過ぎた残す前の旅程も消すので、期限は見ず、見出しの持ち主で選ぶ
    for (const entry of [...this.#itineraries.values()]) {
      if (tripOwner(entry.head) === owner) this.#removeTrip(owner, entry.head.itineraryId);
    }
    // 旅を消したあとに残った、この利用者の共有・旅の下のデータ・使った量も消す
    for (const [id, share] of this.#shares) {
      if (share.ownerUid === owner) this.#shares.delete(id);
    }
    const prefix = `users/${owner}/trips/`;
    for (const path of [...this.#tripDocs.keys()]) {
      if (path.startsWith(prefix)) this.#tripDocs.delete(path);
    }
    for (const key of [...this.#guideUsage.keys()]) {
      if (key.startsWith(`${owner}/`)) this.#guideUsage.delete(key);
    }
    for (const [id, session] of this.#sessions) {
      if (session.ownerUid === owner) this.#sessions.delete(id);
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
