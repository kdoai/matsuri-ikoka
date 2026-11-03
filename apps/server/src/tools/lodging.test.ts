import { LodgingSearchSchema } from "@matsuri-ikoka/schema";
import { describe, expect, it } from "vitest";
import {
  createFictionalLodging,
  createLodgingService,
  createRakutenLodging,
  RAKUTEN_VACANT_HOTEL_URL,
  rakutenGuestParams,
  readVacantHotels,
} from "./lodging";

const now = () => "2026-08-01T10:00:00+09:00";
const checked = { checkedAt: now(), checkedOn: "2026-08-01" };
const query = {
  checkIn: "2026-08-15",
  nights: 1,
  party: { adults: 2, children: 0 },
  near: { lat: 35.12, lng: 136.08 },
  radiusKm: 3,
};

/** 空室検索の返答と同じ形の、架空の宿の返答 */
function hotel(no: number, name: string, plans: { total: number; reserveUrl: string }[]) {
  return {
    hotel: [
      {
        hotelBasicInfo: {
          hotelNo: no,
          hotelName: name,
          hotelInformationUrl: `https://travel.rakuten.co.jp/HOTEL/${no}/`,
          planListUrl: `https://hotel.travel.rakuten.co.jp/hotelinfo/plan/${no}`,
          hotelMinCharge: 5000,
          latitude: 35.121,
          longitude: 136.081,
        },
      },
      ...plans.map((plan) => ({
        roomInfo: [
          { roomBasicInfo: { roomName: "和室", reserveUrl: plan.reserveUrl } },
          {
            dailyCharge: {
              stayDate: "2026-08-15",
              rakutenCharge: plan.total / 2,
              total: plan.total,
              chargeFlag: 0,
            },
          },
        ],
      })),
    ],
  };
}

describe("readVacantHotels", () => {
  it("宿ごとにいちばん安いプランの1泊目の合計と、その予約のページを使い、安い順に並べる", () => {
    const json = {
      hotels: [
        hotel(101, "鈴鳴の宿", [
          { total: 30000, reserveUrl: "https://hotel.travel.rakuten.co.jp/a" },
          { total: 22000, reserveUrl: "https://hotel.travel.rakuten.co.jp/b" },
        ]),
        hotel(102, "河原の宿", [
          { total: 18000, reserveUrl: "https://hotel.travel.rakuten.co.jp/c" },
        ]),
      ],
    };
    const offers = readVacantHotels(json, checked);
    expect(offers.map((o) => [o.id, o.nightlyTotalYen, o.bookingUrl])).toEqual([
      ["rakuten-102", 18000, "https://hotel.travel.rakuten.co.jp/c"],
      ["rakuten-101", 22000, "https://hotel.travel.rakuten.co.jp/b"],
    ]);
    expect(offers[0]?.source.title).toContain("Supported by Rakuten Developers");
    expect(offers[0]?.checkedAt).toBe(now());
  });

  it("プランの料金がなければ、宿の最安値の目安を使う", () => {
    const json = { hotels: [hotel(103, "鈴鳴の宿", [])] };
    expect(readVacantHotels(json, checked)[0]?.nightlyTotalYen).toBe(5000);
  });

  it("楽天以外・https 以外の URL は使わず、ページの URL がなければ宿ごと除く", () => {
    const bad = hotel(104, "鈴鳴の宿", [{ total: 20000, reserveUrl: "https://example.com/phish" }]);
    expect(readVacantHotels({ hotels: [bad] }, checked)[0]?.bookingUrl).toBe(
      "https://hotel.travel.rakuten.co.jp/hotelinfo/plan/104",
    );
    const noPage = hotel(105, "鈴鳴の宿", []);
    (
      noPage.hotel[0] as { hotelBasicInfo: Record<string, unknown> }
    ).hotelBasicInfo.hotelInformationUrl = "javascript:alert(1)";
    expect(readVacantHotels({ hotels: [noPage] }, checked)).toEqual([]);
  });

  it("名前の制御文字と余分な空白を除き、日本の外の位置は使わない", () => {
    const json = hotel(106, "  鈴鳴\u0007の\n宿  ", []);
    const basic = (json.hotel[0] as { hotelBasicInfo: Record<string, unknown> }).hotelBasicInfo;
    basic.latitude = 128216.17;
    const [offer] = readVacantHotels({ hotels: [json] }, checked);
    expect(offer?.name).toBe("鈴鳴の 宿");
    expect(offer?.location).toBeNull();
  });

  it("形の違う返答は空にする", () => {
    expect(readVacantHotels({ error: "wrong_parameter" }, checked)).toEqual([]);
    expect(readVacantHotels(null, checked)).toEqual([]);
  });

  it("取り出した結果は宿の空きのスキーマに合う", () => {
    const offers = readVacantHotels(
      {
        hotels: [
          hotel(107, "鈴鳴の宿", [
            { total: 20000, reserveUrl: "https://hotel.travel.rakuten.co.jp/d" },
          ]),
        ],
      },
      checked,
    );
    const search = { checkIn: "2026-08-15", checkOut: "2026-08-16", searchedAt: now(), offers };
    expect(LodgingSearchSchema.safeParse(search).success).toBe(true);
  });
});

describe("rakutenGuestParams", () => {
  it("小学生は高学年、幼児は食事と布団なしとして数え、1部屋で調べる", () => {
    expect(rakutenGuestParams({ adults: 2, children: 2, infants: 1 })).toEqual({
      adultNum: "2",
      upClassNum: "1",
      infantWithoutMBNum: "1",
      roomNum: "1",
    });
  });

  it("どれかが10人を超えたら調べない", () => {
    expect(rakutenGuestParams({ adults: 11, children: 0 })).toBeNull();
  });
});

describe("createRakutenLodging", () => {
  function fakeFetch(responses: Response[]) {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: init?.headers as Record<string, string> });
      return responses.shift() ?? new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;
    return { fn, calls };
  }
  const signal = new AbortController().signal;

  it("キーはヘッダーで送り、期間・人数・位置・半径を入力にする", async () => {
    const { fn, calls } = fakeFetch([new Response(JSON.stringify({ hotels: [] }))]);
    const service = createRakutenLodging({
      applicationId: "app-id",
      accessKey: "test-key",
      allowedSite: "https://example.com/",
      fetch: fn,
      now,
      minIntervalMs: 0,
    });
    const outcome = await service.search({ ...query, nights: 2 }, signal);
    expect(outcome).toEqual({
      status: "ok",
      search: { checkIn: "2026-08-15", checkOut: "2026-08-17", searchedAt: now(), offers: [] },
    });
    const url = new URL(calls[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(RAKUTEN_VACANT_HOTEL_URL);
    expect(url.searchParams.get("accessKey")).toBeNull();
    expect(calls[0]!.headers.accessKey).toBe("test-key");
    expect(calls[0]!.headers.origin).toBe("https://example.com");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      checkinDate: "2026-08-15",
      checkoutDate: "2026-08-17",
      datumType: "1",
      latitude: "35.120000",
      searchRadius: "3.0",
      adultNum: "2",
      sort: "+roomCharge",
    });
  });

  it("404 は空きなし、429 は調べられない", async () => {
    const { fn } = fakeFetch([
      new Response("{}", { status: 404 }),
      new Response("{}", { status: 429 }),
    ]);
    const service = createRakutenLodging({
      applicationId: "a",
      accessKey: "k",
      fetch: fn,
      now,
      minIntervalMs: 0,
    });
    const empty = await service.search(query, signal);
    expect(empty.status === "ok" && empty.search.offers).toEqual([]);
    const busy = await service.search({ ...query, checkIn: "2026-08-20" }, signal);
    expect(busy.status).toBe("unavailable");
  });

  it("同じ条件は短い間だけ使い回し、API を呼び直さない", async () => {
    const { fn, calls } = fakeFetch([new Response(JSON.stringify({ hotels: [] }))]);
    const service = createRakutenLodging({
      applicationId: "a",
      accessKey: "k",
      fetch: fn,
      now,
      minIntervalMs: 0,
    });
    await service.search(query, signal);
    await service.search(query, signal);
    expect(calls).toHaveLength(1);
  });

  it("接続できなければ調べられない", async () => {
    const fn = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    const service = createRakutenLodging({
      applicationId: "a",
      accessKey: "k",
      fetch: fn,
      now,
      minIntervalMs: 0,
    });
    expect((await service.search(query, signal)).status).toBe("unavailable");
  });
});

describe("createFictionalLodging", () => {
  it("架空の宿は名前に（架空）と付け、URL は example.com", async () => {
    const outcome = await createFictionalLodging({ now }).search(
      query,
      new AbortController().signal,
    );
    if (outcome.status !== "ok") throw new Error("ok のはず");
    expect(LodgingSearchSchema.safeParse(outcome.search).success).toBe(true);
    for (const offer of outcome.search.offers) {
      expect(offer.name.startsWith("（架空）")).toBe(true);
      expect(new URL(offer.bookingUrl).hostname).toBe("example.com");
    }
  });
});

describe("createLodgingService", () => {
  it("キーがそろえば楽天トラベル、なければ開発では架空、本番では調べられない", async () => {
    const keys = { RAKUTEN_APPLICATION_ID: "a", RAKUTEN_ACCESS_KEY: "k" };
    expect(createLodgingService(keys, { production: true, now }).provider).toBe("rakuten");
    expect(createLodgingService({}, { production: false, now }).provider).toBe("fictional");
    const off = createLodgingService({}, { production: true, now });
    expect((await off.search(query, new AbortController().signal)).status).toBe("unavailable");
  });

  it("許可されたサイトは https の公開の URL だけ", () => {
    expect(() =>
      createLodgingService(
        { RAKUTEN_ALLOWED_SITE: "http://localhost" },
        { production: false, now },
      ),
    ).toThrow();
  });
});
