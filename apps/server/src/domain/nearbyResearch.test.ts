import { DEFAULT_PREFERENCES } from "@matsuri-ikoka/schema";
import { fictionalItinerary } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import {
  asNearbySpot,
  isResearchedSpotId,
  type ResearchedSpotReport,
  researchedSpotId,
  researchedSpotsInItinerary,
  type ScreenOptions,
  screenResearchedSpots,
} from "./nearbyResearch";

// 架空の祭り（鈴鳴の河原が会場）の周りを調べた、架空の店の報告。2026-08-16 は日曜
const VENUE = { lat: 35.12, lng: 136.08 };

function report(edit: Partial<ResearchedSpotReport> = {}): ResearchedSpotReport {
  return {
    name: "鈴鳴グリル",
    kind: "food",
    summary: "川沿いで炭火焼きの肉料理を出す店",
    location: { lat: 35.122, lng: 136.082 },
    foods: ["meat"],
    dietaryOk: [],
    adultsOnly: false,
    pricePerPersonYen: [1500, 3000],
    price: "ランチ 1,500円から",
    hours: { open: "11:00", close: "21:00" },
    closedDays: ["wed"],
    openOnDate: "open",
    sources: [{ url: "https://example.com/suzunari-grill", title: "鈴鳴グリル" }],
    ...edit,
  };
}

function options(edit: Partial<ScreenOptions> = {}): ScreenOptions {
  return {
    date: "2026-08-16",
    venue: VENUE,
    today: "2026-08-03",
    preferences: { ...DEFAULT_PREFERENCES, food: "local" },
    foodWishes: ["meat"],
    dietary: [],
    perPersonBudgetYen: 30_000,
    party: { adults: 2, children: 0 },
    ...edit,
  };
}

describe("screenResearchedSpots", () => {
  it("食べたいものに合い、行く日に営業している店を、祭りのデータの場所と同じ形で返す", () => {
    const result = screenResearchedSpots([report()], options());

    expect(result.foodFound).toBe(true);
    expect(result.excluded).toEqual([]);
    const [spot] = result.spots;
    expect(spot).toMatchObject({
      name: "鈴鳴グリル",
      kind: "food",
      openStatus: "confirmed",
      matchedFoods: ["meat"],
      popularity: "local",
      sources: [
        {
          url: "https://example.com/suzunari-grill",
          title: "鈴鳴グリル",
          checkedAt: "2026-08-03",
          confidence: "single",
        },
      ],
    });
    expect(isResearchedSpotId(spot!.id)).toBe(true);
    // 会場からの徒歩は、直線の距離からの目安
    expect(spot!.walkMinutesFromVenue?.[0]).toBeGreaterThan(0);
    expect(asNearbySpot(spot!)).not.toHaveProperty("openStatus");
  });

  it("食べたいものに合う店がなければ、見つからなかったと返しつつ、食事に入れられる店は残す", () => {
    const udon = report({ name: "鈴鳴うどん", foods: ["noodles", "washoku"] });

    const result = screenResearchedSpots([udon], options());

    expect(result.spots.map((s) => [s.name, s.matchedFoods])).toEqual([["鈴鳴うどん", []]]);
    expect(result.foodFound).toBe(false);
    expect(result.excluded).toEqual([]);
  });

  it("食べたいものに合う店を、合わない店より先に並べる", () => {
    const udon = report({ name: "鈴鳴うどん", foods: ["noodles"] });
    const grill = report({ name: "鈴鳴グリル", foods: ["meat"] });

    const result = screenResearchedSpots([udon, grill], options());

    expect(result.spots.map((s) => s.name)).toEqual(["鈴鳴グリル", "鈴鳴うどん"]);
    expect(result.foodFound).toBe(true);
  });

  it("屋台で十分のこだわりでも、屋台で昼を済ませられない日（wantsShopMeals）は店を残す", () => {
    const shop = report({ foods: ["noodles"] });
    const stallsOnly = options({ foodWishes: [], preferences: DEFAULT_PREFERENCES });
    expect(screenResearchedSpots([shop], stallsOnly).spots).toEqual([]);
    expect(
      screenResearchedSpots([shop], { ...stallsOnly, wantsShopMeals: true }).spots.map(
        (s) => s.name,
      ),
    ).toEqual([shop.name]);
  });

  it("屋台だけを望むときは、食べたいもので店を絞らない", () => {
    const result = screenResearchedSpots(
      [report({ foods: ["noodles"] })],
      options({ foodWishes: ["stalls"] }),
    );

    expect(result.spots).toHaveLength(1);
    expect(result.foodFound).toBeNull();
  });

  it("行く日が定休日の店、休業の告知がある店、時間帯に営業が合わない店を除く", () => {
    const result = screenResearchedSpots(
      [
        report({ name: "日曜休みの店", closedDays: ["sun"] }),
        report({ name: "臨時休業の店", openOnDate: "closed" }),
        report({ name: "夜だけの店", hours: { open: "18:00", close: "23:00" } }),
      ],
      options({ window: { from: "11:00", to: "14:00" } }),
    );

    expect(result.spots).toEqual([]);
    expect(result.excluded.map((e) => e.reason)).toEqual([
      "closed_on_date",
      "closed_on_date",
      "outside_hours",
    ]);
  });

  it("営業を確かめきれなかった店は、要確認として後ろに並べる", () => {
    const result = screenResearchedSpots(
      [
        report({ name: "確かめきれない店", openOnDate: "unconfirmed", hours: null }),
        report({ name: "確かめた店", location: { lat: 35.125, lng: 136.085 } }),
      ],
      options(),
    );

    expect(result.spots.map((s) => [s.name, s.openStatus])).toEqual([
      ["確かめた店", "confirmed"],
      ["確かめきれない店", "needs_check"],
    ]);
  });

  it("会場から遠い場所、子ども連れで入れない店、予算に合わない店を除く", () => {
    const result = screenResearchedSpots(
      [
        report({ name: "遠くの店", location: { lat: 35.2, lng: 136.2 } }),
        report({ name: "大人だけの酒場", adultsOnly: true }),
        report({ name: "高い店", pricePerPersonYen: [20_000, 30_000] }),
      ],
      options({ party: { adults: 2, children: 1 } }),
    );

    expect(result.excluded.map((e) => e.reason)).toEqual(["too_far", "adults_only", "over_budget"]);
  });

  it("距離の上限を広げれば（車で回るとき）、歩いては遠い店も残す", () => {
    // 会場から北へ約5.5km
    const far = report({ name: "郊外の店", location: { lat: 35.17, lng: 136.08 } });
    expect(screenResearchedSpots([far], options()).excluded).toEqual([
      { name: "郊外の店", reason: "too_far" },
    ]);
    expect(screenResearchedSpots([far], options({ maxKm: 10 })).spots.map((s) => s.name)).toEqual([
      "郊外の店",
    ]);
  });

  it("ベジタリアン・ハラールなどは、対応するとページにある店だけを残す", () => {
    const result = screenResearchedSpots(
      [
        report({ name: "書いていない店", foods: ["vegetables"] }),
        report({
          name: "対応する店",
          foods: ["vegetables"],
          dietaryOk: ["vegetarian"],
          location: { lat: 35.123, lng: 136.081 },
        }),
      ],
      options({ foodWishes: ["vegetables"], dietary: ["vegetarian"] }),
    );

    expect(result.spots.map((s) => s.name)).toEqual(["対応する店"]);
    expect(result.excluded).toEqual([{ name: "書いていない店", reason: "dietary_unconfirmed" }]);
  });

  it("生ものが苦手なら、海鮮だけの店を選ばない", () => {
    const result = screenResearchedSpots(
      [report({ name: "鈴鳴の魚河岸", foods: ["seafood"] })],
      options({ foodWishes: ["seafood"], dietary: ["no_raw"] }),
    );

    expect(result.spots).toEqual([]);
    expect(result.foodFound).toBe(false);
  });

  it("観光や休憩の場所は、食べたいもので絞らない。出典のない場所は入れない", () => {
    const result = screenResearchedSpots(
      [
        report({ name: "鈴鳴の展望台", kind: "sightseeing", foods: [], pricePerPersonYen: null }),
        report({ name: "出典のない店", sources: [] }),
      ],
      options(),
    );

    expect(result.spots.map((s) => s.name)).toEqual(["鈴鳴の展望台"]);
    expect(result.foodFound).toBe(false);
  });

  it("同じサイトのページが増えても、裏が取れたことにしない", () => {
    const sameSite = report({
      sources: [{ url: "https://example.com/a" }, { url: "https://example.com/b" }],
    });
    const [spot] = screenResearchedSpots([sameSite], options()).spots;
    expect(spot?.sourceSites).toBe(1);
    expect(spot?.sources.map((s) => s.confidence)).toEqual(["single", "single"]);
  });

  it("別々のサイトで裏が取れた店を、同じ条件の店より先に並べる", () => {
    const one = report({ name: "鈴鳴一号店", sources: [{ url: "https://example.com/one" }] });
    const two = report({
      name: "鈴鳴二号店",
      sources: [{ url: "https://example.com/two" }, { url: "https://example.org/two" }],
    });
    const { spots } = screenResearchedSpots([one, two], options());
    expect(spots.map((s) => [s.name, s.sourceSites])).toEqual([
      ["鈴鳴二号店", 2],
      ["鈴鳴一号店", 1],
    ]);
  });

  it("別のサイトの出典が2つ以上ある場所は、確度を corroborated にする。同じ場所は1つにする", () => {
    const twice = report({
      sources: [{ url: "https://example.com/a" }, { url: "https://example.org/b" }],
    });

    const result = screenResearchedSpots([twice, twice], options());

    expect(result.spots).toHaveLength(1);
    expect(result.spots[0]!.sources.map((s) => s.confidence)).toEqual([
      "corroborated",
      "corroborated",
    ]);
  });
});

describe("researchedSpotId", () => {
  it("名前と位置から決まり、web- で始まる", () => {
    const a = researchedSpotId("鈴鳴グリル", { lat: 35.122, lng: 136.082 });
    expect(a).toBe(researchedSpotId("鈴鳴グリル", { lat: 35.122, lng: 136.082 }));
    expect(a).not.toBe(researchedSpotId("鈴鳴グリル", { lat: 35.13, lng: 136.082 }));
    expect(a).toMatch(/^web-[0-9a-f]{10}$/);
  });
});

describe("researchedSpotsInItinerary", () => {
  it("旅程に入っている調べた場所だけを、位置・営業時間・出典のまま取り出す", () => {
    const itinerary = fictionalItinerary();
    const day = itinerary.days[0]!;
    day.items.push({
      ...day.items[1]!,
      id: "lunch",
      type: "meal",
      name: "鈴鳴グリル",
      spotId: "web-0123456789",
    });

    const spots = researchedSpotsInItinerary(itinerary);

    expect([...spots.keys()]).toEqual(["web-0123456789"]);
    expect(spots.get("web-0123456789")).toMatchObject({
      name: "鈴鳴グリル",
      kind: "food",
      closedDays: null,
      location: { lat: 35.121, lng: 136.083 },
    });
  });
});
