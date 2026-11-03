import { describe } from "vitest";
import { tripStorageContract } from "./contract";
import { FirestoreTripStorage } from "./firestore";

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
});
