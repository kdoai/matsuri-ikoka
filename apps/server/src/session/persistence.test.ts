import { fictionalCandidate, fictionalItinerary } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it, vi } from "vitest";
import { MemoryTripStorage } from "../storage/memory";
import { ownerIdOf } from "../storage/owner";
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

  describe("持ち主のない前の形の相談が、残した旅程を指しているとき", () => {
    const owner = ownerIdOf("user-1");

    async function legacy() {
      const { storage, a } = instances();
      const itinerary = fictionalItinerary();
      const session = a.sessions.create();
      session.stage = "shiori";
      session.candidates = [];
      session.itineraryId = itinerary.id;
      a.itineraries.save(itinerary, null);
      await a.persistence.saveSession(session);
      await a.persistence.flush();
      await storage.forOwner(owner).claimTrip(itinerary.id);
      const sessions = new SessionStore();
      const itineraries = new ItineraryStore();
      const fresh = new StoragePersistence({ storage, sessions, itineraries });
      return { fresh, itineraries, itinerary, sessionId: session.id };
    }

    it("ログインなしで開くと、旅程を外して、旅程のない相談として続ける", async () => {
      const { fresh, sessionId } = await legacy();

      const restored = await fresh.load(sessionId);

      expect(restored?.itineraryId).toBeNull();
      expect(restored?.stage).toBe("hearing");
    });

    it("候補があれば、候補の段階まで戻す", async () => {
      const { storage, a } = instances();
      const session = a.sessions.create();
      session.stage = "itinerary";
      session.itineraryId = "trip-gone";
      session.candidates = [fictionalCandidate()];
      await a.persistence.saveSession(session);
      const fresh = new StoragePersistence({
        storage,
        sessions: new SessionStore(),
        itineraries: new ItineraryStore(),
      });

      const restored = await fresh.load(session.id);

      expect(restored?.itineraryId).toBeNull();
      expect(restored?.stage).toBe("candidates");
    });

    it("旅程の持ち主が開けば、旅程ごと戻す", async () => {
      const { fresh, itineraries, itinerary, sessionId } = await legacy();

      const restored = await fresh.load(sessionId, owner);

      expect(restored?.itineraryId).toBe(itinerary.id);
      expect(restored?.stage).toBe("shiori");
      expect(itineraries.get(itinerary.id)).toEqual(itinerary);
    });

    it("ほかの利用者が開いても、旅程は読めない", async () => {
      const { fresh, itineraries, itinerary, sessionId } = await legacy();

      const restored = await fresh.load(sessionId, ownerIdOf("user-2"));

      expect(restored?.itineraryId).toBeNull();
      expect(itineraries.get(itinerary.id)).toBeUndefined();
    });
  });

  it("旅程の読みに失敗しても相談は止めず、ログに文を残さない", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { storage, a } = instances();
    const session = a.sessions.create();
    session.itineraryId = "trip-unreadable";
    await a.persistence.saveSession(session);
    const failing = new Proxy(storage, {
      get(target, name) {
        if (name === "readUnowned") {
          return async () => {
            throw new Error("読めません：ひみつの値");
          };
        }
        const value = Reflect.get(target, name, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const fresh = new StoragePersistence({
      storage: failing,
      sessions: new SessionStore(),
      itineraries: new ItineraryStore(),
    });

    const restored = await fresh.load(session.id);

    expect(restored?.itineraryId).toBeNull();
    expect(error.mock.calls.flat().join(" ")).toContain("itinerary_read");
    expect(error.mock.calls.flat().join(" ")).not.toContain("ひみつの値");
    error.mockRestore();
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
