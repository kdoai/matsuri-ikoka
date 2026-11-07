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

describe("japanClock", () => {
  it("日本の日付と時刻にする", () => {
    expect(japanClock(new Date("2026-08-15T23:30:00Z"))).toEqual({
      date: "2026-08-16",
      time: "08:30",
    });
  });
});
