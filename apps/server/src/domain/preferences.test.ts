import { DEFAULT_PREFERENCES, type Preferences } from "@matsuri-ikoka/schema";
import { describe, expect, it } from "vitest";
import { popularityRank, preferenceEffects } from "./preferences";

const prefs = (overrides: Partial<Preferences>): Preferences => ({
  ...DEFAULT_PREFERENCES,
  ...overrides,
});

describe("preferenceEffects", () => {
  it("初期値（大人だけ・おまかせ・屋台で十分・電車）", () => {
    const effects = preferenceEffects(DEFAULT_PREFERENCES);

    expect(effects).toMatchObject({
      restIntervalMinutes: null,
      maxWalkMinutes: null,
      includeShopMeals: false,
      requireLocalMeal: false,
      checkParkingFirst: false,
    });
    expect(effects.rules).toContain("屋台を食事の時間として扱い、店の予定は入れない");
  });

  it("子連れは2時間ごとの休憩、トイレ、冷え込みと帰りの混雑", () => {
    const effects = preferenceEffects(prefs({ party: "kids" }));

    expect(effects.restIntervalMinutes).toBe(120);
    expect(effects.preferTags).toContain("kid_friendly");
    expect(effects.rules.join("\n")).toMatch(/トイレ/);
    expect(effects.rules.join("\n")).toMatch(/冷え込み/);
  });

  it("シニアと一緒は、歩く距離を短く、座れる場所を優先", () => {
    const effects = preferenceEffects(prefs({ party: "seniors" }));

    expect(effects.maxWalkMinutes).toBe(15);
    expect(effects.preferTags).toEqual(expect.arrayContaining(["seating", "senior_friendly"]));
  });

  it("地元の店も楽しむは、地元の店での食事を入れる", () => {
    const effects = preferenceEffects(prefs({ food: "local" }));

    expect(effects).toMatchObject({ includeShopMeals: true, requireLocalMeal: true });
    expect(effects.preferTags).toContain("local_food");
  });

  it("車は駐車場と交通規制を先に確かめる", () => {
    expect(preferenceEffects(prefs({ move: "car" })).checkParkingFirst).toBe(true);
  });
});

describe("popularityRank", () => {
  it("定番どころは知名度の高い順、穴場は低い順、おまかせは順位を付けない", () => {
    expect(popularityRank("major", "classic")).toBeLessThan(popularityRank("local", "classic"));
    expect(popularityRank("local", "hidden")).toBeLessThan(popularityRank("major", "hidden"));
    expect(popularityRank("major", "auto")).toBe(popularityRank("local", "auto"));
  });
});
