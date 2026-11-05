import { DEFAULT_PREFERENCES, type NearbySpot, type Preferences } from "@matsuri-ikoka/schema";
import { describe, expect, it } from "vitest";
import { festivalInArea, fitsOpeningHours, selectNearbySpots } from "./nearby";

function spot(overrides: Partial<NearbySpot> & Pick<NearbySpot, "id">): NearbySpot {
  return {
    name: overrides.id,
    kind: "sightseeing",
    summary: "架空の場所",
    location: { lat: 35.12, lng: 136.08 },
    walkMinutesFromVenue: [5, 10],
    hours: { open: "10:00", close: "17:00" },
    closedDays: [],
    price: null,
    tags: [],
    popularity: "local",
    sources: [
      { url: `https://example.com/${overrides.id}`, checkedAt: "2026-04-01", confidence: "single" },
    ],
    ...overrides,
  };
}

const prefs = (overrides: Partial<Preferences> = {}): Preferences => ({
  ...DEFAULT_PREFERENCES,
  ...overrides,
});

const ids = (result: ReturnType<typeof selectNearbySpots>) => result.spots.map((s) => s.id);

describe("selectNearbySpots", () => {
  // 2026-08-16 は日曜
  const date = "2026-08-16";

  it("当日が定休日の場所を除く", () => {
    const result = selectNearbySpots(
      [spot({ id: "closed-sun", closedDays: ["sun"] }), spot({ id: "open" })],
      { date, preferences: prefs() },
    );

    expect(ids(result)).toEqual(["open"]);
    expect(result.excluded).toEqual([
      { spotId: "closed-sun", name: "closed-sun", reason: "closed_day" },
    ]);
  });

  it("使える時間帯に、営業時間内で30分いられない場所を除く", () => {
    const result = selectNearbySpots(
      [
        spot({ id: "closes-early", hours: { open: "10:00", close: "15:20" } }),
        spot({ id: "fits", hours: { open: "10:00", close: "17:00" } }),
        spot({ id: "no-hours", hours: null }),
      ],
      { date, window: { from: "15:00", to: "18:00" }, preferences: prefs() },
    );

    expect(ids(result)).toEqual(["fits", "no-hours"]);
    expect(result.excluded.map((e) => [e.spotId, e.reason])).toEqual([
      ["closes-early", "outside_hours"],
    ]);
  });

  it("屋台で十分なら店を除き、地元の店も楽しむなら地元の味を先に出す", () => {
    const spots = [spot({ id: "walk" }), spot({ id: "soba", kind: "food", tags: ["local_food"] })];

    expect(ids(selectNearbySpots(spots, { date, preferences: prefs({ food: "stalls" }) }))).toEqual(
      ["walk"],
    );
    expect(ids(selectNearbySpots(spots, { date, preferences: prefs({ food: "local" }) }))).toEqual([
      "soba",
      "walk",
    ]);
  });

  it("屋台で十分でも、聞き取りで屋台のほかに食べたいものがあれば店を残す", () => {
    const spots = [spot({ id: "walk" }), spot({ id: "soba", kind: "food" })];

    const result = selectNearbySpots(spots, {
      date,
      preferences: prefs({ food: "stalls" }),
      wantsShopMeals: true,
    });
    expect(ids(result).sort()).toEqual(["soba", "walk"]);
    expect(result.excluded).toEqual([]);
  });

  it("定番どころなら知名度の高い順、穴場なら低い順", () => {
    const spots = [
      spot({ id: "major", popularity: "major" }),
      spot({ id: "local", popularity: "local" }),
    ];

    expect(
      ids(selectNearbySpots(spots, { date, preferences: prefs({ spot: "classic" }) })),
    ).toEqual(["major", "local"]);
    expect(ids(selectNearbySpots(spots, { date, preferences: prefs({ spot: "hidden" }) }))).toEqual(
      ["local", "major"],
    );
  });

  it("子連れなら子どもと楽しめる場所を、シニアと一緒なら近い場所を先に出す", () => {
    const spots = [
      spot({ id: "far-seat", walkMinutesFromVenue: [15, 20], tags: ["seating"] }),
      spot({ id: "kids", walkMinutesFromVenue: [10, 12], tags: ["kid_friendly"] }),
      spot({ id: "near", walkMinutesFromVenue: [2, 3] }),
    ];

    expect(ids(selectNearbySpots(spots, { date, preferences: prefs({ party: "kids" }) }))[0]).toBe(
      "kids",
    );
    expect(
      ids(selectNearbySpots(spots, { date, preferences: prefs({ party: "seniors" }) })),
    ).toEqual(["near", "kids", "far-seat"]);
  });
});

describe("fitsOpeningHours", () => {
  it("最終入場より後に着く時間帯は合わない", () => {
    const hours = { open: "10:00", close: "17:00", lastEntry: "16:30" };

    expect(fitsOpeningHours(hours, { from: "16:00", to: "18:00" })).toBe(true);
    expect(fitsOpeningHours(hours, { from: "16:40", to: "18:00" })).toBe(false);
  });

  it("日をまたぐ営業時間も扱える", () => {
    expect(
      fitsOpeningHours({ open: "18:00", close: "01:00" }, { from: "21:00", to: "23:30" }),
    ).toBe(true);
  });
});

describe("festivalInArea", () => {
  const festival = { municipalities: [{ prefecture: "滋賀県" as const, name: "鈴鳴町" }] };

  it("都道府県・市町村・その組み合わせの名前で当たる", () => {
    expect(festivalInArea(festival, "滋賀県")).toBe(true);
    expect(festivalInArea(festival, "鈴鳴町")).toBe(true);
    expect(festivalInArea(festival, "滋賀県 鈴鳴町")).toBe(true);
    expect(festivalInArea(festival, "鈴鳴町のあたり")).toBe(true);
  });

  it("ほかの地域や空の名前では当たらない", () => {
    expect(festivalInArea(festival, "京都府")).toBe(false);
    expect(festivalInArea(festival, " ")).toBe(false);
  });
});
