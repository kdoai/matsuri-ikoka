import { LodgingOfferSchema } from "@matsuri-ikoka/schema";
import { describe, expect, it } from "vitest";
import {
  type LodgingResearchInput,
  lodgingFromVenue,
  lodgingNameKey,
  lodgingSearchPlans,
  type PerspectiveLodgingReport,
  type ResearchedLodgingReport,
  researchedLodgingId,
  screenResearchedLodging,
} from "./lodgingResearch";

// 架空の祭り（鈴鳴灯籠まつり）の会場の周りの、架空の宿で確かめる。URL は example.com

const VENUE = { lat: 35.12, lng: 136.08 };

const input = (overrides: Partial<LodgingResearchInput> = {}): LodgingResearchInput => ({
  festival: { name: "鈴鳴灯籠まつり", place: "鈴鳴町", venueName: "鈴鳴川の河原" },
  stations: ["鈴鳴駅"],
  checkIn: "2026-08-16",
  nights: 1,
  party: { adults: 2, children: 0 },
  perPersonNightLimitYen: null,
  ...overrides,
});

const hotel = (overrides: Partial<ResearchedLodgingReport> = {}): ResearchedLodgingReport => ({
  name: "鈴鳴川の宿",
  summary: "河原まで歩いてすぐの宿",
  location: { lat: 35.121, lng: 136.081 },
  perPersonNightYen: null,
  price: null,
  familyFriendly: null,
  pageUrl: "https://example.com/inn/kawa",
  sources: [{ url: "https://example.com/inn/kawa", title: "鈴鳴川の宿" }],
  ...overrides,
});

const options = {
  venue: VENUE,
  party: { adults: 2, children: 0 },
  perPersonNightLimitYen: null,
  checkedAt: "2026-08-03T10:15:00+09:00",
  today: "2026-08-03",
};

describe("lodgingSearchPlans", () => {
  it("会場の近くと駅の近くは必ず探し、駅の名前で検索する", () => {
    const plans = lodgingSearchPlans(input());
    expect(plans.map((p) => p.perspective)).toEqual(["venue", "station"]);
    expect(plans[1]?.queries).toContain("鈴鳴駅 駅前 ホテル");
  });

  it("予算が分かれば予算に合う宿、子ども連れなら家族向けの宿も並べて探す", () => {
    const plans = lodgingSearchPlans(
      input({ perPersonNightLimitYen: 9000, party: { adults: 2, children: 1, infants: 1 } }),
    );
    expect(plans.map((p) => p.perspective)).toEqual(["venue", "station", "budget", "family"]);
    expect(plans[2]?.queries[0]).toBe("鈴鳴町 ホテル 1泊 9,000円");
    expect(plans[3]?.queries).toContain("鈴鳴町 添い寝 無料 ホテル");
    for (const plan of plans) expect(plan.queries.length).toBeLessThanOrEqual(4);
  });

  it("駅のデータがなければ、市町村の名前で駅の近くを探す", () => {
    const plans = lodgingSearchPlans(input({ stations: [] }));
    expect(plans[1]?.queries[0]).toBe("鈴鳴町 駅前 ホテル");
  });
});

describe("lodgingFromVenue", () => {
  it("歩ける距離なら徒歩、遠ければバスやタクシーの目安にする", () => {
    expect(lodgingFromVenue(VENUE, { lat: 35.125, lng: 136.08 })).toEqual({
      distanceKm: 0.6,
      mode: "walk",
      minutes: [7, 12],
    });
    expect(lodgingFromVenue(VENUE, { lat: 35.17, lng: 136.08 }).mode).toBe("ride");
  });
});

describe("lodgingNameKey・researchedLodgingId", () => {
  it("全角・半角や空白、括弧の補足の違いを同じ宿とみなす", () => {
    expect(lodgingNameKey("ホテル　鈴鳴（駅前）")).toBe(lodgingNameKey("ホテル鈴鳴"));
    expect(researchedLodgingId("Ｓｕｚｕｎａｒｉ Inn")).toBe(researchedLodgingId("suzunari inn"));
    expect(researchedLodgingId("鈴鳴川の宿")).toMatch(/^web-[0-9a-f]{12}$/);
  });
});

describe("screenResearchedLodging", () => {
  it("観点をまたいで同じ宿をまとめ、挙がった観点の多い宿を先にする", () => {
    const reports: PerspectiveLodgingReport[] = [
      {
        perspective: "venue",
        hotels: [
          hotel({ name: "河原の近くの宿", location: { lat: 35.1205, lng: 136.0805 } }),
          hotel(),
        ],
      },
      {
        perspective: "station",
        hotels: [
          hotel({
            name: "鈴鳴川の宿（本館）",
            price: "1泊2食つき 1人12,000円から",
            sources: [{ url: "https://example.com/travel/kawa" }],
          }),
        ],
      },
    ];
    const { offers } = screenResearchedLodging(reports, options);
    expect(offers.map((o) => o.name)).toEqual(["鈴鳴川の宿", "河原の近くの宿"]);
    const first = offers[0]!;
    expect(first.perspectives).toEqual(["venue", "station"]);
    expect(first.priceNote).toBe("1泊2食つき 1人12,000円から");
    expect(first.nightlyTotalYen).toBeNull();
    expect(first.bookingUrl).toBe("https://example.com/inn/kawa");
    expect(first.source).toMatchObject({ confidence: "corroborated", checkedAt: "2026-08-03" });
    expect(first.fromVenue?.mode).toBe("walk");
    for (const offer of offers) expect(LodgingOfferSchema.safeParse(offer).success).toBe(true);
  });

  it("遠すぎる宿・予算の下限を超える宿・子どもを断る宿は入れない", () => {
    const { offers, excluded } = screenResearchedLodging(
      [
        {
          perspective: "venue",
          hotels: [
            hotel({ name: "山の上の宿", location: { lat: 35.3, lng: 136.08 } }),
            hotel({ name: "高い宿", perPersonNightYen: [20000, 30000] }),
            hotel({ name: "大人の宿", familyFriendly: false }),
            hotel({ name: "鈴鳴の民宿", familyFriendly: true, perPersonNightYen: [6000, 7000] }),
          ],
        },
      ],
      { ...options, party: { adults: 2, children: 1 }, perPersonNightLimitYen: 10000 },
    );
    expect(offers.map((o) => o.name)).toEqual(["鈴鳴の民宿"]);
    expect(offers[0]?.perPersonNightYen).toEqual([6000, 7000]);
    expect(excluded).toEqual([
      { name: "山の上の宿", reason: "too_far" },
      { name: "高い宿", reason: "over_budget" },
      { name: "大人の宿", reason: "not_for_children" },
    ]);
  });

  it("観点の数が同じなら、予算に収まると分かる宿、家族向け、会場に近い順にし、3件までにする", () => {
    const { offers } = screenResearchedLodging(
      [
        {
          perspective: "venue",
          hotels: [
            hotel({ name: "近い宿", location: { lat: 35.1201, lng: 136.0801 } }),
            hotel({ name: "少し遠い宿", location: { lat: 35.13, lng: 136.08 } }),
            hotel({
              name: "家族の宿",
              location: { lat: 35.14, lng: 136.08 },
              familyFriendly: true,
            }),
            hotel({
              name: "予算の宿",
              location: { lat: 35.15, lng: 136.08 },
              perPersonNightYen: [5000, 8000],
            }),
          ],
        },
      ],
      { ...options, party: { adults: 1, children: 1 }, perPersonNightLimitYen: 9000 },
    );
    expect(offers.map((o) => o.name)).toEqual(["予算の宿", "家族の宿", "近い宿"]);
  });

  it("出典のない宿は入れず、合う宿がなければ空で返す", () => {
    const { offers } = screenResearchedLodging(
      [{ perspective: "venue", hotels: [hotel({ sources: [] })] }],
      options,
    );
    expect(offers).toEqual([]);
  });
});
