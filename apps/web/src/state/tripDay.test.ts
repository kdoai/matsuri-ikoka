import type { Itinerary } from "@matsuri-ikoka/schema";
import { fictionalItinerary, fictionalPlannedItinerary } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { japanClock, tripDayGlance } from "./tripDay";

const on = (time: string, date = "2026-08-16") => ({ date, time });

describe("tripDayGlance", () => {
  const itinerary = fictionalPlannedItinerary();

  it("旅の日でなければ出さない", () => {
    expect(tripDayGlance(itinerary, on("10:00", "2026-08-15"))).toBeNull();
    expect(tripDayGlance(itinerary, on("10:00", "2026-08-17"))).toBeNull();
  });

  it("朝は、最初の予定・最初の移動・帰りの最終を出す", () => {
    expect(tripDayGlance(itinerary, on("09:00"))).toEqual({
      date: "2026-08-16",
      next: {
        id: "go",
        start: "14:30",
        end: "15:20",
        name: "みなと中央駅から鈴鳴駅へ",
        now: false,
      },
      departure: {
        itemId: "go",
        at: "14:30",
        from: "みなと中央駅",
        to: "鈴鳴駅",
        line: "みなと線",
      },
      lastReturn: { status: "known", station: "鈴鳴駅", departBy: "22:40" },
    });
  });

  it("予定の途中なら、その予定を今のこととして出し、次の移動は帰りになる", () => {
    const glance = tripDayGlance(itinerary, on("19:00"));
    expect(glance?.next).toMatchObject({ id: "festival", now: true });
    expect(glance?.departure).toMatchObject({ itemId: "back", at: "21:20", to: "みなと中央駅" });
  });

  it("予定が残っていなければ、次の予定と出発を出さない", () => {
    const glance = tripDayGlance(itinerary, on("23:00"));
    expect(glance?.next).toBeNull();
    expect(glance?.departure).toBeNull();
  });

  it("帰りの最終を調べられなかった日は、分からないと出す", () => {
    expect(tripDayGlance(fictionalItinerary(), on("09:00"))?.lastReturn).toEqual({
      status: "unknown",
      station: null,
    });
  });

  it("泊まる日は、帰りの最終を出さない", () => {
    const stay = fictionalItinerary();
    const day = stay.days[0] as Itinerary["days"][number];
    day.stay = { area: "鈴鳴町" };
    expect(tripDayGlance(stay, on("09:00"))?.lastReturn).toEqual({ status: "none" });
  });
});

describe("0時をまたぐ帰り", () => {
  /** 帰りの移動が 00:20–01:10、最終が 00:20 の日帰り */
  function lateItinerary(): Itinerary {
    const itinerary = fictionalPlannedItinerary();
    const day = itinerary.days[0] as Itinerary["days"][number];
    const back = day.items.find((item) => item.id === "back");
    if (back === undefined) throw new Error("帰りの予定がありません");
    back.start = "00:20";
    back.end = "01:10";
    day.lastReturn = {
      station: "鈴鳴駅",
      departBy: "00:20",
      sources: day.lastReturn?.sources ?? [],
    };
    return itinerary;
  }

  it("23:55 には、0時を過ぎた帰りの移動と最終をこれからのこととして出す", () => {
    const glance = tripDayGlance(lateItinerary(), on("23:55"));
    expect(glance?.next).toMatchObject({ id: "back", now: false });
    expect(glance?.departure).toMatchObject({ itemId: "back", at: "00:20" });
    expect(glance?.lastReturn).toEqual({ status: "known", station: "鈴鳴駅", departBy: "00:20" });
  });

  it("日付が変わった 00:05 も、前の旅の日の続きとして出す", () => {
    const glance = tripDayGlance(lateItinerary(), on("00:05", "2026-08-17"));
    expect(glance?.date).toBe("2026-08-16");
    expect(glance?.departure).toMatchObject({ itemId: "back", at: "00:20" });
    expect(glance?.lastReturn.status).toBe("known");
  });

  it("最終の時刻を過ぎたら、過ぎたことを出す", () => {
    const glance = tripDayGlance(lateItinerary(), on("00:30", "2026-08-17"));
    expect(glance?.lastReturn).toEqual({ status: "passed", station: "鈴鳴駅", departBy: "00:20" });
    expect(glance?.next).toMatchObject({ id: "back", now: true });
  });

  it("4:00 を過ぎたら、前の日の続きとしては出さない", () => {
    expect(tripDayGlance(lateItinerary(), on("04:00", "2026-08-17"))).toBeNull();
  });

  it("その日のうちの最終も、時刻を過ぎたら過ぎたと出す", () => {
    expect(tripDayGlance(fictionalPlannedItinerary(), on("22:41"))?.lastReturn.status).toBe(
      "passed",
    );
  });

  it("泊まりの旅の翌日の未明は、予定が残っていなければ次の旅の日を見せる", () => {
    const stay = fictionalPlannedItinerary();
    const first = stay.days[0] as Itinerary["days"][number];
    first.stay = { area: "鈴鳴町" };
    first.lastReturn = null;
    first.items = first.items.filter((item) => item.id !== "back");
    stay.days.push({ ...structuredClone(first), date: "2026-08-17", stay: null });
    expect(tripDayGlance(stay, on("01:00", "2026-08-17"))?.date).toBe("2026-08-17");
  });
});

describe("japanClock", () => {
  it("日本の日付と時刻にする", () => {
    expect(japanClock(new Date("2026-08-15T23:30:00Z"))).toEqual({
      date: "2026-08-16",
      time: "08:30",
    });
  });
});
