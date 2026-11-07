import { GuideNoticeSchema, type TripWatch } from "@matsuri-ikoka/schema";
import {
  fictionalItinerary,
  fictionalNotice,
  fictionalTripWatch,
} from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { FirestoreTripStorage } from "../storage/firestore";
import { MemoryTripStorage } from "../storage/memory";
import { ownerIdOf } from "../storage/owner";
import { TRIP_WATCH_DOC_ID } from "../storage/types";
import { FirestorePatrolStore } from "./firestoreStore";
import { MemoryPatrolStore } from "./store";
import { patrolStoreContract } from "./storeContract";

describe("MemoryPatrolStore", () => {
  patrolStoreContract(() => {
    const store = new MemoryPatrolStore();
    return {
      store,
      putWatch: async (trip) => store.putWatchedTrip(trip, null),
      removeWatch: async (trip) => store.removeWatchedTrip(trip.ref),
    };
  });

  it("見回り中の旅だけを一覧にする", async () => {
    const store = new MemoryPatrolStore();
    const active = { ref: "users/a/trips/t1", watch: { ...fictionalTripWatch(), tripId: "t1" } };
    const stopped = {
      ref: "users/b/trips/t2",
      watch: {
        ...fictionalTripWatch(),
        tripId: "t2",
        status: "stopped" as const,
        stoppedAt: "2026-08-10T06:00:00+09:00",
      },
    };
    store.putWatchedTrip(active, fictionalItinerary());
    store.putWatchedTrip(stopped, fictionalItinerary());

    expect(await store.listWatchedTrips(10)).toEqual([active]);
    expect((await store.readItinerary(active))?.id).toBe(fictionalItinerary().id);
  });
});

describe("MemoryPatrolStore（旅の保存先と同じメモリの置き場）", () => {
  /** 依頼のパスの利用者の旅を保存して、依頼を書く（ガイドの API と同じ口） */
  const putTripWatch = async (storage: MemoryTripStorage, ref: string, watch: TripWatch) => {
    const [, uid = "", , tripId = ""] = ref.split("/");
    const owner = ownerIdOf(uid);
    await storage.saveItinerary({ ...fictionalItinerary(), id: tripId }, owner);
    await storage.forOwner(owner).tripDocs(tripId).put("watch", TRIP_WATCH_DOC_ID, watch);
  };

  patrolStoreContract(() => {
    const storage = new MemoryTripStorage();
    return {
      store: new MemoryPatrolStore({ trips: storage.patrolTrips() }),
      putWatch: (trip) => putTripWatch(storage, trip.ref, trip.watch),
      removeWatch: async (trip) => {
        const [, uid = "", , tripId = ""] = trip.ref.split("/");
        await storage.forOwner(ownerIdOf(uid)).tripDocs(tripId).delete("watch", TRIP_WATCH_DOC_ID);
      },
    };
  });

  it("ガイドの API が書いた依頼を読み、見回りの通知をガイドが読める。旅を消すと書けない", async () => {
    const storage = new MemoryTripStorage();
    const store = new MemoryPatrolStore({ trips: storage.patrolTrips() });
    const owner = ownerIdOf("user-m");
    const tripId = "trip-m";
    await putTripWatch(storage, `users/user-m/trips/${tripId}`, {
      ...fictionalTripWatch(),
      tripId,
    });
    const docs = storage.forOwner(owner).tripDocs(tripId);

    const [found] = await store.listWatchedTrips(10);
    if (found === undefined) throw new Error("頼まれた旅が見つかりません");
    expect(found.ref).toBe(`users/user-m/trips/${tripId}`);
    expect((await store.readItinerary(found))?.id).toBe(tripId);
    expect(await store.readItinerary({ ...found, ref: `users/other/trips/${tripId}` })).toBeNull();

    const notice = { ...fictionalNotice(), tripId };
    expect(await store.addNotice(found, notice, Date.now() + 60_000)).toBe("created");
    expect(await docs.list("notices")).toEqual([notice]);

    expect(await storage.forOwner(owner).deleteTrip(tripId)).toBe(true);
    expect(await store.listWatchedTrips(10)).toEqual([]);
    expect(await store.addNotice(found, notice, Date.now() + 60_000)).toBe("not_watching");
    expect(await store.listNotices(found)).toEqual([]);
  });
});

// Firestore のエミュレーターがあるときだけ回す（FIRESTORE_EMULATOR_HOST）。
// Admin SDK は読み込みに時間がかかるので、エミュレーターがあるときだけ読み込む
const db = process.env.FIRESTORE_EMULATOR_HOST
  ? await (async () => {
      const { initializeApp } = await import("firebase-admin/app");
      const { getFirestore } = await import("firebase-admin/firestore");
      return getFirestore(initializeApp({ projectId: "demo-matsuri-ikoka" }, "patrol-contract"));
    })()
  : null;

describe.skipIf(db === null)("FirestorePatrolStore（エミュレーター）", () => {
  if (db === null) return;
  patrolStoreContract(() => ({
    store: new FirestorePatrolStore(db),
    putWatch: async (trip) => {
      await db.doc(`${trip.ref}/watch/current`).set(trip.watch);
    },
    removeWatch: async (trip) => {
      await db.doc(`${trip.ref}/watch/current`).delete();
    },
  }));

  it("watch の文書から依頼を読み、持ち主の旅程だけを読む", async () => {
    const store = new FirestorePatrolStore(db);
    const stamp = String(Date.now());
    const tripId = `trip-${stamp}`;
    const uid = `user-${stamp}`;
    const itinerary = { ...fictionalItinerary(), id: tripId, version: 2 };
    const head = db.collection("itineraries").doc(tripId);
    await head.set({ ownerUid: uid, consultOwnerUid: null, version: 2 });
    await head
      .collection("versions")
      .doc("000002")
      .set({ version: 2, itinerary: JSON.stringify(itinerary) });
    await db
      .doc(`users/${uid}/trips/${tripId}/watch/current`)
      .set({ ...fictionalTripWatch(), tripId, futureField: "読まない" });

    const trips = await store.listWatchedTrips(10_000);
    const found = trips.find((trip) => trip.watch.tripId === tripId);

    expect(found?.ref).toBe(`users/${uid}/trips/${tripId}`);
    if (found === undefined) return;
    expect((await store.readItinerary(found))?.version).toBe(2);
    expect(await store.readItinerary({ ...found, ref: `users/other/trips/${tripId}` })).toBeNull();
  });

  it("ガイドの保存の口で頼んだ旅を見回りが読み、見回りが書いた通知をガイドの口で読める", async () => {
    const storage = new FirestoreTripStorage(db);
    const store = new FirestorePatrolStore(db);
    const stamp = String(Date.now());
    const uid = `user-g-${stamp}`;
    const tripId = `trip-g-${stamp}`;
    const owner = ownerIdOf(uid);
    await storage.saveItinerary({ ...fictionalItinerary(), id: tripId }, owner);
    const docs = storage.forOwner(owner).tripDocs(tripId);
    await docs.put("watch", TRIP_WATCH_DOC_ID, { ...fictionalTripWatch(), tripId });

    const found = (await store.listWatchedTrips(10_000)).find(
      (trip) => trip.watch.tripId === tripId,
    );
    if (found === undefined) throw new Error("頼まれた旅が見つかりません");
    expect(found.ref).toBe(`users/${uid}/trips/${tripId}`);
    expect((await store.readItinerary(found))?.id).toBe(tripId);

    const notice = { ...fictionalNotice(), tripId };
    expect(await store.addNotice(found, notice, Date.now() + 60_000)).toBe("created");
    expect(GuideNoticeSchema.parse(await docs.get("notices", notice.id))).toEqual(notice);
    expect(await docs.list("notices")).toEqual([notice]);

    // 旅を消すと、依頼も通知もいっしょに消え、見回りも書けない
    expect(await storage.forOwner(owner).deleteTrip(tripId)).toBe(true);
    expect(await store.listNotices(found)).toEqual([]);
    expect(
      (await store.listWatchedTrips(10_000)).some((trip) => trip.watch.tripId === tripId),
    ).toBe(false);
    expect(await store.addNotice(found, notice, Date.now() + 60_000)).toBe("not_watching");
  });

  it("期限を過ぎた依頼は、消える前でも見回らない", async () => {
    const stamp = String(Date.now());
    const uid = `user-e-${stamp}`;
    const tripId = `trip-e-${stamp}`;
    const expiresAt = Date.UTC(2026, 7, 10);
    await db
      .doc(`users/${uid}/trips/${tripId}/watch/current`)
      .set({ ...fictionalTripWatch(), tripId, expiresAt: new Date(expiresAt) });
    const found = async (now: number) =>
      (await new FirestorePatrolStore(db, { now: () => now }).listWatchedTrips(10_000)).some(
        (trip) => trip.watch.tripId === tripId,
      );

    expect(await found(expiresAt - 1)).toBe(true);
    expect(await found(expiresAt + 1)).toBe(false);
  });

  it("通知の文書に expiresAt があっても、通知として読める", async () => {
    const store = new FirestorePatrolStore(db);
    const stamp = String(Date.now());
    const trip = {
      ref: `users/user-n-${stamp}/trips/trip-n-${stamp}`,
      watch: { ...fictionalTripWatch(), tripId: `trip-n-${stamp}` },
    };
    await db.doc(`${trip.ref}/watch/current`).set(trip.watch);
    const { fictionalNotice } = await import("@matsuri-ikoka/schema/testing");
    const notice = { ...fictionalNotice(), tripId: trip.watch.tripId };

    await store.addNotice(trip, notice, Date.UTC(2026, 8, 15));

    const raw = await db.doc(`${trip.ref}/notices/${notice.id}`).get();
    expect(raw.get("expiresAt")).toBeDefined();
    expect(await store.listNotices(trip)).toEqual([notice]);
  });
});
