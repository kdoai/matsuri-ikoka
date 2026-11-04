import type { ItineraryDay } from "@matsuri-ikoka/schema";
import { fictionalItinerary, fictionalLodgingSearch } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { draftFromItinerary } from "./itinerary";
import {
  attachLodging,
  checkLodgingBudget,
  distanceKm,
  lodgingHeadcount,
  stayNights,
} from "./lodging";

describe("lodgingHeadcount", () => {
  it("幼児は予算を割る人数に数えない。シニアは大人に含む", () => {
    expect(lodgingHeadcount({ adults: 3, children: 2, seniors: 1, infants: 1 })).toEqual({
      adults: 3,
      elementary: 1,
      infants: 1,
      payers: 4,
    });
  });

  it("内訳がなければ、子どもは全員小学生として数える", () => {
    expect(lodgingHeadcount({ adults: 2, children: 1 }).payers).toBe(3);
  });
});

describe("stayNights", () => {
  it("チェックインからチェックアウトまでの泊数（月をまたいでも）", () => {
    expect(stayNights("2026-08-15", "2026-08-16")).toBe(1);
    expect(stayNights("2026-08-30", "2026-09-02")).toBe(3);
  });
});

describe("checkLodgingBudget", () => {
  const party = { adults: 2, children: 0 };

  it("1泊の料金（全員分）× 泊数を合計し、1人あたりを切り上げで出す", () => {
    const check = checkLodgingBudget(25001, { party, nights: 2 });
    expect(check).toMatchObject({
      nights: 2,
      totalYen: 50002,
      perPersonYen: 25001,
      perPersonPerNightYen: 12501,
      limitPerPersonYen: null,
      overBudget: null,
      overByPerPersonYen: null,
      tripBudgetPerPersonYen: null,
      overTripBudget: null,
    });
  });

  it("旅全体の予算は、合計で受けたら人数で割り、宿だけで1人あたりを超えるかを出す", () => {
    const family = { adults: 2, children: 1, infants: 1 };
    // 2泊で 60,000円、幼児を除く2人で割ると1人 30,000円
    const total = checkLodgingBudget(30000, {
      party: family,
      nights: 2,
      tripBudget: { yen: 50000, basis: "total" },
    });
    expect(total).toMatchObject({
      perPersonYen: 30000,
      tripBudgetPerPersonYen: 25000,
      overTripBudget: true,
    });
    const perPerson = checkLodgingBudget(30000, {
      party: family,
      nights: 2,
      tripBudget: { yen: 40000, basis: "perPerson" },
    });
    expect(perPerson).toMatchObject({ tripBudgetPerPersonYen: 40000, overTripBudget: false });
  });

  it("1泊あたりの予算は、泊数をかけて上限にする", () => {
    const within = checkLodgingBudget(24000, {
      party,
      nights: 2,
      budget: { perPersonYen: 12000, per: "night" },
    });
    expect(within).toMatchObject({
      limitPerPersonYen: 24000,
      overBudget: false,
      overByPerPersonYen: 0,
    });
    const over = checkLodgingBudget(30000, {
      party,
      nights: 2,
      budget: { perPersonYen: 12000, per: "night" },
    });
    expect(over).toMatchObject({ overBudget: true, overByPerPersonYen: 6000 });
  });

  it("泊まり全体の予算は、そのまま1人あたりの上限にする", () => {
    const check = checkLodgingBudget(20000, {
      party,
      nights: 3,
      budget: { perPersonYen: 25000, per: "trip" },
    });
    expect(check).toMatchObject({
      perPersonYen: 30000,
      overBudget: true,
      overByPerPersonYen: 5000,
    });
  });

  it("幼児は人数に数えずに割る", () => {
    const check = checkLodgingBudget(30000, {
      party: { adults: 2, children: 1, infants: 1 },
      nights: 1,
    });
    expect(check.perPersonYen).toBe(15000);
  });
});

describe("distanceKm", () => {
  it("同じ点は 0、緯度 0.01 度はおよそ 1.1 km", () => {
    const venue = { lat: 35.12, lng: 136.08 };
    expect(distanceKm(venue, venue)).toBe(0);
    expect(distanceKm(venue, { lat: 35.13, lng: 136.08 })).toBe(1.1);
  });
});

describe("attachLodging", () => {
  /** 架空の旅程を、前の夜に泊まる2日の旅程の下書きにする */
  function twoDayDraft() {
    const itinerary = fictionalItinerary();
    const day = itinerary.days[0] as ItineraryDay;
    itinerary.days = [
      {
        ...day,
        date: "2026-08-15",
        stay: { area: "鈴鳴町" },
        items: day.items.map((item) => ({ ...item, id: `d1-${item.id}` })),
      },
      { ...day, date: "2026-08-16" },
    ];
    return { itinerary, draft: draftFromItinerary(itinerary) };
  }

  it("その日にチェックインする宿の候補を、泊まりに付ける", () => {
    const { draft } = twoDayDraft();
    const search = fictionalLodgingSearch();
    const attached = attachLodging(draft, {
      searches: new Map([[search.checkIn, search]]),
      previous: null,
    });
    expect(attached.days[0]?.stay).toEqual({ area: "鈴鳴町", lodging: search });
    expect(attached.days[1]?.stay).toBeNull();
  });

  it("調べていない日は、前の版の同じ日の候補を引き継ぐ", () => {
    const { itinerary, draft } = twoDayDraft();
    const search = fictionalLodgingSearch();
    itinerary.days[0]!.stay = { area: "鈴鳴町", lodging: search };
    const attached = attachLodging(draft, { searches: new Map(), previous: itinerary });
    expect(attached.days[0]?.stay?.lodging).toEqual(search);
  });

  it("調べた結果も前の版もなければ、地域だけにする（書かれた候補は使わない）", () => {
    const { draft } = twoDayDraft();
    draft.days[0]!.stay = { area: "鈴鳴町", lodging: fictionalLodgingSearch() };
    const attached = attachLodging(draft, { searches: new Map(), previous: null });
    expect(attached.days[0]?.stay).toEqual({ area: "鈴鳴町" });
  });
});
