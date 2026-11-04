import { describe, expect, it } from "vitest";
import {
  budgetPayers,
  DAY_TRIP_TRAVEL_LIMITS,
  DateWishSchema,
  DEFAULT_PREFERENCES,
  LodgingBudgetSchema,
  PartialTripConditionsSchema,
  PartySchema,
  PreferencesSchema,
  TripBudgetSchema,
  TripConditionsSchema,
  tripBudgetAmounts,
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

describe("PartySchema", () => {
  it("内訳（シニア・幼児）は任意", () => {
    expect(PartySchema.safeParse({ adults: 2, children: 0 }).success).toBe(true);
    expect(PartySchema.safeParse({ adults: 3, children: 2, seniors: 1, infants: 1 }).success).toBe(
      true,
    );
  });

  it("シニアは大人の、幼児は子どもの内数", () => {
    expect(PartySchema.safeParse({ adults: 2, children: 0, seniors: 2 }).success).toBe(true);
    expect(PartySchema.safeParse({ adults: 2, children: 0, seniors: 3 }).success).toBe(false);
    expect(PartySchema.safeParse({ adults: 2, children: 1, infants: 2 }).success).toBe(false);
  });
});

describe("LodgingBudgetSchema", () => {
  it("1人あたりの円で、1泊あたりか泊まり全体かを持つ", () => {
    expect(LodgingBudgetSchema.safeParse({ perPersonYen: 12000, per: "night" }).success).toBe(true);
    expect(LodgingBudgetSchema.safeParse({ perPersonYen: 30000, per: "trip" }).success).toBe(true);
  });

  it("0円・端数・決まっていない単位は不正", () => {
    expect(LodgingBudgetSchema.safeParse({ perPersonYen: 0, per: "night" }).success).toBe(false);
    expect(LodgingBudgetSchema.safeParse({ perPersonYen: 1.5, per: "night" }).success).toBe(false);
    expect(LodgingBudgetSchema.safeParse({ perPersonYen: 9000, per: "week" }).success).toBe(false);
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

  it("日帰りの片道の所要時間の上限は任意で、30分から600分までの分", () => {
    for (const maxTravelMinutes of DAY_TRIP_TRAVEL_LIMITS) {
      expect(TripConditionsSchema.safeParse({ ...conditions, maxTravelMinutes }).success).toBe(
        true,
      );
    }
    for (const maxTravelMinutes of [0, 29, 601, 90.5]) {
      expect(TripConditionsSchema.safeParse({ ...conditions, maxTravelMinutes }).success).toBe(
        false,
      );
    }
  });

  it("出発地が空なら不正", () => {
    expect(TripConditionsSchema.safeParse({ ...conditions, origin: "  " }).success).toBe(false);
  });

  it("大人が0人の同行者は不正", () => {
    const party = { adults: 0, children: 1 };
    expect(TripConditionsSchema.safeParse({ ...conditions, party }).success).toBe(false);
  });

  it("宿の予算は任意", () => {
    const lodgingBudget = { perPersonYen: 15000, per: "night" };
    expect(
      TripConditionsSchema.safeParse({ ...conditions, nights: 1, lodgingBudget }).success,
    ).toBe(true);
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
    expect(
      TripConditionsSchema.safeParse({ ...conditions, nights: 6, leaveToStaff: true }).success,
    ).toBe(true);
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

  it("食べたいものと、食事で気をつけたいことは決まった選択肢から", () => {
    expect(
      TripConditionsSchema.safeParse({
        ...conditions,
        foodWishes: ["meat", "noodles", "local_drinks"],
        dietary: ["vegetarian", "allergy"],
      }).success,
    ).toBe(true);
    expect(TripConditionsSchema.safeParse({ ...conditions, foodWishes: [] }).success).toBe(true);
    expect(TripConditionsSchema.safeParse({ ...conditions, foodWishes: ["pizza"] }).success).toBe(
      false,
    );
    expect(TripConditionsSchema.safeParse({ ...conditions, dietary: ["peanut"] }).success).toBe(
      false,
    );
  });

  it("想定している交通手段は決まった選択肢から、いくつでも", () => {
    expect(
      TripConditionsSchema.safeParse({
        ...conditions,
        transport: [
          "car",
          "shinkansen",
          "local_train",
          "bus",
          "ferry",
          "plane",
          "rental_car",
          "walk",
        ],
      }).success,
    ).toBe(true);
    expect(TripConditionsSchema.safeParse({ ...conditions, transport: [] }).success).toBe(true);
    expect(TripConditionsSchema.safeParse({ ...conditions, transport: ["bicycle"] }).success).toBe(
      false,
    );
  });

  it("聞き取りの途中は、どの条件も空でよい", () => {
    expect(PartialTripConditionsSchema.safeParse({}).success).toBe(true);
    expect(PartialTripConditionsSchema.safeParse({ origin: "みなと中央駅" }).success).toBe(true);
  });
});

describe("旅の予算", () => {
  const family = { adults: 2, children: 2, infants: 1 };

  it("1人あたりか全員の合計かを持ち、金額は1円から1000万円まで", () => {
    expect(TripBudgetSchema.safeParse({ yen: 30000, basis: "perPerson" }).success).toBe(true);
    expect(TripBudgetSchema.safeParse({ yen: 90000, basis: "total" }).success).toBe(true);
    expect(TripBudgetSchema.safeParse({ yen: 0, basis: "total" }).success).toBe(false);
    expect(TripBudgetSchema.safeParse({ yen: 30000, basis: "each" }).success).toBe(false);
    expect(TripBudgetSchema.safeParse({ yen: 30000 }).success).toBe(false);
  });

  it("予算を割る人数に、幼児は数えない", () => {
    expect(budgetPayers(family)).toBe(3);
    expect(budgetPayers({ adults: 1, children: 0 })).toBe(1);
  });

  it("1人あたりで受けたら、人数を掛けて合計にする", () => {
    expect(tripBudgetAmounts({ yen: 30000, basis: "perPerson" }, family)).toEqual({
      basis: "perPerson",
      perPersonYen: 30000,
      totalYen: 90000,
      payers: 3,
    });
  });

  it("合計で受けたら、人数で割って1人あたりにする（割り切れなければ切り捨て）", () => {
    expect(tripBudgetAmounts({ yen: 100000, basis: "total" }, family)).toEqual({
      basis: "total",
      perPersonYen: 33333,
      totalYen: 100000,
      payers: 3,
    });
  });

  it("人数が分からなければ、換算した側は null", () => {
    expect(tripBudgetAmounts({ yen: 90000, basis: "total" }, undefined)).toMatchObject({
      perPersonYen: null,
      totalYen: 90000,
    });
    expect(tripBudgetAmounts({ yen: 30000, basis: "perPerson" }, undefined)).toMatchObject({
      perPersonYen: 30000,
      totalYen: null,
    });
  });
});
