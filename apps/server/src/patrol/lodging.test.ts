import type { Itinerary, LodgingOffer, LodgingSearch } from "@matsuri-ikoka/schema";
import { fictionalItinerary, fictionalPlannedItinerary } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it, vi } from "vitest";
import type { LodgingOutcome, LodgingQuery, LodgingService } from "../tools/lodging";
import { checkTripLodging } from "./lodging";
import { NOW } from "./testing";

// 宿の空きの見回り。モデルを使わず、今の空室検索の口だけを呼ぶ。宿は架空のもの。

const offer = (id: string, nightlyTotalYen: number | null): LodgingOffer => ({
  id,
  name: `（架空）宿 ${id}`,
  nightlyTotalYen,
  bookingUrl: `https://example.com/lodging/${id}`,
  location: { lat: 35.12, lng: 136.08 },
  checkedAt: "2026-08-01T06:00:00+09:00",
  source: {
    url: `https://example.com/lodging/${id}`,
    checkedAt: "2026-08-01",
    confidence: "single",
  },
});

function withStay(
  offers: LodgingOffer[],
  provider: LodgingSearch["provider"] = "rakuten",
): Itinerary {
  const base = fictionalPlannedItinerary();
  const nights = base.days.length > 1 ? base.days : fictionalItinerary().days;
  return {
    ...base,
    days: nights.map((day, index) =>
      index === 0
        ? {
            ...day,
            stay: {
              area: "鈴鳴町",
              lodging: {
                checkIn: day.date,
                checkOut: nights[1]?.date ?? "2026-08-17",
                searchedAt: "2026-08-01T06:00:00+09:00",
                provider,
                offers,
              },
            },
          }
        : day,
    ),
  };
}

function service(
  offers: LodgingOffer[] | "unavailable",
): LodgingService & { queries: LodgingQuery[] } {
  const queries: LodgingQuery[] = [];
  return {
    provider: "rakuten",
    queries,
    async search(query): Promise<LodgingOutcome> {
      queries.push(query);
      return offers === "unavailable"
        ? { status: "unavailable", reason: "混み合っています" }
        : {
            status: "ok",
            search: {
              checkIn: query.checkIn,
              checkOut: "2026-08-17",
              searchedAt: "2026-08-10T06:00:00+09:00",
              provider: "rakuten",
              offers,
            },
          };
    },
  };
}

const run = (itinerary: Itinerary, lodging: LodgingService) =>
  checkTripLodging({
    itinerary,
    lodging,
    venue: { lat: 35.12, lng: 136.08 },
    now: NOW,
    signal: new AbortController().signal,
  });

describe("checkTripLodging", () => {
  it("候補の宿がまだ出ていれば、変化にしない。料金が動いただけでも知らせない", async () => {
    const lodging = service([offer("a", 12_000)]);

    expect(await run(withStay([offer("a", 10_000)]), lodging)).toEqual([]);
    expect(lodging.queries[0]).toMatchObject({ nights: 1, near: { lat: 35.12, lng: 136.08 } });
  });

  it("候補の宿が出なくなったら、空きがなくなった変化にする", async () => {
    const [change] = await run(withStay([offer("a", 10_000)]), service([offer("b", 15_000)]));

    expect(change?.content).toMatchObject({
      kind: "availability",
      lodgingName: "（架空）宿 a",
      available: false,
      nightlyTotalYen: null,
    });
    expect(change?.sources[0]).toMatchObject({ confidence: "single", checkedAt: "2026-08-10" });
  });

  it("より安い宿に押し出されただけなら、変化にしない", async () => {
    const cheaper = ["b", "c", "d", "e", "f"].map((id) => offer(id, 8_000));

    expect(await run(withStay([offer("a", 10_000)]), service(cheaper))).toEqual([]);
  });

  it("候補がなかった泊まりで宿が出たら、空きが出た変化にする", async () => {
    const [change] = await run(withStay([]), service([offer("b", 15_000)]));

    expect(change?.content).toMatchObject({
      kind: "availability",
      available: true,
      nightlyTotalYen: 15_000,
      bookingUrl: "https://example.com/lodging/b",
    });
  });

  it("同じ変化は同じ値になり、料金が違っても2度通知にしない", async () => {
    const [first] = await run(withStay([]), service([offer("b", 15_000)]));
    const [second] = await run(withStay([]), service([offer("b", 18_000)]));

    expect(first?.fingerprint).toBe(second?.fingerprint);
  });

  it("Web で調べた宿は空きを確かめていないので、比べない", async () => {
    const search = vi.fn();
    const lodging: LodgingService = { provider: "rakuten", search };

    expect(await run(withStay([offer("a", null)], "web"), lodging)).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it("調べられないときは、変化にしない", async () => {
    expect(await run(withStay([offer("a", 10_000)]), service("unavailable"))).toEqual([]);
  });

  it("泊まりのない旅は調べない", async () => {
    const lodging = service([]);

    expect(await run(fictionalItinerary(), lodging)).toEqual([]);
    expect(lodging.queries).toEqual([]);
  });
});
