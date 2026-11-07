import type { Itinerary } from "@matsuri-ikoka/schema";
import type { DocumentData, DocumentSnapshot, Firestore } from "firebase-admin/firestore";
import { newShareId } from "./memory";
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

// Firestore の保存の口。読み書きはサーバーだけが Admin SDK で行い、ブラウザからは読み書きさせない（firestore.rules）。
//
//   itineraries/{旅程の ID}                 一覧の見出し・持ち主（残した人・組んだ相談の人）・最新の版・expiresAt
//   itineraries/{旅程の ID}/versions/{版}   旅程の JSON（版ごと）・expiresAt
//   shares/{共有の ID}                      共有したときの版の JSON・expiresAt
//   sessions/{相談の ID}                    相談の途中の状態の JSON・持ち主・expiresAt
//   users/{利用者}/trips/{旅}/memo/{ID}     手帳の JSON・expiresAt
//   users/{利用者}/trips/{旅}/proposals/{ID} 提案の JSON（旅程をまるごと持つ）・expiresAt
//   users/{利用者}/trips/{旅}/notices/{ID}  通知の項目を平らに置く・expiresAt
//   users/{利用者}/trips/{旅}/watch/current 見回りの依頼の項目を平らに置く・expiresAt
//   users/{利用者}/guideUsage/{日}          ガイドのその日の使った量（利用者全体と旅ごと）・expiresAt
//
// expiresAt は TTL ポリシーで消す時刻。残した旅程とその版は null（消さない）。
// TTL で消えるまでには時間がかかるので、読むときにも期限を確かめる。
// 新しい種類のデータは、持ち主を含むパス（owner.ts の ownerTripPath）に置く。

const ITINERARIES = "itineraries";
const VERSIONS = "versions";
const SHARES = "shares";
const SESSIONS = "sessions";
const USERS = "users";
const GUIDE_USAGE = "guideUsage";
/**
 * 項目を平らに置く種類。見回りが、頼まれた旅を項目（status）で探し、通知を足せるようにする。
 * 提案は旅程をまるごと持ち、自分の期限の項目（expiresAt）もあるので、JSON の文字列のまま持つ
 */
const FLAT_DOC_KINDS: ReadonlySet<TripDocKind> = new Set<TripDocKind>(["watch", "notices"]);
/** 1人の旅の一覧に出す数の上限 */
const MAX_TRIPS_PER_USER = 200;

/** 版の文書の ID。並べたときに版の順になるよう0で埋める */
function versionDocId(version: number): string {
  return String(version).padStart(6, "0");
}

/** 時刻は Date で書く（Firestore のタイムスタンプになり、TTL ポリシーが読める） */
function at(ms: number): Date {
  return new Date(ms);
}

/** 読んだタイムスタンプをミリ秒にする */
function millis(value: unknown): number {
  const toMillis = (value as { toMillis?: unknown } | null)?.toMillis;
  return typeof toMillis === "function" ? Number(toMillis.call(value)) : 0;
}

function tripOf(snapshot: DocumentSnapshot): StoredTrip | null {
  const data = snapshot.data();
  if (data === undefined) return null;
  return {
    itineraryId: snapshot.id,
    ownerUid: typeof data.ownerUid === "string" ? data.ownerUid : null,
    consultOwnerUid: typeof data.consultOwnerUid === "string" ? data.consultOwnerUid : null,
    title: typeof data.title === "string" ? data.title : "",
    date: typeof data.date === "string" ? data.date : null,
    version: typeof data.version === "number" ? data.version : 1,
    createdAt: millis(data.createdAt),
    updatedAt: millis(data.updatedAt),
  };
}

/** 読んだ使った量。形が違えば 0 にする */
function usageOf(value: unknown): GuideUsage {
  const record = (value ?? {}) as { turns?: unknown; costUsd?: unknown };
  return {
    turns: typeof record.turns === "number" ? record.turns : 0,
    costUsd: typeof record.costUsd === "number" ? record.costUsd : 0,
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

  /** 残されていない旅程は、最後の保存から30日で消えたものとして扱う */
  #alive(trip: StoredTrip | null): StoredTrip | null {
    if (trip === null) return null;
    if (trip.ownerUid === null && this.#now() - trip.updatedAt > SHARE_TTL_MS) return null;
    return trip;
  }

  /** 旅程の見出しを読む。外から届いた ID が文書の ID の形でなければ、ないものとして扱う */
  async #readHead(itineraryId: string): Promise<StoredTrip | null> {
    if (!isDocumentId(itineraryId)) return null;
    return this.#alive(tripOf(await this.#head(itineraryId).get()));
  }

  async #owned(uid: string, itineraryId: string): Promise<StoredTrip | null> {
    const trip = await this.#readHead(itineraryId);
    return trip !== null && tripOwner(trip) === uid ? trip : null;
  }

  forOwner(owner: OwnerId): OwnerTripStorage {
    return {
      owner,
      tripDocs: (tripId) => this.#docsOf(owner, tripId),
      readGuideUsage: (tripId, day) => this.#readUsage(owner, tripId, day),
      addGuideUsage: (tripId, day, delta) => this.#addUsage(owner, tripId, day, delta),
      claimTrip: (itineraryId) => this.#claimTrip(owner, itineraryId),
      listTrips: () => this.#listTrips(owner),
      getTrip: (itineraryId, version) => this.#getTrip(owner, itineraryId, version),
      deleteTrip: (itineraryId) => this.#deleteTrip(owner, itineraryId),
      deleteAllTrips: () => this.#deleteAllTrips(owner),
      createShare: (itineraryId) => this.#createShare(owner, itineraryId),
    };
  }

  #docsOf(owner: OwnerId, tripId: string): OwnerTripDocs {
    const trip = this.#db.doc(ownerTripPath(owner, tripId));
    /** 期限のある文書は、TTL で消える前でも読まない。読めるものは、置いた値だけを戻す（期限の項目は除く） */
    const readValue = (data: DocumentData | undefined): unknown => {
      if (data === undefined) return null;
      if (data.expiresAt != null && this.#now() > millis(data.expiresAt)) return null;
      if (typeof data.json === "string") return JSON.parse(data.json);
      const { expiresAt: _expiresAt, ...fields } = data;
      return fields;
    };
    return {
      get: async (kind, id) => {
        if (!isDocumentId(id)) return null;
        return readValue((await trip.collection(kind).doc(id).get()).data());
      },
      list: async (kind) => {
        const docs = await trip.collection(kind).limit(MAX_TRIP_DOCS).get();
        return docs.docs.map((doc) => readValue(doc.data())).filter((value) => value !== null);
      },
      put: async (kind, id, value, options = {}) => {
        if (!isDocumentId(id)) throw new Error("保存の置き場の ID の形が正しくありません");
        const expiresAt = options.expiresAt === undefined ? null : at(options.expiresAt);
        // undefined の項目は Firestore に書けないので、JSON にして落とす
        const json = JSON.stringify(value);
        const doc = trip.collection(kind).doc(id);
        const fields = FLAT_DOC_KINDS.has(kind)
          ? { ...JSON.parse(json), expiresAt }
          : { json, updatedAt: at(this.#now()), expiresAt };
        // 発言の途中に旅を消されても書き戻さないよう、同じトランザクションで旅と持ち主を確かめる
        await this.#db.runTransaction(async (tx) => {
          const head = this.#alive(tripOf(await tx.get(this.#head(tripId))));
          if (head === null || tripOwner(head) !== owner) throw new TripGoneError();
          tx.set(doc, fields);
        });
      },
      delete: async (kind, id) => {
        if (!isDocumentId(id)) return false;
        const doc = trip.collection(kind).doc(id);
        return this.#db.runTransaction(async (tx) => {
          if (!(await tx.get(doc)).exists) return false;
          tx.delete(doc);
          return true;
        });
      },
    };
  }

  #usageDoc(owner: OwnerId, day: string) {
    if (!isDocumentId(day)) throw new Error("保存の置き場の ID の形が正しくありません");
    return this.#db.collection(USERS).doc(owner).collection(GUIDE_USAGE).doc(day);
  }

  async #readUsage(owner: OwnerId, tripId: string, day: string): Promise<DailyGuideUsage> {
    const data = (await this.#usageDoc(owner, day).get()).data();
    const trips = (data?.trips ?? {}) as Record<string, unknown>;
    return { user: usageOf(data), trip: usageOf(trips[tripId]) };
  }

  async #addUsage(owner: OwnerId, tripId: string, day: string, delta: GuideUsage): Promise<void> {
    const doc = this.#usageDoc(owner, day);
    await this.#db.runTransaction(async (tx) => {
      const data = (await tx.get(doc)).data();
      const trips = (data?.trips ?? {}) as Record<string, unknown>;
      const user = usageOf(data);
      const trip = usageOf(trips[tripId]);
      tx.set(doc, {
        turns: user.turns + delta.turns,
        costUsd: user.costUsd + delta.costUsd,
        trips: {
          ...trips,
          [tripId]: { turns: trip.turns + delta.turns, costUsd: trip.costUsd + delta.costUsd },
        },
        expiresAt: at(this.#now() + GUIDE_USAGE_TTL_MS),
      });
    });
  }

  async saveItinerary(itinerary: Itinerary, consultOwner: OwnerId | null): Promise<void> {
    const head = this.#head(itinerary.id);
    const json = JSON.stringify(itinerary);
    await this.#db.runTransaction(async (tx) => {
      const now = this.#now();
      const existing = this.#alive(tripOf(await tx.get(head)));
      const ownerUid = existing?.ownerUid ?? null;
      const expiresAt = ownerUid === null ? at(now + SHARE_TTL_MS) : null;
      const newest = existing === null || itinerary.version >= existing.version;
      tx.set(head, {
        ownerUid,
        consultOwnerUid: existing?.consultOwnerUid ?? consultOwner,
        ...(newest
          ? { ...summarize(itinerary), version: itinerary.version }
          : { title: existing.title, date: existing.date, version: existing.version }),
        createdAt: at(existing?.createdAt ?? now),
        updatedAt: at(now),
        expiresAt,
      });
      tx.set(head.collection(VERSIONS).doc(versionDocId(itinerary.version)), {
        version: itinerary.version,
        itinerary: json,
        savedAt: at(now),
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

  async readShare(shareId: string): Promise<SharedItinerary | null> {
    if (!isDocumentId(shareId)) return null;
    const share = await this.#db.collection(SHARES).doc(shareId).get();
    const data = share.data();
    if (data === undefined || this.#now() > millis(data.expiresAt)) return null;
    return {
      itineraryId: String(data.itineraryId),
      version: Number(data.version),
      itinerary: parseJson(data),
    };
  }

  async readUnowned(itineraryId: string): Promise<SharedItinerary | null> {
    const trip = await this.#readHead(itineraryId);
    if (trip === null || tripOwner(trip) !== null) return null;
    if (this.#now() - trip.updatedAt > SHARE_TTL_MS) return null;
    const version = await this.#head(itineraryId)
      .collection(VERSIONS)
      .doc(versionDocId(trip.version))
      .get();
    if (!version.exists) return null;
    return { itineraryId, version: trip.version, itinerary: parseJson(version.data()) };
  }

  async #claimTrip(uid: string, itineraryId: string): Promise<ClaimResult> {
    if (!isDocumentId(itineraryId)) return { status: "not_found" };
    const head = this.#head(itineraryId);
    const result = await this.#db.runTransaction(async (tx): Promise<ClaimResult> => {
      const trip = this.#alive(tripOf(await tx.get(head)));
      if (trip === null) return { status: "not_found" };
      const owner = tripOwner(trip);
      if (owner !== null && owner !== uid) return { status: "not_found" };
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

  async #listTrips(uid: string): Promise<StoredTrip[]> {
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

  async #getTrip(
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

  async #removeTrip(owner: OwnerId, itineraryId: string): Promise<void> {
    // 旅の下のデータ（手帳・通知・提案・見回りの依頼）を、見出しより先に消す。
    // 途中で失敗しても見出しが残るので、やり直せる（見出しを先に消すと、やり直しが「ない旅」になる）
    const underTrip = this.#db.doc(ownerTripPath(owner, itineraryId));
    await this.#db.recursiveDelete(underTrip);
    await this.#deleteShares("itineraryId", itineraryId);
    // 版（サブコレクション）ごと消す
    await this.#db.recursiveDelete(this.#head(itineraryId));
    // 見出しを消す前に書かれたものを片付ける。見出しを消したあとは書き込みが断られる
    await this.#db.recursiveDelete(underTrip);
  }

  async #deleteTrip(owner: OwnerId, itineraryId: string): Promise<boolean> {
    if ((await this.#owned(owner, itineraryId)) === null) return false;
    await this.#removeTrip(owner, itineraryId);
    return true;
  }

  async #deleteAllTrips(owner: OwnerId): Promise<number> {
    const uid: string = owner;
    const itineraries = this.#db.collection(ITINERARIES);
    const [kept, consulted] = await Promise.all([
      itineraries.where("ownerUid", "==", uid).select("ownerUid", "consultOwnerUid").get(),
      itineraries.where("consultOwnerUid", "==", uid).select("ownerUid", "consultOwnerUid").get(),
    ]);
    // 期限を過ぎた残す前の旅程も消すので、期限は見ず、見出しの持ち主で選ぶ
    const ids = new Set(
      [...kept.docs, ...consulted.docs]
        .filter((doc) => {
          const trip = tripOf(doc);
          return trip !== null && tripOwner(trip) === uid;
        })
        .map((doc) => doc.id),
    );
    for (const id of ids) await this.#removeTrip(owner, id);
    await this.#deleteShares("ownerUid", uid);
    // 旅程がもうない旅の下のデータと、使った量も消す
    await this.#db.recursiveDelete(this.#db.collection(USERS).doc(owner));
    return kept.size;
  }

  /** 同じ内容で、期限に余裕のある自分の共有。なければ null */
  async #reusableShare(
    uid: string,
    itineraryId: string,
    json: string,
    now: number,
  ): Promise<CreatedShare | null> {
    const shares = await this.#db
      .collection(SHARES)
      .where("itineraryId", "==", itineraryId)
      .select("ownerUid", "itinerary", "expiresAt")
      .get();
    for (const doc of shares.docs) {
      const expiresAt = millis(doc.get("expiresAt"));
      const same = doc.get("ownerUid") === uid && doc.get("itinerary") === json;
      if (same && expiresAt - now >= SHARE_REUSE_MIN_REMAINING_MS) {
        return { shareId: doc.id, expiresAt };
      }
    }
    return null;
  }

  async #createShare(uid: string, itineraryId: string): Promise<CreatedShare | null> {
    const trip = await this.#owned(uid, itineraryId);
    if (trip === null) return null;
    const version = await this.#head(itineraryId)
      .collection(VERSIONS)
      .doc(versionDocId(trip.version))
      .get();
    const data = version.data();
    if (typeof data?.itinerary !== "string") return null;
    const now = this.#now();
    const reusable = await this.#reusableShare(uid, itineraryId, data.itinerary, now);
    if (reusable !== null) return reusable;
    const shareId = newShareId();
    const expiresAt = now + SHARE_TTL_MS;
    await this.#db
      .collection(SHARES)
      .doc(shareId)
      .create({
        itineraryId,
        ownerUid: uid,
        version: trip.version,
        itinerary: data.itinerary,
        createdAt: at(now),
        expiresAt: at(expiresAt),
      });
    return { shareId, expiresAt };
  }

  async saveSession(snapshot: SessionSnapshot): Promise<void> {
    const doc = this.#db.collection(SESSIONS).doc(snapshot.id);
    // 持ち主は状態の JSON の外にも置き、最初に決まった持ち主を保つ
    await this.#db.runTransaction(async (tx) => {
      const saved = (await tx.get(doc)).get("ownerUid");
      const ownerUid = typeof saved === "string" ? saved : (snapshot.ownerUid ?? null);
      tx.set(doc, {
        state: JSON.stringify({ ...snapshot, ownerUid }),
        updatedAt: at(snapshot.updatedAt),
        expiresAt: at(snapshot.updatedAt + SESSION_STATE_TTL_MS),
        ...(ownerUid === null ? {} : { ownerUid }),
      });
    });
  }

  async getSession(id: string): Promise<SessionSnapshot | null> {
    if (!isDocumentId(id)) return null;
    const doc = await this.#db.collection(SESSIONS).doc(id).get();
    const data = doc.data();
    if (data === undefined || typeof data.state !== "string") return null;
    if (this.#now() - millis(data.updatedAt) > SESSION_STATE_TTL_MS) return null;
    const ownerUid = typeof data.ownerUid === "string" ? data.ownerUid : null;
    return { ...(JSON.parse(data.state) as SessionSnapshot), ownerUid };
  }
}
