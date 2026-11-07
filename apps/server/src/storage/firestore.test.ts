import { randomUUID } from "node:crypto";
import { GuideNoticeSchema, TripWatchSchema } from "@matsuri-ikoka/schema";
import {
  fictionalItinerary,
  fictionalNotice,
  fictionalProposal,
  fictionalTripWatch,
} from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { storedGuideData } from "../guide/data";
import { tripStorageContract } from "./contract";
import { FirestoreTripStorage } from "./firestore";
import { ownerIdOf } from "./owner";
import { TRIP_WATCH_DOC_ID } from "./types";

// Firestore のエミュレーターがあるときだけ回す（FIRESTORE_EMULATOR_HOST。docs/spec/account.md の「手元で動かす」）。
// Admin SDK は読み込みに時間がかかるので、エミュレーターがあるときだけ読み込む
const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const db = emulator
  ? await (async () => {
      const { initializeApp } = await import("firebase-admin/app");
      const { getFirestore } = await import("firebase-admin/firestore");
      return getFirestore(initializeApp({ projectId: "demo-matsuri-ikoka" }, "storage-contract"));
    })()
  : null;

describe.skipIf(db === null)("FirestoreTripStorage（エミュレーター）", () => {
  if (db === null) return;
  tripStorageContract((clock) => new FirestoreTripStorage(db, { now: () => clock.now }));

  describe("旅の下の文書の形", () => {
    const setup = () => {
      const storage = new FirestoreTripStorage(db);
      const uid = `user-${randomUUID()}`;
      const tripId = `trip-${randomUUID()}`;
      const docs = storage.forOwner(ownerIdOf(uid)).tripDocs(tripId);
      const trip = db.doc(`users/${uid}/trips/${tripId}`);
      return { docs, trip, tripId };
    };

    it("見回りの依頼は項目を平らに置き、見回りが status で探せる", async () => {
      const { docs, trip, tripId } = setup();
      const watch = { ...fictionalTripWatch(), tripId };

      await docs.put("watch", TRIP_WATCH_DOC_ID, watch);

      const found = await db
        .collectionGroup("watch")
        .where("status", "==", "active")
        .where("tripId", "==", tripId)
        .get();
      expect(found.docs.map((doc) => doc.ref.path)).toEqual([`${trip.path}/watch/current`]);
      // 読むときは期限の項目を除くので、決まった形のまま戻る
      expect(TripWatchSchema.safeParse(await docs.get("watch", TRIP_WATCH_DOC_ID)).success).toBe(
        true,
      );
    });

    it("見回りが平らに書いた通知を、ガイドが読み、提案を結びつけられる", async () => {
      const { docs, trip, tripId } = setup();
      const notice = { ...fictionalNotice(), id: "n-0123456789abcdef", tripId, proposalId: null };
      const expiresAt = new Date(Date.now() + 60_000);
      await trip
        .collection("notices")
        .doc(notice.id)
        .create({ ...notice, expiresAt });
      // 架空の旅の日付は実際の今日と関係がないので、期限を付けない
      const data = storedGuideData(docs, { ...fictionalItinerary(), id: tripId }, null);

      const [read] = await data.notices();

      expect(read).toEqual(GuideNoticeSchema.parse(notice));
      await data.putNotice({ ...notice, proposalId: "proposal-1" });
      expect((await data.notices())[0]?.proposalId).toBe("proposal-1");
      expect((await trip.collection("notices").doc(notice.id).get()).get("proposalId")).toBe(
        "proposal-1",
      );
    });

    it("期限を過ぎた、平らに置いた通知は読まない", async () => {
      const { docs, trip, tripId } = setup();
      const notice = { ...fictionalNotice(), id: "n-expired", tripId };
      await trip
        .collection("notices")
        .doc(notice.id)
        .create({ ...notice, expiresAt: new Date(Date.now() - 1000) });

      expect(await docs.get("notices", notice.id)).toBeNull();
    });

    it("提案は、自分の期限の項目を保ったまま JSON の文字列で持つ", async () => {
      const { docs, trip } = setup();
      const proposal = fictionalProposal();

      await docs.put("proposals", proposal.id, proposal, { expiresAt: Date.now() + 60_000 });

      const raw = await trip.collection("proposals").doc(proposal.id).get();
      expect(typeof raw.get("json")).toBe("string");
      expect(await docs.get("proposals", proposal.id)).toEqual(
        JSON.parse(JSON.stringify(proposal)),
      );
    });
  });
});
