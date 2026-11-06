import { randomUUID } from "node:crypto";
import type { Itinerary } from "@matsuri-ikoka/schema";
import { fictionalItinerary } from "@matsuri-ikoka/schema/testing";
import { expect, it } from "vitest";
import { type OwnerId, ownerIdOf } from "./owner";
import {
  MAX_VERSIONS,
  SESSION_STATE_TTL_MS,
  type SessionSnapshot,
  SHARE_REUSE_MIN_REMAINING_MS,
  SHARE_TTL_MS,
  type TripStorage,
} from "./types";

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
    const owner = ownerIdOf(`user-${randomUUID()}`);
    return { clock, storage, itinerary, owner, mine: storage.forOwner(owner) };
  };
  const snapshotAt = (now: number, ownerUid?: string | null): SessionSnapshot => ({
    id: `s-${randomUUID()}`,
    ...(ownerUid === undefined ? {} : { ownerUid }),
    createdAt: now,
    updatedAt: now,
    stage: "itinerary",
    conditions: { origin: "みなと中央駅" },
    preferences: fictionalItinerary().preferences,
    candidates: [],
    selectedFestivalId: null,
    itineraryId: "it-1",
    replay: null,
  });

  it("旅程の版を残し、持ち主のない旅程は ID で最新の版を読む", async () => {
    const { storage, itinerary } = setup();
    const v1 = itinerary(1);
    await storage.saveItinerary(v1, null);
    await storage.saveItinerary({ ...v1, version: 2, title: "二つめの版" }, null);

    const shared = await storage.readUnowned(v1.id);

    expect(shared?.version).toBe(2);
    expect((shared?.itinerary as Itinerary | undefined)?.title).toBe("二つめの版");
  });

  it("持ち主のない旅程は、最後の保存から30日で読めなくなる", async () => {
    const { clock, storage, itinerary } = setup();
    const v1 = itinerary();
    await storage.saveItinerary(v1, null);

    clock.now += SHARE_TTL_MS;
    expect(await storage.readUnowned(v1.id)).not.toBeNull();
    clock.now += 1;
    expect(await storage.readUnowned(v1.id)).toBeNull();
  });

  it("残した旅は一覧に出て、30日を過ぎても消えない。旅程の ID では読めない", async () => {
    const { clock, storage, itinerary, mine } = setup();
    const v1 = itinerary();
    await storage.saveItinerary(v1, null);

    const claimed = await mine.claimTrip(v1.id);
    expect(await storage.readUnowned(v1.id)).toBeNull();
    clock.now += SHARE_TTL_MS + 1;

    expect(claimed.status).toBe("saved");
    expect((await mine.listTrips()).map((trip) => trip.itineraryId)).toEqual([v1.id]);
    expect((await mine.getTrip(v1.id))?.itinerary).toEqual(v1);
    expect(await storage.readUnowned(v1.id)).toBeNull();
  });

  it("残したあとの版も、持ち主の旅に入る", async () => {
    const { storage, itinerary, owner, mine } = setup();
    const v1 = itinerary(1);
    await storage.saveItinerary(v1, null);
    await mine.claimTrip(v1.id);

    await storage.saveItinerary({ ...v1, version: 2 }, null);

    const detail = await mine.getTrip(v1.id);
    expect(detail?.trip.ownerUid).toBe(owner);
    expect(detail?.versions).toEqual([1, 2]);
    expect(detail?.version).toBe(2);
    expect((await mine.getTrip(v1.id, 1))?.version).toBe(1);
  });

  it("ほかの利用者の旅は、残せず、読めず、消せず、共有できない", async () => {
    const { storage, itinerary, mine } = setup();
    const v1 = itinerary();
    await storage.saveItinerary(v1, null);
    await mine.claimTrip(v1.id);
    const other = storage.forOwner(ownerIdOf(`other-${randomUUID()}`));

    expect((await other.claimTrip(v1.id)).status).toBe("not_found");
    expect(await other.getTrip(v1.id)).toBeNull();
    expect(await other.deleteTrip(v1.id)).toBe(false);
    expect(await other.createShare(v1.id)).toBeNull();
    expect(await other.listTrips()).toEqual([]);
    expect((await mine.getTrip(v1.id))?.itinerary).toEqual(v1);
  });

  it("ログインした相談で組んだ旅程は、残す前でもその人だけが読み、一覧には出ず、30日で消える", async () => {
    const { clock, storage, itinerary, owner, mine } = setup();
    const v1 = itinerary();
    await storage.saveItinerary(v1, owner);
    const other = storage.forOwner(ownerIdOf(`other-${randomUUID()}`));

    expect(await storage.readUnowned(v1.id)).toBeNull();
    expect((await mine.getTrip(v1.id))?.itinerary).toEqual(v1);
    expect(await other.getTrip(v1.id)).toBeNull();
    expect((await other.claimTrip(v1.id)).status).toBe("not_found");
    expect(await other.deleteTrip(v1.id)).toBe(false);
    expect(await other.createShare(v1.id)).toBeNull();
    expect(await mine.listTrips()).toEqual([]);

    clock.now += SHARE_TTL_MS + 1;
    expect(await mine.getTrip(v1.id)).toBeNull();
  });

  it("ログインした相談で組んだ旅程を残すと、一覧に出て、消えなくなる", async () => {
    const { clock, storage, itinerary, owner, mine } = setup();
    const v1 = itinerary();
    await storage.saveItinerary(v1, owner);

    expect((await mine.claimTrip(v1.id)).status).toBe("saved");
    clock.now += SHARE_TTL_MS + 1;

    expect((await mine.listTrips()).map((trip) => trip.itineraryId)).toEqual([v1.id]);
    expect((await mine.getTrip(v1.id))?.itinerary).toEqual(v1);
  });

  it("一度決まった相談の持ち主は、あとの保存で別の人に変わらない", async () => {
    const { storage, itinerary, owner, mine } = setup();
    const v1 = itinerary(1);
    await storage.saveItinerary(v1, owner);

    await storage.saveItinerary({ ...v1, version: 2 }, ownerIdOf(`other-${randomUUID()}`));
    await storage.saveItinerary({ ...v1, version: 3 }, null);

    expect((await mine.getTrip(v1.id))?.version).toBe(3);
    expect(await storage.readUnowned(v1.id)).toBeNull();
  });

  it("ない旅程は残せない", async () => {
    const { mine } = setup();
    expect((await mine.claimTrip("it-none")).status).toBe("not_found");
  });

  it("共有は推測できない ID で、作ったときの版を30日だけ読める", async () => {
    const { clock, storage, itinerary, mine } = setup();
    const v1 = itinerary(1);
    await storage.saveItinerary(v1, null);
    await mine.claimTrip(v1.id);

    const share = await mine.createShare(v1.id);
    await storage.saveItinerary({ ...v1, version: 2 }, null);

    expect(share?.shareId).toMatch(/^sh-[A-Za-z0-9_-]{24,}$/);
    expect(share?.expiresAt).toBe(clock.now + SHARE_TTL_MS);
    const shared = await storage.readShare(share?.shareId ?? "");
    expect(shared?.version).toBe(1);
    expect(shared?.itineraryId).toBe(v1.id);
    clock.now += SHARE_TTL_MS + 1;
    expect(await storage.readShare(share?.shareId ?? "")).toBeNull();
  });

  it("同じ内容の共有は使い回す", async () => {
    const { storage, itinerary, owner, mine } = setup();
    const v1 = itinerary();
    await storage.saveItinerary(v1, owner);

    const first = await mine.createShare(v1.id);
    const second = await mine.createShare(v1.id);

    expect(second).toEqual(first);
  });

  it("版が同じでも内容が変われば、別の共有になり、前の共有は前の内容のまま", async () => {
    const { storage, itinerary, owner, mine } = setup();
    const v1 = itinerary();
    await storage.saveItinerary(v1, owner);
    const first = await mine.createShare(v1.id);

    const rechecked = { ...v1, title: "確かめ直したあとの旅" };
    await storage.saveItinerary(rechecked, owner);
    const second = await mine.createShare(v1.id);

    expect(second?.shareId).not.toBe(first?.shareId);
    const before = await storage.readShare(first?.shareId ?? "");
    const after = await storage.readShare(second?.shareId ?? "");
    expect((before?.itinerary as Itinerary | undefined)?.title).toBe(v1.title);
    expect((after?.itinerary as Itinerary | undefined)?.title).toBe(rechecked.title);
  });

  it("新しい版の共有は別になる", async () => {
    const { storage, itinerary, owner, mine } = setup();
    const v1 = itinerary(1);
    await storage.saveItinerary(v1, owner);
    const first = await mine.createShare(v1.id);

    await storage.saveItinerary({ ...v1, version: 2 }, owner);

    expect((await mine.createShare(v1.id))?.shareId).not.toBe(first?.shareId);
  });

  it("残りが短くなった共有は使い回さず、新しく作る", async () => {
    const { clock, storage, itinerary, mine } = setup();
    const v1 = itinerary();
    await storage.saveItinerary(v1, null);
    await mine.claimTrip(v1.id);
    const first = await mine.createShare(v1.id);

    clock.now += SHARE_TTL_MS - SHARE_REUSE_MIN_REMAINING_MS;
    expect((await mine.createShare(v1.id))?.shareId).toBe(first?.shareId);
    clock.now += 1;
    const renewed = await mine.createShare(v1.id);

    expect(renewed?.shareId).not.toBe(first?.shareId);
    expect(renewed?.expiresAt).toBe(clock.now + SHARE_TTL_MS);
  });

  it("共有の口では旅程の ID を読めない", async () => {
    const { storage, itinerary } = setup();
    const v1 = itinerary();
    await storage.saveItinerary(v1, null);

    expect(await storage.readShare(v1.id)).toBeNull();
  });

  it("旅を消すと、版と共有もいっしょに消える", async () => {
    const { storage, itinerary, mine } = setup();
    const v1 = itinerary();
    await storage.saveItinerary(v1, null);
    await mine.claimTrip(v1.id);
    const share = await mine.createShare(v1.id);

    expect(await mine.deleteTrip(v1.id)).toBe(true);

    expect(await mine.listTrips()).toEqual([]);
    expect(await mine.getTrip(v1.id)).toBeNull();
    expect(await storage.readUnowned(v1.id)).toBeNull();
    expect(await storage.readShare(share?.shareId ?? "")).toBeNull();
  });

  it("自分の旅をすべて消すと、残す前の旅程と共有も消える。数えるのは残した旅", async () => {
    const { storage, itinerary, owner, mine } = setup();
    const a = itinerary();
    const b = itinerary();
    const draft = itinerary();
    for (const it of [a, b]) {
      await storage.saveItinerary(it, null);
      await mine.claimTrip(it.id);
    }
    await storage.saveItinerary(draft, owner);
    const share = await mine.createShare(draft.id);

    expect(await mine.deleteAllTrips()).toBe(2);

    expect(await mine.listTrips()).toEqual([]);
    expect(await mine.getTrip(draft.id)).toBeNull();
    expect(await storage.readShare(share?.shareId ?? "")).toBeNull();
  });

  it("期限を過ぎた残す前の旅程も、すべて消すと消える", async () => {
    const { clock, storage, itinerary, owner, mine } = setup();
    const savedAt = clock.now;
    const draft = itinerary();
    await storage.saveItinerary(draft, owner);

    clock.now += SHARE_TTL_MS + 1;
    await mine.deleteAllTrips();

    // TTL で消えるまでは文書が残るので、時計を戻して、本当に消えたことを確かめる
    clock.now = savedAt;
    expect(await mine.getTrip(draft.id)).toBeNull();
  });

  it("すべて消しても、ほかの利用者の旅には届かない", async () => {
    const { storage, itinerary, mine } = setup();
    const theirs = itinerary();
    const other = storage.forOwner(ownerIdOf(`other-${randomUUID()}`));
    await storage.saveItinerary(theirs, null);
    await other.claimTrip(theirs.id);

    expect(await mine.deleteAllTrips()).toBe(0);

    expect((await other.getTrip(theirs.id))?.itinerary).toEqual(theirs);
  });

  it("一覧は新しく保存した順で、見出しは旅程から取り出す", async () => {
    const { clock, storage, itinerary, mine } = setup();
    const a = { ...itinerary(), title: "古い旅" };
    const b = { ...itinerary(), title: "新しい旅" };
    await storage.saveItinerary(a, null);
    clock.now += 1000;
    await storage.saveItinerary(b, null);
    await mine.claimTrip(a.id);
    await mine.claimTrip(b.id);

    const trips = await mine.listTrips();

    expect(trips.map((trip) => trip.title)).toEqual(["新しい旅", "古い旅"]);
    expect(trips[0]?.date).toBe(b.days[0]?.date);
  });

  it(`版は新しいものから ${MAX_VERSIONS} まで残す`, async () => {
    const { storage, itinerary, mine } = setup();
    const v1 = itinerary(1);
    await storage.saveItinerary(v1, null);
    await mine.claimTrip(v1.id);
    for (let version = 2; version <= MAX_VERSIONS + 2; version += 1) {
      await storage.saveItinerary({ ...v1, version }, null);
    }

    const detail = await mine.getTrip(v1.id);

    expect(detail?.versions).toHaveLength(MAX_VERSIONS);
    expect(detail?.versions[0]).toBe(3);
  });

  it("文書の ID の形でない ID は、ほかの文書を指せず、ないものとして扱う", async () => {
    const { storage, itinerary, owner, mine } = setup();
    const v1 = itinerary();
    await storage.saveItinerary(v1, owner);
    const versionPath = `${v1.id}/versions/000001`;

    expect(await storage.readUnowned(versionPath)).toBeNull();
    expect(await storage.readShare(`sh-a/${v1.id}`)).toBeNull();
    expect(await storage.getSession(`a/b/${v1.id}`)).toBeNull();
    expect(await mine.getTrip(versionPath)).toBeNull();
    expect(await mine.deleteTrip(versionPath)).toBe(false);
    expect(await mine.createShare(versionPath)).toBeNull();
    expect((await mine.claimTrip(versionPath)).status).toBe("not_found");
  });

  it("相談の途中の状態を残し、6時間使われなければ読めなくなる", async () => {
    const { clock, storage } = setup();
    const snapshot = snapshotAt(clock.now);
    await storage.saveSession(snapshot);

    expect(await storage.getSession(snapshot.id)).toEqual({ ...snapshot, ownerUid: null });
    clock.now += SESSION_STATE_TTL_MS + 1;
    expect(await storage.getSession(snapshot.id)).toBeNull();
  });

  it("相談の持ち主は残り、持ち主のない書き込みでは消えない", async () => {
    const { clock, storage, owner } = setup();
    const snapshot = snapshotAt(clock.now);
    await storage.saveSession({ ...snapshot, ownerUid: owner });

    await storage.saveSession({ ...snapshot, ownerUid: null, stage: "shiori" });

    const saved = await storage.getSession(snapshot.id);
    expect(saved?.ownerUid).toBe(owner satisfies OwnerId);
    expect(saved?.stage).toBe("shiori");
  });

  it("相談の持ち主は、別の持ち主の書き込みでも変わらない", async () => {
    const { clock, storage, owner } = setup();
    const snapshot = snapshotAt(clock.now);
    await storage.saveSession({ ...snapshot, ownerUid: owner });

    await storage.saveSession({ ...snapshot, ownerUid: `other-${randomUUID()}` });

    expect((await storage.getSession(snapshot.id))?.ownerUid).toBe(owner);
  });

  it("持ち主の項目のない、前の形の相談は、持ち主のない相談として読む", async () => {
    const { clock, storage } = setup();
    const snapshot = snapshotAt(clock.now);
    await storage.saveSession(snapshot);

    expect((await storage.getSession(snapshot.id))?.ownerUid).toBeNull();
  });
}
