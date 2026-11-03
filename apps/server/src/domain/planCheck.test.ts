import { DEFAULT_PREFERENCES, type Preferences } from "@matsuri-ikoka/schema";
import { fictionalItinerary } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { checkPlan, type PlanItem, type PlanToCheck } from "./planCheck";
import { lookup, testFestival } from "./testFestivals";

// 架空の鈴鳴灯籠まつり（規模 S、18:30〜21:00）。鈴鳴和紙の館は 10:00〜17:00（最終入場 16:30）、火曜休み
const festival = testFestival({ id: "suzunari-toro" });
const find = lookup(festival);

function plan(
  items: PlanItem[],
  preferences: Partial<Preferences> = {},
  // 2026-08-16 は日曜
  date = "2026-08-16",
): PlanToCheck {
  return {
    mainFestivalId: "suzunari-toro",
    preferences: { ...DEFAULT_PREFERENCES, ...preferences },
    days: [{ date, items }],
  };
}

const item = (overrides: Partial<PlanItem> & Pick<PlanItem, "id" | "start" | "end">): PlanItem => ({
  type: "sightseeing",
  name: overrides.id,
  move: null,
  ...overrides,
});

const fest = item({
  id: "festival",
  start: "18:30",
  end: "21:00",
  type: "festival",
  festivalId: "suzunari-toro",
});

const codes = (result: ReturnType<typeof checkPlan>) =>
  result.errors.map((e) => [e.code, e.itemId]);

describe("checkPlan", () => {
  it("架空の旅程（初版）は問題なく通る", () => {
    const itinerary = fictionalItinerary();

    const result = checkPlan(itinerary, find);

    expect(result.errors).toEqual([]);
  });

  it("予定の少ない短いお出かけ（祭りだけ・祭りと食事だけ）も通る", () => {
    expect(checkPlan(plan([fest]), find)).toEqual({ errors: [], warnings: [] });
    const meal = item({ id: "meal", start: "17:30", end: "18:10", type: "meal" });
    expect(checkPlan(plan([meal, fest], { party: "kids" }), find)).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it("予定の重なりを見つける", () => {
    const result = checkPlan(
      plan([
        item({ id: "a", start: "15:00", end: "16:30" }),
        item({ id: "b", start: "16:00", end: "17:00" }),
        fest,
      ]),
      find,
    );

    expect(codes(result)).toContainEqual(["overlap", "b"]);
  });

  it("移動の目安の最短より、予定の間があいていなければ間に合わない", () => {
    const result = checkPlan(
      plan([
        item({ id: "a", start: "15:00", end: "16:00" }),
        item({
          id: "b",
          start: "16:05",
          end: "17:00",
          move: { means: "walk", minutes: [10, 15], estimate: true },
        }),
        fest,
      ]),
      find,
    );

    expect(codes(result)).toContainEqual(["not_enough_move_time", "b"]);
  });

  it("移動の予定が、移動の目安より短ければ誤り", () => {
    const result = checkPlan(
      plan([
        item({
          id: "go",
          type: "move",
          start: "16:00",
          end: "16:20",
          move: { means: "train", minutes: [40, 50], estimate: true },
        }),
        fest,
      ]),
      find,
    );

    expect(codes(result)).toContainEqual(["not_enough_move_time", "go"]);
  });

  it("時刻の順に並んでいなければ誤り。ただし夜の後の深夜は翌日として扱う", () => {
    const outOfOrder = checkPlan(
      plan([
        item({ id: "late", start: "15:00", end: "16:00" }),
        item({ id: "early", start: "12:00", end: "13:00" }),
        fest,
      ]),
      find,
    );
    const pastMidnight = checkPlan(
      plan([
        fest,
        item({
          id: "back",
          type: "move",
          start: "23:30",
          end: "00:30",
          move: { means: "train", minutes: [50, 60], estimate: true },
        }),
        item({ id: "home", type: "rest", start: "00:40", end: "01:00" }),
      ]),
      find,
    );

    expect(codes(outOfOrder)).toContainEqual(["out_of_order", "early"]);
    expect(pastMidnight.errors).toEqual([]);
  });

  it("休業日の場所を入れると誤り", () => {
    // 2026-08-18 は火曜。祭りもこの日に開く
    const tuesday = plan(
      [item({ id: "hall", start: "14:00", end: "15:00", spotId: "suzunari-craft-hall" }), fest],
      {},
      "2026-08-18",
    );
    const festivalOnTuesday = testFestival({ id: "suzunari-toro", date: "2026-08-18" });

    const result = checkPlan(tuesday, lookup(festivalOnTuesday));

    expect(codes(result)).toEqual([["closed_day", "hall"]]);
  });

  it("営業時間の外と、最終入場の後は誤り", () => {
    const result = checkPlan(
      plan([
        item({ id: "early", start: "09:30", end: "10:30", spotId: "suzunari-craft-hall" }),
        item({ id: "late-entry", start: "16:40", end: "16:55", spotId: "suzunari-craft-hall" }),
        fest,
      ]),
      find,
    );

    expect(codes(result)).toEqual([
      ["outside_hours", "early"],
      ["after_last_entry", "late-entry"],
    ]);
  });

  it("データにない場所や祭りは誤り", () => {
    const result = checkPlan(
      {
        ...plan([item({ id: "x", start: "14:00", end: "15:00", spotId: "no-such-spot" }), fest]),
        mainFestivalId: "no-such-festival",
      },
      find,
    );

    expect(result.errors.map((e) => e.code)).toEqual(
      expect.arrayContaining(["unknown_festival", "unknown_spot"]),
    );
  });

  it("祭りの開かれない日の旅程は誤り", () => {
    const result = checkPlan(plan([fest], {}, "2026-08-17"), find);

    expect(codes(result)).toContainEqual(["festival_not_on_date", "festival"]);
  });

  it("泊まりの旅は日ごとに確かめ、どの日の誤りかを添える", () => {
    const result = checkPlan(
      {
        ...plan([fest]),
        days: [
          {
            date: "2026-08-15",
            items: [
              item({ id: "a", start: "10:00", end: "12:00" }),
              item({ id: "b", start: "11:00", end: "13:00" }),
            ],
          },
          { date: "2026-08-16", items: [{ ...fest, start: "18:30" }] },
        ],
      },
      find,
    );

    expect(codes(result)).toEqual([["overlap", "b"]]);
    expect(result.errors[0]?.message).toMatch(/^1日目（8月15日）：/);
  });

  it("祭りのない日だけでは、祭りの日の確かめをしない", () => {
    const result = checkPlan(
      {
        ...plan([fest]),
        days: [
          { date: "2026-08-16", items: [fest] },
          { date: "2026-08-17", items: [item({ id: "walk", start: "09:00", end: "11:00" })] },
        ],
      },
      find,
    );

    expect(result.errors).toEqual([]);
  });

  it("祭りの予定が開催時間の外にはみ出すと、祭りの時間とぶつかる", () => {
    const result = checkPlan(plan([{ ...fest, start: "18:00" }]), find);

    expect(codes(result)).toContainEqual(["festival_time_conflict", "festival"]);
  });

  it("到着の余裕（規模 S は15分）がとれていなければ誤り", () => {
    const tight = checkPlan(
      plan([
        item({ id: "tea", type: "rest", start: "17:00", end: "18:10" }),
        { ...fest, move: { means: "walk", minutes: [5, 8], estimate: true } },
      ]),
      find,
    );
    const enough = checkPlan(
      plan([
        item({ id: "tea", type: "rest", start: "17:00", end: "18:00" }),
        item({
          id: "prep",
          type: "festival_prep",
          start: "18:10",
          end: "18:30",
          festivalId: "suzunari-toro",
          move: { means: "walk", minutes: [5, 8], estimate: true },
        }),
        fest,
      ]),
      find,
    );

    expect(codes(tight)).toEqual([["arrival_buffer", "festival"]]);
    expect(tight.errors[0]?.message).toContain("18:15");
    expect(enough.errors).toEqual([]);
  });

  it("花火大会は場所取りのぶん、到着の余裕が長い", () => {
    const fireworks = testFestival({ id: "suzunari-toro", category: "fireworks", scaleTier: "M" });

    const result = checkPlan(
      plan([item({ id: "dinner", type: "meal", start: "17:00", end: "17:45" }), fest]),
      lookup(fireworks),
    );

    // M の30分に花火の30分を足して、17:30 までに着く
    expect(codes(result)).toEqual([["arrival_buffer", "festival"]]);
  });
});

describe("checkPlan の日をまたぐ予定", () => {
  // 架空の夜の祭り（20:00〜翌02:00）と、夜遅くまで開く架空の店（18:00〜翌02:00、最終入場 01:00）
  const night = testFestival({
    id: "suzunari-toro",
    start: "20:00",
    end: "02:00",
    edit: (f) => {
      f.nearby.push({
        id: "night-bar",
        name: "夜の茶屋",
        kind: "rest",
        summary: "夜遅くまで開く茶屋",
        location: { lat: 35.12, lng: 136.08 },
        walkMinutesFromVenue: [3, 5],
        hours: { open: "18:00", close: "02:00", lastEntry: "01:00" },
        closedDays: [],
        price: null,
        tags: [],
        popularity: "local",
        sources: [
          { url: "https://example.com/night-bar", checkedAt: "2026-04-01", confidence: "single" },
        ],
      });
    },
  });
  const findNight = lookup(night);
  const nightFest = (start: string, end: string) =>
    item({ id: "festival", start, end, type: "festival", festivalId: "suzunari-toro" });

  it("夜の祭りの予定が深夜に入っても、開催時間の中なら誤りにしない", () => {
    const result = checkPlan(
      plan([
        item({ id: "dinner", type: "meal", start: "18:00", end: "19:30" }),
        item({ id: "late", start: "21:00", end: "23:30" }),
        nightFest("00:00", "02:00"),
      ]),
      findNight,
    );

    expect(result.errors).toEqual([]);
  });

  it("夜の祭りの予定が、深夜の終わりの時刻を越えたら、祭りの時間とぶつかる", () => {
    const result = checkPlan(plan([nightFest("20:00", "02:30")]), findNight);

    expect(codes(result)).toContainEqual(["festival_time_conflict", "festival"]);
  });

  it("日をまたいで営業する店に、深夜に寄る予定は営業時間の中", () => {
    const result = checkPlan(
      plan([
        nightFest("20:00", "23:30"),
        item({ id: "bar", type: "rest", start: "00:30", end: "01:30", spotId: "night-bar" }),
      ]),
      findNight,
    );

    expect(result.errors).toEqual([]);
  });

  it("深夜の店の予定でも、閉店を越えれば営業時間の外、最終入場の後なら誤り", () => {
    const pastClose = checkPlan(
      plan([
        nightFest("20:00", "23:30"),
        item({ id: "bar", type: "rest", start: "00:30", end: "02:30", spotId: "night-bar" }),
      ]),
      findNight,
    );
    const lateEntry = checkPlan(
      plan([
        nightFest("20:00", "23:30"),
        item({ id: "bar", type: "rest", start: "01:15", end: "01:45", spotId: "night-bar" }),
      ]),
      findNight,
    );

    expect(codes(pastClose)).toEqual([["outside_hours", "bar"]]);
    expect(codes(lateEntry)).toEqual([["after_last_entry", "bar"]]);
  });
});

describe("checkPlan のこだわりの確認（warnings）", () => {
  it("自由に過ごす時間は、子連れの休憩として数える", () => {
    const items = [
      item({ id: "walk1", start: "13:00", end: "14:30" }),
      item({ id: "free", type: "free", start: "14:40", end: "15:30" }),
      item({ id: "walk2", start: "15:40", end: "16:30" }),
      fest,
    ];

    const kids = checkPlan(plan(items, { party: "kids" }), find);

    expect(kids.warnings.filter((w) => w.code === "rest_interval")).toEqual([]);
  });

  it("子連れで休憩が2時間を超えてあかなければ知らせる", () => {
    const items = [
      item({ id: "walk1", start: "13:00", end: "14:30" }),
      item({ id: "walk2", start: "14:40", end: "15:30" }),
      item({ id: "tea", type: "rest", start: "15:40", end: "16:10" }),
      fest,
    ];

    const kids = checkPlan(plan(items, { party: "kids" }), find);
    const adults = checkPlan(plan(items), find);

    expect(kids.warnings.map((w) => [w.code, w.itemId])).toEqual([["rest_interval", "walk2"]]);
    expect(adults.warnings).toEqual([]);
  });

  it("「地元の店も楽しむ」で店の食事がなければ知らせ、「屋台で十分」で店の食事があれば知らせる", () => {
    const withSoba = testFestival({
      id: "suzunari-toro",
      edit: (f) => {
        f.nearby.push({
          id: "soba",
          name: "そば店",
          kind: "food",
          summary: "そばの店",
          location: { lat: 35.12, lng: 136.08 },
          walkMinutesFromVenue: [5, 8],
          hours: { open: "11:00", close: "15:00" },
          closedDays: [],
          price: null,
          tags: ["local_food"],
          popularity: "local",
          sources: [
            { url: "https://example.com/soba", checkedAt: "2026-04-01", confidence: "single" },
          ],
        });
      },
    });
    const lunch = item({ id: "lunch", type: "meal", start: "12:00", end: "13:00", spotId: "soba" });

    const localWithout = checkPlan(plan([fest], { food: "local" }), lookup(withSoba));
    const localWith = checkPlan(plan([lunch, fest], { food: "local" }), lookup(withSoba));
    const stallsWith = checkPlan(plan([lunch, fest], { food: "stalls" }), lookup(withSoba));

    expect(localWithout.warnings.map((w) => w.code)).toEqual(["local_meal_missing"]);
    expect(localWith.warnings).toEqual([]);
    expect(stallsWith.warnings.map((w) => [w.code, w.itemId])).toEqual([
      ["shop_meal_unwanted", "lunch"],
    ]);
  });

  it("シニアと一緒で長く歩く予定があれば知らせる", () => {
    const longWalk = item({
      id: "hall",
      start: "14:00",
      end: "15:00",
      move: { means: "walk", minutes: [15, 20], estimate: true },
    });

    const result = checkPlan(plan([longWalk, fest], { party: "seniors" }), find);

    expect(result.warnings.map((w) => [w.code, w.itemId])).toEqual([["long_walk", "hall"]]);
  });
});
