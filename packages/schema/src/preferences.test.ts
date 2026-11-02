import { describe, expect, it } from "vitest";
import {
  DateWishSchema,
  DEFAULT_PREFERENCES,
  PartialTripConditionsSchema,
  PreferencesSchema,
  TripConditionsSchema,
} from "./preferences";

describe("PreferencesSchema", () => {
  it("初期値は「大人だけ・おまかせ・屋台で十分・電車」", () => {
    expect(DEFAULT_PREFERENCES).toEqual({
      party: "adults",
      spot: "auto",
      food: "stalls",
      move: "train",
    });
    expect(PreferencesSchema.safeParse(DEFAULT_PREFERENCES).success).toBe(true);
  });

  it("選択肢にない値は受け付けない", () => {
    expect(PreferencesSchema.safeParse({ ...DEFAULT_PREFERENCES, party: "family" }).success).toBe(
      false,
    );
  });

  it("4項目のどれかが欠けていれば不正", () => {
    const { move: _, ...rest } = DEFAULT_PREFERENCES;
    expect(PreferencesSchema.safeParse(rest).success).toBe(false);
  });
});

describe("DateWishSchema", () => {
  it("1日の希望を受け付ける", () => {
    expect(DateWishSchema.safeParse({ kind: "date", date: "2026-08-16" }).success).toBe(true);
  });

  it("期間の希望は、終わりが始まり以降", () => {
    const range = { kind: "range", from: "2026-08-15", to: "2026-08-16" };
    expect(DateWishSchema.safeParse(range).success).toBe(true);
    expect(DateWishSchema.safeParse({ ...range, from: "2026-08-17" }).success).toBe(false);
  });
});

describe("TripConditionsSchema", () => {
  const conditions = {
    when: { kind: "date", date: "2026-08-16" },
    origin: "みなと中央駅",
    nights: 0,
  };

  it("日付・出発地・泊数がそろえばよい（同行者は任意）", () => {
    expect(TripConditionsSchema.safeParse(conditions).success).toBe(true);
  });

  it("泊数は 0（日帰り・お出かけ）から 6（6泊7日）まで", () => {
    for (const nights of [0, 1, 6]) {
      expect(TripConditionsSchema.safeParse({ ...conditions, nights }).success).toBe(true);
    }
    for (const nights of [-1, 7, 1.5]) {
      expect(TripConditionsSchema.safeParse({ ...conditions, nights }).success).toBe(false);
    }
  });

  it("出発地が空なら不正", () => {
    expect(TripConditionsSchema.safeParse({ ...conditions, origin: "  " }).success).toBe(false);
  });

  it("大人が0人の同行者は不正", () => {
    const party = { adults: 0, children: 1 };
    expect(TripConditionsSchema.safeParse({ ...conditions, party }).success).toBe(false);
  });

  it("泊まりの旅の項目（旅のかたち・終わりの場所・ペースなど）は任意で、おまかせも選べる", () => {
    const longTrip = {
      ...conditions,
      nights: 5,
      returnTo: "やまびこ駅",
      route: { shape: "loop", areas: ["鈴鳴町", "かざみ温泉"] },
      stayNear: "town",
      festivalDays: "several",
      pace: "relaxed",
      interests: ["onsen", "food"],
    };
    expect(TripConditionsSchema.safeParse(longTrip).success).toBe(true);
    const leftToUs = {
      ...conditions,
      nights: 3,
      route: { shape: "auto", areas: [] },
      stayNear: "auto",
      festivalDays: "auto",
      pace: "auto",
      interests: [],
    };
    expect(TripConditionsSchema.safeParse(leftToUs).success).toBe(true);
  });

  it("回りたい地域は5つまで、楽しみたいことは決まった選択肢から", () => {
    const areas = ["一", "二", "三", "四", "五", "六"];
    expect(
      TripConditionsSchema.safeParse({ ...conditions, route: { shape: "loop", areas } }).success,
    ).toBe(false);
    expect(TripConditionsSchema.safeParse({ ...conditions, interests: ["skiing"] }).success).toBe(
      false,
    );
  });

  it("聞き取りの途中は、どの条件も空でよい", () => {
    expect(PartialTripConditionsSchema.safeParse({}).success).toBe(true);
    expect(PartialTripConditionsSchema.safeParse({ origin: "みなと中央駅" }).success).toBe(true);
  });
});
