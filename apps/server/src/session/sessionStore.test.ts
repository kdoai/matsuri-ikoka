import { fictionalItinerary } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { ITINERARY_TTL_MS, ItineraryStore, SessionStore } from "./sessionStore";

describe("ItineraryStore の rememberLatest", () => {
  it("手元の版以上のときだけ写しに置き、手元のほうが新しければ、それを返す", () => {
    const store = new ItineraryStore();
    const v2 = { ...fictionalItinerary(), version: 2 };
    store.remember(v2);

    expect(store.rememberLatest({ ...v2, version: 1 })).toBe(v2);
    expect(store.get(v2.id)?.version).toBe(2);
    const v3 = { ...v2, version: 3 };
    expect(store.rememberLatest(v3)).toBe(v3);
    expect(store.get(v2.id)?.version).toBe(3);
  });
});

describe("SessionStore", () => {
  it("数の上限を超えたら、いちばん長く使われていない相談から消す", () => {
    const removed: string[] = [];
    const sessions = new SessionStore({ max: 2, onRemove: (s) => removed.push(s.id) });
    const a = sessions.create();
    const b = sessions.create();
    // a を使ったので、いちばん長く使われていないのは b
    sessions.get(a.id);

    const c = sessions.create();

    expect(removed).toEqual([b.id]);
    expect(sessions.size).toBe(2);
    expect(sessions.get(a.id)).toBe(a);
    expect(sessions.get(c.id)).toBe(c);
  });

  it("返事を作っている途中の相談は、上限でも消さない", () => {
    const sessions = new SessionStore({ max: 1 });
    const busy = sessions.create();
    busy.busy = true;

    sessions.create();

    expect(sessions.get(busy.id)).toBe(busy);
  });
});

describe("ItineraryStore", () => {
  it("最後に保存してから30日で消す", () => {
    let now = 0;
    const itineraries = new ItineraryStore({ now: () => now });
    const itinerary = fictionalItinerary();
    itineraries.save(itinerary, null);

    now = ITINERARY_TTL_MS;
    expect(itineraries.get(itinerary.id)).toEqual(itinerary);
    now = ITINERARY_TTL_MS + 1;
    expect(itineraries.get(itinerary.id)).toBeUndefined();
  });

  it("保存し直すと期限が延びる。数の上限を超えたら古いものから消す", () => {
    let now = 0;
    const itineraries = new ItineraryStore({ now: () => now, max: 2 });
    const make = (id: string) => ({ ...fictionalItinerary(), id });
    itineraries.save(make("a"), null);
    itineraries.save(make("b"), null);
    now = 10;
    itineraries.save(make("a"), null);

    itineraries.save(make("c"), null);

    expect(itineraries.get("b")).toBeUndefined();
    expect(itineraries.get("a")?.id).toBe("a");
    expect(itineraries.get("c")?.id).toBe("c");
  });

  it("期限を過ぎた旅程を片付ける", () => {
    let now = 0;
    const itineraries = new ItineraryStore({ now: () => now });
    itineraries.save(fictionalItinerary(), null);

    now = ITINERARY_TTL_MS + 1;
    itineraries.sweep();

    expect(itineraries.size).toBe(0);
  });
});
