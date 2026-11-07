import { fictionalItinerary, fictionalTripWatch } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
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
