import { randomUUID } from "node:crypto";
import type { Itinerary } from "@matsuri-ikoka/schema";
import { fictionalItinerary } from "@matsuri-ikoka/schema/testing";
import { expect, it } from "vitest";
import { MAX_VERSIONS, SESSION_STATE_TTL_MS, SHARE_TTL_MS, type TripStorage } from "./types";

// 保存の口が満たすこと。メモリの実装と Firestore の実装（エミュレーター）の両方で同じテストを回す。
// Firestore ではテストどうしでデータを分けないので、旅程と利用者の ID は毎回新しく作る。

export interface Clock {
  now: number;
}

export function tripStorageContract(make: (clock: Clock) => TripStorage): void {
  const setup = () => {
    const clock: Clock = { now: Date.UTC(2026, 7, 3) };
    const storage = make(clock);
    const itinerary = (version = 1): Itinerary => ({
      ...fictionalItinerary(),
      id: `it-${randomUUID()}`,
      version,
    });
    return { clock, storage, itinerary, uid: `user-${randomUUID()}` };
  };

  it("旅程の版を残し、共有の URL では最新の版を読む", async () => {
    const { storage, itinerary } = setup();
    const v1 = itinerary(1);
    await storage.saveItinerary(v1);
    await storage.saveItinerary({ ...v1, version: 2, title: "二つめの版" });

    const shared = await storage.getShared(v1.id);

    expect(shared?.version).toBe(2);
    expect((shared?.itinerary as Itinerary | undefined)?.title).toBe("二つめの版");
  });

  it("持ち主のない旅程は、最後の保存から30日で読めなくなる", async () => {
    const { clock, storage, itinerary } = setup();
    const v1 = itinerary();
    await storage.saveItinerary(v1);

    clock.now += SHARE_TTL_MS;
    expect(await storage.getShared(v1.id)).not.toBeNull();
    clock.now += 1;
    expect(await storage.getShared(v1.id)).toBeNull();
  });

  it("残した旅は一覧に出て、30日を過ぎても消えない。共有の URL は最後の保存から30日まで", async () => {
    const { clock, storage, itinerary, uid } = setup();
    const v1 = itinerary();
    await storage.saveItinerary(v1);

    const claimed = await storage.claimTrip(uid, v1.id);
    clock.now += SHARE_TTL_MS + 1;

    expect(claimed.status).toBe("saved");
    expect((await storage.listTrips(uid)).map((trip) => trip.itineraryId)).toEqual([v1.id]);
    expect((await storage.getTrip(uid, v1.id))?.itinerary).toEqual(v1);
    expect(await storage.getShared(v1.id)).toBeNull();
  });

  it("残したあとの版も、持ち主の旅に入る", async () => {
    const { storage, itinerary, uid } = setup();
    const v1 = itinerary(1);
    await storage.saveItinerary(v1);
    await storage.claimTrip(uid, v1.id);

    await storage.saveItinerary({ ...v1, version: 2 });

    const detail = await storage.getTrip(uid, v1.id);
    expect(detail?.trip.ownerUid).toBe(uid);
    expect(detail?.versions).toEqual([1, 2]);
    expect(detail?.version).toBe(2);
    expect((await storage.getTrip(uid, v1.id, 1))?.version).toBe(1);
  });

  it("ほかの利用者が残した旅は、残せず、読めず、消せない", async () => {
    const { storage, itinerary, uid } = setup();
    const v1 = itinerary();
    await storage.saveItinerary(v1);
    await storage.claimTrip(uid, v1.id);
    const other = `other-${randomUUID()}`;

    expect((await storage.claimTrip(other, v1.id)).status).toBe("forbidden");
    expect(await storage.getTrip(other, v1.id)).toBeNull();
    expect(await storage.deleteTrip(other, v1.id)).toBe(false);
    expect(await storage.createShare(other, v1.id)).toBeNull();
    expect(await storage.listTrips(other)).toEqual([]);
  });

  it("ない旅程は残せない", async () => {
    const { storage, uid } = setup();
    expect((await storage.claimTrip(uid, "it-none")).status).toBe("not_found");
  });

  it("共有は推測できない ID で、作ったときの版を30日だけ読める", async () => {
    const { clock, storage, itinerary, uid } = setup();
    const v1 = itinerary(1);
    await storage.saveItinerary(v1);
    await storage.claimTrip(uid, v1.id);

    const share = await storage.createShare(uid, v1.id);
    await storage.saveItinerary({ ...v1, version: 2 });

    expect(share?.shareId).toMatch(/^sh-[A-Za-z0-9_-]{24,}$/);
    expect(share?.expiresAt).toBe(clock.now + SHARE_TTL_MS);
    const shared = await storage.getShared(share?.shareId ?? "");
    expect(shared?.version).toBe(1);
    expect(shared?.itineraryId).toBe(v1.id);
    clock.now += SHARE_TTL_MS + 1;
    expect(await storage.getShared(share?.shareId ?? "")).toBeNull();
  });

  it("旅を消すと、版と共有もいっしょに消える", async () => {
    const { storage, itinerary, uid } = setup();
    const v1 = itinerary();
    await storage.saveItinerary(v1);
    await storage.claimTrip(uid, v1.id);
    const share = await storage.createShare(uid, v1.id);

    expect(await storage.deleteTrip(uid, v1.id)).toBe(true);

    expect(await storage.listTrips(uid)).toEqual([]);
    expect(await storage.getTrip(uid, v1.id)).toBeNull();
    expect(await storage.getShared(v1.id)).toBeNull();
    expect(await storage.getShared(share?.shareId ?? "")).toBeNull();
  });

  it("自分の旅をすべて消せる", async () => {
    const { storage, itinerary, uid } = setup();
    const a = itinerary();
    const b = itinerary();
    for (const it of [a, b]) {
      await storage.saveItinerary(it);
      await storage.claimTrip(uid, it.id);
    }

    expect(await storage.deleteAllTrips(uid)).toBe(2);
    expect(await storage.listTrips(uid)).toEqual([]);
  });

  it("一覧は新しく保存した順で、見出しは旅程から取り出す", async () => {
    const { clock, storage, itinerary, uid } = setup();
    const a = { ...itinerary(), title: "古い旅" };
    const b = { ...itinerary(), title: "新しい旅" };
    await storage.saveItinerary(a);
    clock.now += 1000;
    await storage.saveItinerary(b);
    await storage.claimTrip(uid, a.id);
    await storage.claimTrip(uid, b.id);

    const trips = await storage.listTrips(uid);

    expect(trips.map((trip) => trip.title)).toEqual(["新しい旅", "古い旅"]);
    expect(trips[0]?.date).toBe(b.days[0]?.date);
  });

  it(`版は新しいものから ${MAX_VERSIONS} まで残す`, async () => {
    const { storage, itinerary, uid } = setup();
    const v1 = itinerary(1);
    await storage.saveItinerary(v1);
    await storage.claimTrip(uid, v1.id);
    for (let version = 2; version <= MAX_VERSIONS + 2; version += 1) {
      await storage.saveItinerary({ ...v1, version });
    }

    const detail = await storage.getTrip(uid, v1.id);

    expect(detail?.versions).toHaveLength(MAX_VERSIONS);
    expect(detail?.versions[0]).toBe(3);
  });

  it("相談の途中の状態を残し、6時間使われなければ読めなくなる", async () => {
    const { clock, storage } = setup();
    const snapshot = {
      id: `s-${randomUUID()}`,
      createdAt: clock.now,
      updatedAt: clock.now,
      stage: "itinerary" as const,
      conditions: { origin: "みなと中央駅" },
      preferences: fictionalItinerary().preferences,
      candidates: [],
      selectedFestivalId: null,
      itineraryId: "it-1",
      replay: null,
    };
    await storage.saveSession(snapshot);

    expect(await storage.getSession(snapshot.id)).toEqual(snapshot);
    clock.now += SESSION_STATE_TTL_MS + 1;
    expect(await storage.getSession(snapshot.id)).toBeNull();
  });
}
