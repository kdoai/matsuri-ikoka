import { randomUUID } from "node:crypto";
import { DEFAULT_PREFERENCES, type Itinerary } from "@matsuri-ikoka/schema";
import { fictionalItinerary } from "@matsuri-ikoka/schema/testing";
import { expect, it } from "vitest";
import { type OwnerId, ownerIdOf } from "./owner";
import {
  MAX_VERSIONS,
  SESSION_STATE_TTL_MS,
  type SessionSnapshot,
  SHARE_REUSE_MIN_REMAINING_MS,
  SHARE_TTL_MS,
  TRIP_DOC_KINDS,
  TripGoneError,
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

  it("持ち主のない旅程は、版を指して前の版も読める。ない版は null", async () => {
    const { storage, itinerary } = setup();
    const v1 = itinerary(1);
    await storage.saveItinerary(v1, null);
    await storage.saveItinerary({ ...v1, version: 2, title: "二つめの版" }, null);

    const first = await storage.readUnowned(v1.id, 1);

    expect(first?.version).toBe(1);
    expect(first?.itinerary).toEqual(v1);
    expect(await storage.readUnowned(v1.id, 3)).toBeNull();
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

  it("すべて消すと、自分の相談の途中の状態も消え、ほかの人の相談は残る", async () => {
    const { storage, owner, mine } = setup();
    const snapshot = (ownerUid: string | null): SessionSnapshot => ({
      id: `s-${randomUUID()}`,
      createdAt: Date.UTC(2026, 7, 3),
      updatedAt: Date.UTC(2026, 7, 3),
      stage: "hearing",
      conditions: {},
      preferences: DEFAULT_PREFERENCES,
      candidates: [],
      selectedFestivalId: null,
      itineraryId: null,
      ownerUid,
      replay: null,
    });
    const own = snapshot(owner);
    const others = snapshot(`other-${randomUUID()}`);
    const nobody = snapshot(null);
    for (const session of [own, others, nobody]) await storage.saveSession(session);

    await mine.deleteAllTrips();

    expect(await storage.getSession(own.id)).toBeNull();
    expect((await storage.getSession(others.id))?.id).toBe(others.id);
    expect((await storage.getSession(nobody.id))?.id).toBe(nobody.id);
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

  it("旅の下のデータを、持ち主と旅ごとに読み書きする", async () => {
    const { storage, itinerary, mine } = setup();
    const trip = itinerary();
    const another = itinerary();
    await storage.saveItinerary(trip, null);
    await mine.claimTrip(trip.id);
    const docs = mine.tripDocs(trip.id);

    await docs.put("memo", "m-1", { text: "ゆっくり歩く" });
    await docs.put("memo", "m-2", { text: "辛いものは避ける" });
    await docs.put("notices", "m-1", { kind: "weather" });

    expect(await docs.get("memo", "m-1")).toEqual({ text: "ゆっくり歩く" });
    expect(await docs.list("memo")).toHaveLength(2);
    expect(await docs.get("notices", "m-1")).toEqual({ kind: "weather" });
    // 別の旅と別の人の置き場には届かない
    expect(await mine.tripDocs(another.id).get("memo", "m-1")).toBeNull();
    const other = storage.forOwner(ownerIdOf(`other-${randomUUID()}`));
    expect(await other.tripDocs(trip.id).get("memo", "m-1")).toBeNull();
    expect(await other.tripDocs(trip.id).list("memo")).toEqual([]);
    expect(await other.tripDocs(trip.id).delete("memo", "m-1")).toBe(false);
    expect(await docs.get("memo", "m-1")).toEqual({ text: "ゆっくり歩く" });

    expect(await docs.delete("memo", "m-1")).toBe(true);
    expect(await docs.delete("memo", "m-1")).toBe(false);
    expect(await docs.get("memo", "m-1")).toBeNull();
  });

  it("旅の下のデータは、文書の ID の形でない ID では、ほかの文書を指せない", async () => {
    const { storage, itinerary, mine } = setup();
    const trip = itinerary();
    await storage.saveItinerary(trip, null);
    await mine.claimTrip(trip.id);
    const docs = mine.tripDocs(trip.id);
    await docs.put("memo", "m-1", { text: "ゆっくり歩く" });

    expect(await docs.get("memo", "../memo/m-1")).toBeNull();
    expect(await docs.delete("memo", "../memo/m-1")).toBe(false);
    await expect(docs.put("memo", "a/b", {})).rejects.toThrow();
    expect(() => mine.tripDocs("a/b")).toThrow();
  });

  it("期限のある旅の下のデータは、期限を過ぎたら読めない", async () => {
    const { clock, storage, itinerary, mine } = setup();
    const trip = itinerary();
    await storage.saveItinerary(trip, null);
    await mine.claimTrip(trip.id);
    const docs = mine.tripDocs(trip.id);
    await docs.put("proposals", "p-1", { summary: "案" }, { expiresAt: clock.now + 1000 });
    await docs.put("memo", "m-1", { text: "残る" });

    expect(await docs.get("proposals", "p-1")).toEqual({ summary: "案" });
    clock.now += 1001;

    expect(await docs.get("proposals", "p-1")).toBeNull();
    expect(await docs.list("proposals")).toEqual([]);
    expect(await docs.get("memo", "m-1")).toEqual({ text: "残る" });
  });

  it("旅を消すと、手帳・通知・提案・見回りの依頼もまるごと消え、ほかの旅には届かない", async () => {
    const { storage, itinerary, mine } = setup();
    const trip = itinerary();
    const keptTrip = itinerary();
    for (const it of [trip, keptTrip]) {
      await storage.saveItinerary(it, null);
      await mine.claimTrip(it.id);
    }
    const docs = mine.tripDocs(trip.id);
    for (const kind of TRIP_DOC_KINDS) await docs.put(kind, "d-1", { kind });
    await mine.tripDocs(keptTrip.id).put("memo", "d-1", { kind: "memo" });

    expect(await mine.deleteTrip(trip.id)).toBe(true);

    for (const kind of TRIP_DOC_KINDS) {
      expect(await docs.get(kind, "d-1"), kind).toBeNull();
      expect(await docs.list(kind), kind).toEqual([]);
    }
    expect(await mine.tripDocs(keptTrip.id).get("memo", "d-1")).toEqual({ kind: "memo" });
  });

  it("ほかの人が旅を消そうとしても、旅の下のデータは消えない", async () => {
    const { storage, itinerary, mine } = setup();
    const trip = itinerary();
    await storage.saveItinerary(trip, null);
    await mine.claimTrip(trip.id);
    await mine.tripDocs(trip.id).put("memo", "m-1", { text: "ゆっくり歩く" });

    const other = storage.forOwner(ownerIdOf(`other-${randomUUID()}`));
    expect(await other.deleteTrip(trip.id)).toBe(false);

    expect(await mine.tripDocs(trip.id).get("memo", "m-1")).toEqual({ text: "ゆっくり歩く" });
  });

  it("自分の旅をすべて消すと、旅の下のデータと使った量も消え、ほかの人には届かない", async () => {
    const { storage, itinerary, mine } = setup();
    const trip = itinerary();
    await storage.saveItinerary(trip, null);
    await mine.claimTrip(trip.id);
    await mine.tripDocs(trip.id).put("memo", "m-1", { text: "ゆっくり歩く" });
    await mine.addGuideUsage(trip.id, "2026-08-03", { turns: 1, costUsd: 0.5 });
    const other = storage.forOwner(ownerIdOf(`other-${randomUUID()}`));
    const theirs = itinerary();
    await storage.saveItinerary(theirs, null);
    await other.claimTrip(theirs.id);
    await other.tripDocs(theirs.id).put("memo", "m-1", { text: "ほかの人の手帳" });
    await other.addGuideUsage(theirs.id, "2026-08-03", { turns: 2, costUsd: 1 });

    await mine.deleteAllTrips();

    expect(await mine.tripDocs(trip.id).get("memo", "m-1")).toBeNull();
    expect((await mine.readGuideUsage(trip.id, "2026-08-03")).user.turns).toBe(0);
    expect(await other.tripDocs(theirs.id).get("memo", "m-1")).toEqual({ text: "ほかの人の手帳" });
    expect((await other.readGuideUsage(theirs.id, "2026-08-03")).user.turns).toBe(2);
  });

  it("消した旅の下には書き戻せず、ないものとして断る", async () => {
    const { storage, itinerary, mine } = setup();
    const trip = itinerary();
    await storage.saveItinerary(trip, null);
    await mine.claimTrip(trip.id);
    const docs = mine.tripDocs(trip.id);
    await docs.put("memo", "m-1", { text: "ゆっくり歩く" });

    await mine.deleteTrip(trip.id);

    await expect(docs.put("memo", "m-2", { text: "書き戻し" })).rejects.toThrow(TripGoneError);
    await expect(docs.put("proposals", "p-1", { summary: "案" })).rejects.toThrow(TripGoneError);
    expect(await docs.list("memo")).toEqual([]);
    expect(await docs.list("proposals")).toEqual([]);
  });

  it("ほかの人の旅とない旅の下には書けない", async () => {
    const { storage, itinerary, mine } = setup();
    const trip = itinerary();
    await storage.saveItinerary(trip, null);
    await mine.claimTrip(trip.id);
    const other = storage.forOwner(ownerIdOf(`other-${randomUUID()}`));

    await expect(other.tripDocs(trip.id).put("memo", "m-1", {})).rejects.toThrow(TripGoneError);
    await expect(mine.tripDocs("trip-none").put("memo", "m-1", {})).rejects.toThrow(TripGoneError);
    expect(await other.tripDocs(trip.id).list("memo")).toEqual([]);
  });

  it("ログインした相談で組んだ残す前の旅の下にも書ける", async () => {
    const { storage, itinerary, owner, mine } = setup();
    const draft = itinerary();
    await storage.saveItinerary(draft, owner);

    await mine.tripDocs(draft.id).put("memo", "m-1", { text: "ゆっくり歩く" });

    expect(await mine.tripDocs(draft.id).get("memo", "m-1")).toEqual({ text: "ゆっくり歩く" });
  });

  it("ガイドの使った量を、利用者と旅ごとに、日ごとに数える", async () => {
    const { storage, mine } = setup();
    const other = storage.forOwner(ownerIdOf(`other-${randomUUID()}`));

    await mine.addGuideUsage("trip-a", "2026-08-03", { turns: 1, costUsd: 0.25 });
    await mine.addGuideUsage("trip-a", "2026-08-03", { turns: 1, costUsd: 0.25 });
    await mine.addGuideUsage("trip-b", "2026-08-03", { turns: 1, costUsd: 1 });

    expect(await mine.readGuideUsage("trip-a", "2026-08-03")).toEqual({
      user: { turns: 3, costUsd: 1.5 },
      trip: { turns: 2, costUsd: 0.5 },
    });
    expect((await mine.readGuideUsage("trip-b", "2026-08-03")).trip.turns).toBe(1);
    expect((await mine.readGuideUsage("trip-a", "2026-08-04")).user.turns).toBe(0);
    expect((await other.readGuideUsage("trip-a", "2026-08-03")).user.turns).toBe(0);
  });

  it("相談の途中の状態を残し、6時間使われなければ読めなくなる", async () => {
    const { clock, storage } = setup();
    const snapshot = snapshotAt(clock.now);
    await storage.saveSession(snapshot);

    expect(await storage.getSession(snapshot.id)).toEqual({ ...snapshot, ownerUid: null });
    clock.now += SESSION_STATE_TTL_MS + 1;
    expect(await storage.getSession(snapshot.id)).toBeNull();
  });

  it("旅程を持つ相談は、渡した期限まで残す。期限のない前の形の保存は6時間", async () => {
    const { clock, storage } = setup();
    const snapshot = snapshotAt(clock.now);
    const expiresAt = clock.now + SHARE_TTL_MS;
    await storage.saveSession({ ...snapshot, expiresAt });

    clock.now += SESSION_STATE_TTL_MS + 1;
    expect((await storage.getSession(snapshot.id))?.itineraryId).toBe("it-1");
    clock.now = expiresAt + 1;
    expect(await storage.getSession(snapshot.id)).toBeNull();
  });

  it("先の旅の旅程と共有は、旅の最終日の数日後まで読める", async () => {
    const { clock, storage, itinerary, mine } = setup();
    const later = itinerary();
    const [day] = fictionalItinerary().days;
    if (day === undefined) throw new Error("架空の旅程に日がありません");
    later.days = [{ ...day, date: "2026-11-03" }];
    await storage.saveItinerary(later, null);
    const draft = itinerary();
    await storage.saveItinerary(draft, mine.owner);
    const share = await mine.createShare(draft.id);
    const farDraft = { ...draft, version: 2, days: later.days };
    await storage.saveItinerary(farDraft, mine.owner);
    const farShare = await mine.createShare(draft.id);
    if (share === null || farShare === null) throw new Error("共有を作れませんでした");

    // 11/3 の3日後の終わり（日本時間）
    const end = Date.parse("2026-11-06T15:00:00Z");
    expect(share.expiresAt).toBe(clock.now + SHARE_TTL_MS);
    expect(farShare.expiresAt).toBe(end);
    expect((await storage.readUnowned(later.id))?.expiresAt).toBe(end);
    clock.now += SHARE_TTL_MS + 1;
    expect((await storage.readUnowned(later.id))?.version).toBe(1);
    expect(await storage.readShare(share.shareId)).toBeNull();
    expect((await storage.readShare(farShare.shareId))?.version).toBe(2);
    clock.now = end + 1;
    expect(await storage.readUnowned(later.id)).toBeNull();
    expect(await storage.readShare(farShare.shareId)).toBeNull();
  });

  it("持ち主が付く前に渡した URL の版は、付く前の最新の版だけを、その期限まで読む", async () => {
    const { clock, storage, itinerary, mine } = setup();
    const v1 = itinerary(1);
    await storage.saveItinerary(v1, null);
    await storage.saveItinerary({ ...v1, version: 2, title: "二つめの版" }, null);
    expect(await storage.readBeforeOwner(v1.id)).toBeNull();
    const expiresAt = (await storage.readUnowned(v1.id))?.expiresAt;

    // 途中でログインした相談が、次の版を保存する
    await storage.saveItinerary({ ...v1, version: 3, title: "三つめの版" }, mine.owner);
    const before = await storage.readBeforeOwner(v1.id);

    expect(await storage.readUnowned(v1.id)).toBeNull();
    expect(before?.version).toBe(2);
    expect((before?.itinerary as Itinerary | undefined)?.title).toBe("二つめの版");
    expect(before?.expiresAt).toBe(expiresAt);
    // 残しても、渡した URL の版と期限は変わらない
    await mine.claimTrip(v1.id);
    expect((await storage.readBeforeOwner(v1.id))?.version).toBe(2);
    clock.now = (expiresAt ?? 0) + 1;
    expect(await storage.readBeforeOwner(v1.id)).toBeNull();
    expect((await mine.getTrip(v1.id))?.version).toBe(3);
  });

  it("はじめから持ち主のある旅程には、持ち主が付く前の版がない", async () => {
    const { storage, itinerary, mine } = setup();
    const v1 = itinerary(1);
    await storage.saveItinerary(v1, mine.owner);
    await storage.saveItinerary({ ...v1, version: 2 }, mine.owner);
    await mine.claimTrip(v1.id);

    expect(await storage.readBeforeOwner(v1.id)).toBeNull();
  });

  it("持ち主のない旅程を残すと、残したときの版を、前に渡した URL で読む", async () => {
    const { storage, itinerary, mine } = setup();
    const v1 = itinerary(1);
    await storage.saveItinerary(v1, null);

    await mine.claimTrip(v1.id);
    await storage.saveItinerary({ ...v1, version: 2, title: "残したあとの版" }, mine.owner);

    expect((await storage.readBeforeOwner(v1.id))?.version).toBe(1);
    expect(await storage.readUnowned(v1.id)).toBeNull();
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
