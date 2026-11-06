import { fictionalItinerary } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { MemoryTripStorage } from "../storage/memory";
import { StoragePersistence } from "./persistence";
import { ItineraryStore, SessionStore } from "./sessionStore";

/** 同じ保存の口を使う、別々のインスタンス */
function instances() {
  const storage = new MemoryTripStorage();
  const make = () => {
    const sessions = new SessionStore();
    const itineraries = new ItineraryStore();
    const persistence = new StoragePersistence({ storage, sessions, itineraries });
    return { sessions, itineraries, persistence };
  };
  return { storage, a: make(), b: make() };
}

describe("StoragePersistence", () => {
  it("手元の写しに保存した旅程の版を、保存の口に書く", async () => {
    const { storage, a } = instances();
    const itinerary = fictionalItinerary();

    a.itineraries.save(itinerary, null);
    a.itineraries.save({ ...itinerary, version: 2 }, null);
    await a.persistence.flush();

    expect((await storage.readUnowned(itinerary.id))?.version).toBe(2);
  });

  it("別のインスタンスに届いた相談を、条件・段階・旅程ごと戻す", async () => {
    const { a, b } = instances();
    const session = a.sessions.create();
    const itinerary = fictionalItinerary();
    session.stage = "itinerary";
    session.conditions = { origin: "みなと中央駅" };
    session.itineraryId = itinerary.id;
    session.agentSessionId = "agent-1";
    a.itineraries.save(itinerary, null);
    await a.persistence.saveSession(session);

    const restored = await b.persistence.load(session.id);

    expect(restored?.stage).toBe("itinerary");
    expect(restored?.conditions).toEqual({ origin: "みなと中央駅" });
    expect(restored?.itineraryId).toBe(itinerary.id);
    // Agent SDK の会話の記録は前のインスタンスにしかないので、続きは相談の状態から始める
    expect(restored?.agentSessionId).toBeNull();
    expect(b.itineraries.get(itinerary.id)).toEqual(itinerary);
    expect(b.sessions.get(session.id)).toBe(restored);
  });

  it("残していない相談は見つからない", async () => {
    const { b } = instances();
    expect(await b.persistence.load("s-none")).toBeUndefined();
  });

  it("前の形で保存した旅程は、共有の URL から読めない", async () => {
    const { storage, a } = instances();
    const itinerary = fictionalItinerary();
    await storage.saveItinerary({ ...itinerary, items: [] } as never, null);

    expect(await a.persistence.readItinerary(itinerary.id, null)).toBeUndefined();
  });

  it("保存の口に書けなくても、相談は止めない", async () => {
    const storage = new MemoryTripStorage();
    storage.saveItinerary = async () => {
      throw new Error("down");
    };
    storage.saveSession = async () => {
      throw new Error("down");
    };
    const sessions = new SessionStore();
    const itineraries = new ItineraryStore();
    const persistence = new StoragePersistence({ storage, sessions, itineraries });
    const session = sessions.create();
    itineraries.save(fictionalItinerary(), null);

    await expect(persistence.flush()).resolves.toBeUndefined();
    await expect(persistence.saveSession(session)).resolves.toBeUndefined();
  });
});
