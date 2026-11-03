import type { PartialTripConditions } from "@matsuri-ikoka/schema";
import { describe, expect, it } from "vitest";
import { festivalOpenDaysAround, MAX_QUESTIONS_PER_TURN, planHearing } from "./hearing";
import { testFestival } from "./testFestivals";

const base: PartialTripConditions = {
  when: { kind: "date", date: "2026-08-16" },
  origin: "みなと中央駅",
};

describe("planHearing", () => {
  it("日付・出発地・泊数がそろうまでは、それだけを聞く（1回に2つまで）", () => {
    const plan = planHearing({});
    expect(plan.missing).toEqual(["when", "origin", "nights"]);
    expect(plan.ask).toEqual(["when", "origin"]);
    expect(plan.ask.length).toBeLessThanOrEqual(MAX_QUESTIONS_PER_TURN);
    expect(plan.readyToSearch).toBe(false);
  });

  it("言われたことは聞き直さない", () => {
    expect(planHearing({ origin: "みなと中央駅" }).ask).toEqual(["when", "nights"]);
  });

  describe("日帰り・お出かけ（0泊）", () => {
    it("3つがそろえばすぐ探し、祭りを選んだらそれ以上は聞かない", () => {
      const conditions = { ...base, nights: 0 };
      expect(planHearing(conditions)).toEqual({
        missing: [],
        ask: [],
        readyToSearch: true,
        readyToPlan: false,
      });
      expect(
        planHearing(conditions, { festivalChosen: true, multiDayFestival: true }),
      ).toMatchObject({ ask: [], readyToPlan: true });
    });
  });

  describe("1〜2泊", () => {
    it("探す前は何も足さない", () => {
      expect(planHearing({ ...base, nights: 1 })).toMatchObject({ ask: [], readyToSearch: true });
    });

    it("祭りを選んだら泊まる場所の希望を聞き、何日も開かれる祭りなら祭りの日数も聞く", () => {
      const conditions = { ...base, nights: 2 };
      expect(planHearing(conditions, { festivalChosen: true }).ask).toEqual(["stayNear"]);
      expect(planHearing(conditions, { festivalChosen: true, multiDayFestival: true }).ask).toEqual(
        ["festivalDays", "stayNear"],
      );
      expect(
        planHearing(
          { ...conditions, stayNear: "auto", festivalDays: "one" },
          { festivalChosen: true, multiDayFestival: true },
        ),
      ).toMatchObject({ ask: [], readyToPlan: true });
    });
  });

  describe("3〜6泊", () => {
    it("旅のかたちを聞いてから探す。巡る旅は地域まで聞く", () => {
      const conditions = { ...base, nights: 5 };
      expect(planHearing(conditions)).toMatchObject({
        ask: ["route", "returnTo"],
        readyToSearch: false,
      });
      expect(
        planHearing({ ...conditions, route: { shape: "loop", areas: [] } }).readyToSearch,
      ).toBe(false);
      expect(
        planHearing({ ...conditions, route: { shape: "loop", areas: ["かざみ温泉"] } })
          .readyToSearch,
      ).toBe(true);
      expect(
        planHearing({ ...conditions, route: { shape: "stay", areas: [] } }).readyToSearch,
      ).toBe(true);
    });

    it("組む前に、終わりの場所・ペース・楽しみを2つずつ聞く", () => {
      const conditions: PartialTripConditions = {
        ...base,
        nights: 4,
        route: { shape: "via", areas: ["鈴鳴町"] },
      };
      const chosen = { festivalChosen: true };
      expect(planHearing(conditions, chosen).ask).toEqual(["returnTo", "pace"]);
      expect(planHearing({ ...conditions, returnTo: "やまびこ駅", pace: "auto" }, chosen)).toEqual({
        missing: ["interests"],
        ask: ["interests"],
        readyToSearch: true,
        readyToPlan: false,
      });
      expect(
        planHearing(
          { ...conditions, returnTo: "やまびこ駅", pace: "relaxed", interests: [] },
          chosen,
        ).readyToPlan,
      ).toBe(true);
    });

    it("「あとはおまかせ」のあとは聞かない", () => {
      const plan = planHearing(
        { ...base, nights: 6, leaveToStaff: true },
        { festivalChosen: true, multiDayFestival: true },
      );
      expect(plan).toEqual({ missing: [], ask: [], readyToSearch: true, readyToPlan: true });
    });
  });
});

describe("festivalOpenDaysAround", () => {
  it("行く日の前後（泊数の日数ずつ）に開かれる日を数える", () => {
    const threeDays = testFestival({ id: "kazami-bon", date: "2026-08-14", endDate: "2026-08-16" });
    expect(festivalOpenDaysAround(threeDays, "2026-08-16", 0)).toBe(1);
    expect(festivalOpenDaysAround(threeDays, "2026-08-16", 1)).toBe(2);
    expect(festivalOpenDaysAround(threeDays, "2026-08-16", 3)).toBe(3);
  });

  it("中止の回は数えない", () => {
    const cancelled = testFestival({
      id: "kazami-bon",
      date: "2026-08-14",
      endDate: "2026-08-16",
      status: "cancelled",
    });
    expect(festivalOpenDaysAround(cancelled, "2026-08-16", 3)).toBe(0);
  });
});
