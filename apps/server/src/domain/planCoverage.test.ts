import type { Itinerary } from "@matsuri-ikoka/schema";
import {
  fictionalItinerary,
  fictionalLodgingSearch,
  fictionalPlannedItinerary,
  fictionalSource,
} from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import {
  findGaps,
  LODGING_ADOPTED_REASON,
  mealsNeeded,
  type ResearchedPlace,
  reconcileConsidered,
} from "./planCoverage";

// 架空の鈴鳴灯籠まつり（18:30〜21:00）への日帰りの旅程。そろった旅程は fictionalPlannedItinerary
const codes = (
  itinerary: Pick<Itinerary, "days" | "considered">,
  researched: ResearchedPlace[] = [],
) => findGaps(itinerary, researched).map((gap) => [gap.code, gap.itemId]);

const craftHall: ResearchedPlace = {
  id: "suzunari-craft-hall",
  name: "鈴鳴和紙の館",
  from: "nearby",
};

describe("findGaps：旅に要るものがそろっているか", () => {
  it("移動の区間・最後の移動・帰り・帰りの最終・夜の食事・採否がそろえば、不足はない", () => {
    expect(codes(fictionalPlannedItinerary(), [craftHall])).toEqual([]);
  });

  it("行き・帰りの移動の区間や帰りの最終がない古い形の旅程は、足りないものを名指しする", () => {
    const gaps = codes(fictionalItinerary());
    expect(gaps).toEqual(
      expect.arrayContaining([
        ["return_missing", null],
        ["move_endpoints_missing", "go"],
        ["transfer_unknown", "go"],
      ]),
    );
  });

  it("最初の予定が出発の駅からの移動でなければ、行きの移動が足りない", () => {
    const itinerary = fictionalPlannedItinerary();
    itinerary.days[0]!.items.shift();
    expect(codes(itinerary)).toContainEqual(["outbound_missing", null]);
  });

  it("祭りの会場までの最後の移動がなければ足りない", () => {
    const itinerary = fictionalPlannedItinerary();
    itinerary.days[0]!.items[2]!.move = null;
    expect(codes(itinerary)).toContainEqual(["last_mile_missing", "festival"]);
  });

  it("最後の移動は、祭りの前の準備の移動や、役目が last_mile の移動の予定でもよい", () => {
    const itinerary = fictionalPlannedItinerary();
    const day = itinerary.days[0]!;
    day.items[2]!.move = null;
    day.items.splice(2, 0, {
      id: "to-venue",
      start: "17:00",
      end: "17:15",
      type: "move",
      name: "鈴鳴駅から河原へ",
      location: null,
      reason: "会場まで歩く",
      move: {
        means: "walk",
        minutes: [10, 15],
        estimate: true,
        from: "鈴鳴和紙の館",
        to: "鈴鳴川の河原",
        purpose: "last_mile",
      },
      hours: null,
      cost: null,
      sources: [],
      changedInVersion: 1,
    });
    expect(codes(itinerary).filter(([code]) => code === "last_mile_missing")).toEqual([]);
  });

  it("電車で帰るのに帰りの最終の時刻が分からなければ、推測で埋めずに不足にする", () => {
    const itinerary = fictionalPlannedItinerary();
    itinerary.days[0]!.lastReturn = { station: "鈴鳴駅", departBy: null, sources: [] };
    expect(codes(itinerary)).toContainEqual(["last_return_unknown", "back"]);
  });

  it("電車・バスの移動に出典がなければ足りない", () => {
    const itinerary = fictionalPlannedItinerary();
    itinerary.days[0]!.items[0]!.sources = [];
    expect(codes(itinerary)).toContainEqual(["move_unsourced", "go"]);
  });

  it("夜の祭りの屋台や、店の名前だけの案では、昼の食事に数えない", () => {
    const itinerary = fictionalPlannedItinerary();
    const day = itinerary.days[0]!;
    day.items[0]!.start = "09:30";
    day.items[0]!.end = "10:20";
    const lunchPlan = {
      slot: "lunch" as const,
      name: "昼の案",
      sources: [fictionalSource("2026")],
    };
    day.meals!.push({ ...lunchPlan, kind: "stalls", itemId: "festival" });
    expect(codes(itinerary)).toContainEqual(["meal_missing", null]);
    day.meals![1] = { ...lunchPlan, kind: "shop", itemId: null };
    expect(codes(itinerary)).toContainEqual(["meal_missing", null]);
  });

  it("短すぎる食事の予定は、昼の食事に数えない", () => {
    const itinerary = fictionalPlannedItinerary();
    const day = itinerary.days[0]!;
    day.items[0]!.start = "09:30";
    day.items[0]!.end = "10:20";
    const meal = {
      ...day.items[1]!,
      id: "lunch",
      type: "meal" as const,
      start: "12:00",
      end: "12:15",
      sources: [fictionalSource("2026")],
    };
    day.items.splice(1, 0, meal);
    expect(codes(itinerary)).toContainEqual(["meal_missing", null]);
    meal.end = "12:45";
    expect(codes(itinerary).filter(([code]) => code === "meal_missing")).toEqual([]);
  });

  it("泊まる夜があるのに宿の候補が1つもなければ足りない", () => {
    const itinerary = fictionalPlannedItinerary();
    const day = itinerary.days[0]!;
    const next = { ...day, date: "2026-08-17", stay: null };
    day.stay = { area: "鈴鳴町" };
    itinerary.days.push(next);
    expect(codes(itinerary)).toContainEqual(["lodging_missing", null]);
    day.stay = { area: "鈴鳴町", lodging: fictionalLodgingSearch() };
    expect(codes(itinerary).filter(([code]) => code === "lodging_missing")).toEqual([]);
  });

  it("滞在の時間帯が昼にかかれば昼の、夜にかかれば夜の食事の案が要る", () => {
    const itinerary = fictionalPlannedItinerary();
    const day = itinerary.days[0]!;
    // 行きを朝にずらすと、昼も滞在の時間帯に入る
    day.items[0]!.start = "09:30";
    day.items[0]!.end = "10:20";
    expect(mealsNeeded(day, true, true)).toEqual(["lunch", "dinner"]);
    expect(codes(itinerary)).toContainEqual(["meal_missing", null]);

    // 時間割の予定に結びつかない案は、時間が取れていないので数えない
    const bring = {
      slot: "lunch" as const,
      kind: "bring" as const,
      name: "駅でおにぎりを買っていく",
      itemId: null as string | null,
      sources: [],
    };
    day.meals!.push(bring);
    expect(codes(itinerary)).toContainEqual(["meal_missing", null]);

    // 昼の時間帯にかかる予定の中でとる案なら、数える
    day.items[1]!.start = "12:00";
    day.items[1]!.end = "13:00";
    bring.itemId = day.items[1]!.id;
    expect(codes(itinerary).filter(([code]) => code === "meal_missing")).toEqual([]);
  });

  it("食事の時間帯に食事の予定があれば、食事の案（meals）がなくてもよい", () => {
    const itinerary = fictionalPlannedItinerary();
    const day = itinerary.days[0]!;
    day.meals = [];
    day.items.splice(2, 0, {
      id: "dinner",
      start: "17:30",
      end: "18:10",
      type: "meal",
      name: "鈴鳴そば庵",
      location: { lat: 35.12, lng: 136.08 },
      reason: "地元のそば",
      move: { means: "walk", minutes: [5, 8], estimate: true },
      hours: null,
      cost: null,
      sources: [{ url: "https://example.com/soba", checkedAt: "2026-04-01", confidence: "single" }],
      changedInVersion: 1,
    });
    expect(codes(itinerary).filter(([code]) => code === "meal_missing")).toEqual([]);
  });

  it("滞在が食事の時間帯にかからない短いお出かけには、食事の案は要らない", () => {
    const itinerary = fictionalPlannedItinerary();
    const day = itinerary.days[0]!;
    day.items = day.items.filter((item) => item.id !== "craft-hall");
    day.items[0]!.start = "19:00";
    day.items[0]!.end = "19:50";
    day.items[1]!.start = "20:00";
    day.meals = [];
    expect(mealsNeeded(day, true, true)).toEqual([]);
  });

  it("周辺係が見つけた場所に採否と理由がなければ、名前を挙げて不足にする", () => {
    const itinerary = fictionalPlannedItinerary();
    itinerary.considered = [];
    const gaps = findGaps(itinerary, [craftHall]);
    expect(gaps).toContainEqual({
      code: "research_unreviewed",
      itemId: null,
      message: "調べた場所の採否と理由がありません：鈴鳴和紙の館",
    });
  });

  it("何日かの旅では、行きは1日目、帰りは最後の日だけを確かめ、どの日の不足かを書き添える", () => {
    const planned = fictionalPlannedItinerary();
    const festivalDay = planned.days[0]!;
    const firstDay = {
      ...festivalDay,
      date: "2026-08-15",
      stay: { area: "鈴鳴の町" },
      items: [{ ...festivalDay.items[1]!, id: "d1-hall", start: "10:00", end: "10:50" }],
      meals: [],
      lastReturn: null,
    };
    const gaps = findGaps({ days: [firstDay, festivalDay] });
    expect(gaps.map((gap) => gap.code)).toContain("outbound_missing");
    expect(gaps.find((gap) => gap.code === "outbound_missing")?.message).toMatch(/^1日目：/);
    expect(gaps.map((gap) => gap.code)).not.toContain("return_missing");
  });
});

describe("reconcileConsidered：調べた場所の採否", () => {
  const nearbyRamen: ResearchedPlace = { id: "web-ramen", name: "鈴鳴ラーメン", from: "nearby" };

  it("採ったかは予定の spotId からコードで決め、旅程係の書いた値は使わない", () => {
    const planned = fictionalPlannedItinerary();
    const considered = reconcileConsidered(
      [
        { id: "suzunari-craft-hall", reason: "和紙の作り方が分かる" },
        { id: "web-ramen", reason: "祭りの開始までに戻れない" },
      ],
      planned,
      [craftHall, nearbyRamen],
    );
    expect(considered).toEqual([
      {
        id: "suzunari-craft-hall",
        name: "鈴鳴和紙の館",
        from: "nearby",
        adopted: true,
        reason: "和紙の作り方が分かる",
      },
      {
        id: "web-ramen",
        name: "鈴鳴ラーメン",
        from: "nearby",
        adopted: false,
        reason: "祭りの開始までに戻れない",
      },
    ]);
  });

  it("採った場所の理由がなければ予定の理由を使い、採らなかった場所の理由がなければ入れない", () => {
    const considered = reconcileConsidered([], fictionalPlannedItinerary(), [
      craftHall,
      nearbyRamen,
    ]);
    expect(considered.map((place) => [place.id, place.reason])).toEqual([
      ["suzunari-craft-hall", "灯籠に使う和紙の作り方が分かる"],
    ]);
  });

  it("調べた場所にない ID（旅程係が作った場所）は入れない", () => {
    const considered = reconcileConsidered(
      [{ id: "made-up", reason: "よさそう" }],
      fictionalPlannedItinerary(),
      [],
    );
    expect(considered).toEqual([]);
  });

  it("泊まりに付けた宿の候補は採った場所にし、理由がなければ決まった文を入れる", () => {
    const considered = reconcileConsidered(
      [],
      fictionalPlannedItinerary(),
      [{ id: "web-inn", name: "鈴鳴の宿", from: "lodging" }],
      new Set(["web-inn"]),
    );
    expect(considered).toEqual([
      {
        id: "web-inn",
        name: "鈴鳴の宿",
        from: "lodging",
        adopted: true,
        reason: LODGING_ADOPTED_REASON,
      },
    ]);
  });
});
