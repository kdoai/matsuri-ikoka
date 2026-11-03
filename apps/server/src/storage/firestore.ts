import type { Itinerary } from "@matsuri-ikoka/schema";
import {
  type DocumentData,
  type DocumentSnapshot,
  type Firestore,
  Timestamp,
} from "firebase-admin/firestore";
import { newShareId } from "./memory";
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

// Firestore の保存の口。読み書きはサーバーだけが Admin SDK で行い、ブラウザからは読み書きさせない（firestore.rules）。
//
//   itineraries/{旅程の ID}                 一覧の見出し・持ち主・最新の版・expiresAt
//   itineraries/{旅程の ID}/versions/{版}   旅程の JSON（版ごと）・expiresAt
//   shares/{共有の ID}                      共有したときの版の JSON・expiresAt
//   sessions/{相談の ID}                    相談の途中の状態の JSON・expiresAt
//
// expiresAt は TTL ポリシーで消す時刻。持ち主のある旅程とその版は null（消さない）。
// TTL で消えるまでには時間がかかるので、読むときにも期限を確かめる。

const ITINERARIES = "itineraries";
const VERSIONS = "versions";
const SHARES = "shares";
const SESSIONS = "sessions";
/** 1人の旅の一覧に出す数の上限 */
const MAX_TRIPS_PER_USER = 200;

/** 版の文書の ID。並べたときに版の順になるよう0で埋める */
function versionDocId(version: number): string {
  return String(version).padStart(6, "0");
}

function millis(value: unknown): number {
  return value instanceof Timestamp ? value.toMillis() : 0;
}

function tripOf(snapshot: DocumentSnapshot): StoredTrip | null {
  const data = snapshot.data();
  if (data === undefined) return null;
  return {
    itineraryId: snapshot.id,
    ownerUid: typeof data.ownerUid === "string" ? data.ownerUid : null,
    title: typeof data.title === "string" ? data.title : "",
    date: typeof data.date === "string" ? data.date : null,
    version: typeof data.version === "number" ? data.version : 1,
    createdAt: millis(data.createdAt),
    updatedAt: millis(data.updatedAt),
  };
}

function parseJson(data: DocumentData | undefined): unknown {
  if (typeof data?.itinerary !== "string") return null;
  return JSON.parse(data.itinerary);
}

export class FirestoreTripStorage implements TripStorage {
  readonly kind = "firestore";
  readonly #db: Firestore;
  readonly #now: () => number;

  constructor(db: Firestore, options: { now?: () => number } = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
  }

  #head(itineraryId: string) {
    return this.#db.collection(ITINERARIES).doc(itineraryId);
  }

  /** 持ち主のない旅程は、最後の保存から30日で消えたものとして扱う */
  #alive(trip: StoredTrip | null): StoredTrip | null {
    if (trip === null) return null;
    if (trip.ownerUid === null && this.#now() - trip.updatedAt > SHARE_TTL_MS) return null;
    return trip;
  }

  async #owned(uid: string, itineraryId: string): Promise<StoredTrip | null> {
    const trip = this.#alive(tripOf(await this.#head(itineraryId).get()));
    return trip?.ownerUid === uid ? trip : null;
  }

  async saveItinerary(itinerary: Itinerary): Promise<void> {
    const head = this.#head(itinerary.id);
    const json = JSON.stringify(itinerary);
    await this.#db.runTransaction(async (tx) => {
      const now = this.#now();
      const existing = this.#alive(tripOf(await tx.get(head)));
      const ownerUid = existing?.ownerUid ?? null;
      const expiresAt = ownerUid === null ? Timestamp.fromMillis(now + SHARE_TTL_MS) : null;
      const newest = existing === null || itinerary.version >= existing.version;
      tx.set(head, {
        ownerUid,
        ...(newest
          ? { ...summarize(itinerary), version: itinerary.version }
          : { title: existing.title, date: existing.date, version: existing.version }),
        createdAt: Timestamp.fromMillis(existing?.createdAt ?? now),
        updatedAt: Timestamp.fromMillis(now),
        expiresAt,
      });
      tx.set(head.collection(VERSIONS).doc(versionDocId(itinerary.version)), {
        version: itinerary.version,
        itinerary: json,
        savedAt: Timestamp.fromMillis(now),
        expiresAt,
      });
    });
    // 残す版の数を超えたら、古い版から消す
    const old = await head
      .collection(VERSIONS)
      .orderBy("version", "desc")
      .offset(MAX_VERSIONS)
      .select()
      .get();
    if (!old.empty) {
      const batch = this.#db.batch();
      for (const doc of old.docs) batch.delete(doc.ref);
      await batch.commit();
    }
  }

  async getShared(id: string): Promise<SharedItinerary | null> {
    const now = this.#now();
    if (id.startsWith("sh-")) {
      const share = await this.#db.collection(SHARES).doc(id).get();
      const data = share.data();
      if (data === undefined || now > millis(data.expiresAt)) return null;
      return {
        itineraryId: String(data.itineraryId),
        version: Number(data.version),
        itinerary: parseJson(data),
      };
    }
    const trip = this.#alive(tripOf(await this.#head(id).get()));
    if (trip === null || now - trip.updatedAt > SHARE_TTL_MS) return null;
    const version = await this.#head(id).collection(VERSIONS).doc(versionDocId(trip.version)).get();
    if (!version.exists) return null;
    return { itineraryId: id, version: trip.version, itinerary: parseJson(version.data()) };
  }

  async claimTrip(uid: string, itineraryId: string): Promise<ClaimResult> {
    const head = this.#head(itineraryId);
    const result = await this.#db.runTransaction(async (tx): Promise<ClaimResult> => {
      const trip = this.#alive(tripOf(await tx.get(head)));
      if (trip === null) return { status: "not_found" };
      if (trip.ownerUid !== null && trip.ownerUid !== uid) return { status: "forbidden" };
      tx.update(head, { ownerUid: uid, expiresAt: null });
      return { status: "saved", trip: { ...trip, ownerUid: uid } };
    });
    if (result.status === "saved") {
      // 残っている版も消えないようにする
      const versions = await head.collection(VERSIONS).select().get();
      const batch = this.#db.batch();
      for (const doc of versions.docs) batch.update(doc.ref, { expiresAt: null });
      await batch.commit();
    }
    return result;
  }

  async listTrips(uid: string): Promise<StoredTrip[]> {
    // 持ち主の1項目だけで絞る（複合インデックスを作らずに済むよう、並べ替えはここでする）
    const snapshot = await this.#db
      .collection(ITINERARIES)
      .where("ownerUid", "==", uid)
      .limit(MAX_TRIPS_PER_USER)
      .get();
    return snapshot.docs
      .map((doc) => tripOf(doc))
      .filter((trip): trip is StoredTrip => trip !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getTrip(
    uid: string,
    itineraryId: string,
    version?: number,
  ): Promise<StoredTripDetail | null> {
    const trip = await this.#owned(uid, itineraryId);
    if (trip === null) return null;
    const wanted = version ?? trip.version;
    const versions = this.#head(itineraryId).collection(VERSIONS);
    const [doc, all] = await Promise.all([
      versions.doc(versionDocId(wanted)).get(),
      versions.orderBy("version").select("version").get(),
    ]);
    if (!doc.exists) return null;
    return {
      trip,
      versions: all.docs.map((d) => Number(d.get("version"))),
      version: wanted,
      itinerary: parseJson(doc.data()),
    };
  }

  async #deleteShares(field: "itineraryId" | "ownerUid", value: string): Promise<void> {
    const shares = await this.#db.collection(SHARES).where(field, "==", value).select().get();
    if (shares.empty) return;
    const writer = this.#db.bulkWriter();
    for (const doc of shares.docs) void writer.delete(doc.ref);
    await writer.close();
  }

  async deleteTrip(uid: string, itineraryId: string): Promise<boolean> {
    if ((await this.#owned(uid, itineraryId)) === null) return false;
    await this.#deleteShares("itineraryId", itineraryId);
    // 版（サブコレクション）ごと消す
    await this.#db.recursiveDelete(this.#head(itineraryId));
    return true;
  }

  async deleteAllTrips(uid: string): Promise<number> {
    const trips = await this.listTrips(uid);
    for (const trip of trips) await this.deleteTrip(uid, trip.itineraryId);
    await this.#deleteShares("ownerUid", uid);
    return trips.length;
  }

  async createShare(uid: string, itineraryId: string): Promise<CreatedShare | null> {
    const trip = await this.#owned(uid, itineraryId);
    if (trip === null) return null;
    const version = await this.#head(itineraryId)
      .collection(VERSIONS)
      .doc(versionDocId(trip.version))
      .get();
    const data = version.data();
    if (typeof data?.itinerary !== "string") return null;
    const shareId = newShareId();
    const now = this.#now();
    const expiresAt = now + SHARE_TTL_MS;
    await this.#db
      .collection(SHARES)
      .doc(shareId)
      .create({
        itineraryId,
        ownerUid: uid,
        version: trip.version,
        itinerary: data.itinerary,
        createdAt: Timestamp.fromMillis(now),
        expiresAt: Timestamp.fromMillis(expiresAt),
      });
    return { shareId, expiresAt };
  }

  async saveSession(snapshot: SessionSnapshot): Promise<void> {
    await this.#db
      .collection(SESSIONS)
      .doc(snapshot.id)
      .set({
        state: JSON.stringify(snapshot),
        updatedAt: Timestamp.fromMillis(snapshot.updatedAt),
        expiresAt: Timestamp.fromMillis(snapshot.updatedAt + SESSION_STATE_TTL_MS),
      });
  }

  async getSession(id: string): Promise<SessionSnapshot | null> {
    const doc = await this.#db.collection(SESSIONS).doc(id).get();
    const data = doc.data();
    if (data === undefined || typeof data.state !== "string") return null;
    if (this.#now() - millis(data.updatedAt) > SESSION_STATE_TTL_MS) return null;
    return JSON.parse(data.state) as SessionSnapshot;
  }
}
