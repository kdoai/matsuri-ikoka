import type { PartialTripConditions } from "@matsuri-ikoka/schema";
import { describe, expect, it } from "vitest";
import { MAX_QUESTIONS_PER_TURN, planHearing } from "./hearing";

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
      expect(planHearing(conditions, { festivalChosen: true })).toMatchObject({
        ask: [],
        readyToPlan: true,
      });
    });
  });

  describe("1〜2泊", () => {
    it("探す前は何も足さない", () => {
      expect(planHearing({ ...base, nights: 1 })).toMatchObject({ ask: [], readyToSearch: true });
    });

    it("祭りを選んだら、泊まる場所も祭りの日数も聞かずに案を組む", () => {
      expect(planHearing({ ...base, nights: 2 }, { festivalChosen: true })).toEqual({
        missing: [],
        ask: [],
        readyToSearch: true,
        readyToPlan: true,
      });
    });
  });

  describe("3〜6泊", () => {
    it("旅のかたちを聞いてから探す。巡る旅は地域まで聞く", () => {
      const conditions = { ...base, nights: 5 };
      expect(planHearing(conditions)).toMatchObject({
        ask: ["route"],
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

    it("祭りを選んだら、終わりの場所・ペース・楽しみは聞かずに案を組む", () => {
      const conditions: PartialTripConditions = {
        ...base,
        nights: 4,
        route: { shape: "via", areas: ["鈴鳴町"] },
      };
      expect(planHearing(conditions, { festivalChosen: true })).toMatchObject({
        ask: [],
        readyToPlan: true,
      });
    });

    it("「あとはおまかせ」のあとは聞かない", () => {
      const plan = planHearing(
        { ...base, nights: 6, leaveToStaff: true },
        { festivalChosen: true },
      );
      expect(plan).toEqual({ missing: [], ask: [], readyToSearch: true, readyToPlan: true });
    });
  });
});
