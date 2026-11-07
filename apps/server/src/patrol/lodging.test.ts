import type { GuideNotice, Itinerary, LodgingOffer, LodgingSearch } from "@matsuri-ikoka/schema";
import { fictionalItinerary, fictionalPlannedItinerary } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it, vi } from "vitest";
import type { LodgingOutcome, LodgingQuery, LodgingService } from "../tools/lodging";
import { checkTripLodging, type LodgingBudget } from "./lodging";
import { noticeFor } from "./notices";
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

const newBudget = (remaining = 10): LodgingBudget => ({ remaining, skipped: 0 });

const run = (
  itinerary: Itinerary,
  lodging: LodgingService,
  over: { notices?: GuideNotice[]; budget?: LodgingBudget } = {},
) =>
  checkTripLodging({
    itinerary,
    lodging,
    venue: { lat: 35.12, lng: 136.08 },
    notices: over.notices ?? [],
    now: NOW,
    budget: over.budget ?? newBudget(),
    signal: new AbortController().signal,
  });

/** 変化を、その旅に届いた通知にする（次の回の状態を調べるため） */
const delivered = (itinerary: Itinerary, changes: Awaited<ReturnType<typeof run>>) =>
  changes.map((change, index) =>
    noticeFor({
      change,
      tripId: itinerary.id,
      itinerary,
      festivalName: "鈴鳴灯籠まつり",
      now: NOW + index,
    }),
  );

describe("checkTripLodging", () => {
  const planned = () => withStay([offer("a", 10_000)]);

  it("候補の宿がまだ出ていれば、変化にしない。料金が動いただけでも知らせない", async () => {
    const lodging = service([offer("a", 12_000)]);

    expect(await run(planned(), lodging)).toEqual([]);
    expect(lodging.queries[0]).toMatchObject({ nights: 1, near: { lat: 35.12, lng: 136.08 } });
  });

  it("結果が上限より少ないのに候補の宿が出なくなったら、空きがなくなった変化にする", async () => {
    const [change] = await run(planned(), service([offer("b", 15_000)]));

    expect(change?.content).toMatchObject({
      kind: "availability",
      lodgingName: "（架空）宿 a",
      available: false,
      nightlyTotalYen: null,
    });
    expect(change?.sources[0]).toMatchObject({ confidence: "single", checkedAt: "2026-08-10" });
  });

  it("結果が上限まであるときは、候補が出ていなくても空きがないとは言わない", async () => {
    const cheaper = ["b", "c", "d", "e", "f"].map((id) => offer(id, 8_000));
    const pricier = ["b", "c", "d", "e", "f"].map((id) => offer(id, 20_000));

    // より安い宿に押し出された
    expect(await run(planned(), service(cheaper))).toEqual([]);
    // 上位に高い宿しかなくても、候補が値上がりしただけかもしれない
    expect(await run(planned(), service(pricier))).toEqual([]);
  });

  it("候補の宿の空きがなくなったあと、戻ったら知らせる。同じ状態では知らせない", async () => {
    const itinerary = planned();
    const first = await run(itinerary, service([]));
    const notices = delivered(itinerary, first);
    expect(first[0]?.content).toMatchObject({ available: false });

    // 同じ状態のまま
    expect(await run(itinerary, service([]), { notices })).toEqual([]);

    const back = await run(itinerary, service([offer("a", 13_000)]), { notices });
    expect(back[0]?.content).toMatchObject({
      available: true,
      lodgingName: "（架空）宿 a",
      nightlyTotalYen: 13_000,
    });
    expect(back[0]?.fingerprint).not.toBe(first[0]?.fingerprint);
  });

  it("空きなし→空きあり→空きなしの2度目も、別の通知として届く", async () => {
    const itinerary = planned();
    const first = await run(itinerary, service([]));
    const second = await run(itinerary, service([offer("a", 13_000)]), {
      notices: delivered(itinerary, first),
    });
    const third = await run(itinerary, service([]), {
      notices: delivered(itinerary, [...first, ...second]),
    });

    expect(third[0]?.content).toMatchObject({ available: false });
    expect(third[0]?.fingerprint).not.toBe(first[0]?.fingerprint);
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

  it("最安の宿が替わっても、状態が同じなら別の通知を作らない", async () => {
    const itinerary = withStay([]);
    const first = await run(itinerary, service([offer("b", 15_000)]));

    const second = await run(itinerary, service([offer("c", 9_000)]), {
      notices: delivered(itinerary, first),
    });

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  it("空きの指紋は泊まりの単位で、宿の名前や料金に左右されない", async () => {
    const [first] = await run(withStay([]), service([offer("b", 15_000)]));
    const [second] = await run(withStay([]), service([offer("c", 18_000)]));

    expect(first?.fingerprint).toBe(second?.fingerprint);
  });

  it("候補の宿の施設番号が分かれば、その宿に絞って確かめる", async () => {
    const itinerary = withStay([offer("rakuten-123", 10_000)]);
    const lodging = service([offer("rakuten-123", 12_000)]);

    expect(await run(itinerary, lodging)).toEqual([]);

    expect(lodging.queries[0]?.hotelNos).toEqual(["123"]);
  });

  it("施設番号で絞って出なければ、結果の数に関わらず空きがないと分かる", async () => {
    const itinerary = withStay([offer("rakuten-123", 10_000)]);

    const [none] = await run(itinerary, service([]));

    expect(none?.content).toMatchObject({
      available: false,
      lodgingName: "（架空）宿 rakuten-123",
    });
  });

  it("施設番号の分からない宿は、周辺を検索する", async () => {
    const lodging = service([offer("a", 10_000)]);

    await run(planned(), lodging);

    expect(lodging.queries[0]?.hotelNos).toBeUndefined();
  });

  it("Web で調べた宿は空きを確かめていないので、比べない", async () => {
    const search = vi.fn();
    const lodging: LodgingService = { provider: "rakuten", search };

    expect(await run(withStay([offer("a", null)], "web"), lodging)).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it("調べられないときは、変化にしない", async () => {
    expect(await run(planned(), service("unavailable"))).toEqual([]);
  });

  it("泊まりのない旅は調べず、枠も使わない", async () => {
    const lodging = service([]);
    const budget = newBudget(1);

    expect(await run(fictionalItinerary(), lodging, { budget })).toEqual([]);
    expect(lodging.queries).toEqual([]);
    expect(budget.remaining).toBe(1);
  });

  it("枠を減らすのは実際に検索を呼んだときだけで、足りない分は数える", async () => {
    const lodging = service([offer("a", 10_000)]);
    const used = newBudget(1);
    await run(planned(), lodging, { budget: used });
    expect(used).toEqual({ remaining: 0, skipped: 0 });

    const empty = newBudget(0);
    await run(planned(), lodging, { budget: empty });
    expect(empty).toEqual({ remaining: 0, skipped: 1 });
    expect(lodging.queries).toHaveLength(1);
  });
});
