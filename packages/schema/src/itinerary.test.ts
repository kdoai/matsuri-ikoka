import { describe, expect, it } from "vitest";
import {
  collectItinerarySources,
  ItineraryDiffSchema,
  ItinerarySchema,
  VerificationSchema,
  WeatherSchema,
} from "./itinerary";
import { fictionalItinerary, fictionalSource } from "./testing";

describe("ItinerarySchema", () => {
  it("架空の祭りへの旅程を受け付ける", () => {
    expect(ItinerarySchema.safeParse(fictionalItinerary()).success).toBe(true);
  });

  describe("計画の壁：祭りの時間を動かせない予定として持つ", () => {
    it("主役の祭りの予定がない旅程は不正", () => {
      const itinerary = fictionalItinerary();
      itinerary.items = itinerary.items.filter((item) => item.type !== "festival");
      expect(ItinerarySchema.safeParse(itinerary).success).toBe(false);
    });

    it("祭りの予定が主役と別の祭りを指していれば不正", () => {
      const itinerary = fictionalItinerary();
      itinerary.mainFestivalId = "another-festival";
      expect(ItinerarySchema.safeParse(itinerary).success).toBe(false);
    });

    it("祭りの予定には festivalId が必要", () => {
      const itinerary = fictionalItinerary();
      const festival = itinerary.items[2]!;
      delete festival.festivalId;
      expect(ItinerarySchema.safeParse(itinerary).success).toBe(false);
    });
  });

  describe("情報の壁：予定にも出典を持つ", () => {
    it("出典のない祭りの予定は不正", () => {
      const itinerary = fictionalItinerary();
      itinerary.items[2]!.sources = [];
      expect(ItinerarySchema.safeParse(itinerary).success).toBe(false);
    });

    it("出典のない周辺の場所の予定は不正", () => {
      const itinerary = fictionalItinerary();
      itinerary.items[1]!.sources = [];
      expect(ItinerarySchema.safeParse(itinerary).success).toBe(false);
    });

    it("移動時間は必ず目安として持つ", () => {
      const itinerary = fictionalItinerary();
      itinerary.items[0]!.move = { means: "train", minutes: [40, 50], estimate: false as true };
      expect(ItinerarySchema.safeParse(itinerary).success).toBe(false);
    });
  });

  describe("版と差分", () => {
    it("予定の id が重複していれば不正", () => {
      const itinerary = fictionalItinerary();
      itinerary.items[1]!.id = itinerary.items[0]!.id;
      expect(ItinerarySchema.safeParse(itinerary).success).toBe(false);
    });

    it("旅程の版より新しい changedInVersion は不正", () => {
      const itinerary = fictionalItinerary();
      itinerary.items[0]!.changedInVersion = 2;
      expect(ItinerarySchema.safeParse(itinerary).success).toBe(false);
    });

    it("差分は前の版から新しい版へ向かう", () => {
      const diff = { fromVersion: 1, toVersion: 2, added: ["rest"], changed: [], removed: [] };
      expect(ItineraryDiffSchema.safeParse(diff).success).toBe(true);
      expect(ItineraryDiffSchema.safeParse({ ...diff, fromVersion: 2 }).success).toBe(false);
    });

    it("初版の差分は fromVersion が 0", () => {
      const diff = { fromVersion: 0, toVersion: 1, added: ["go"], changed: [], removed: [] };
      expect(ItineraryDiffSchema.safeParse(diff).success).toBe(true);
    });
  });
});

describe("VerificationSchema", () => {
  const checked = { checkedAt: "2026-08-15T09:00:00+09:00", sources: [] };

  it("予定どおりと言うには出典が必要", () => {
    expect(VerificationSchema.safeParse({ status: "as_planned", ...checked }).success).toBe(false);
    expect(
      VerificationSchema.safeParse({
        status: "as_planned",
        ...checked,
        sources: [fictionalSource("2026")],
      }).success,
    ).toBe(true);
  });

  it("確認できなかったことは、出典なしで記録できる", () => {
    expect(VerificationSchema.safeParse({ status: "not_found", ...checked }).success).toBe(true);
  });

  it("確認前は pending", () => {
    expect(VerificationSchema.safeParse({ status: "pending" }).success).toBe(true);
  });
});

describe("WeatherSchema", () => {
  it("予報には出典が必要", () => {
    const forecast = {
      status: "forecast",
      summary: "晴れ",
      precipitationPercent: 10,
      highC: 31,
      lowC: 24,
    };
    expect(WeatherSchema.safeParse(forecast).success).toBe(false);
    expect(
      WeatherSchema.safeParse({ ...forecast, source: fictionalSource("weather") }).success,
    ).toBe(true);
  });

  it("予報の範囲外の日は「予報前」", () => {
    expect(WeatherSchema.safeParse({ status: "not_yet" }).success).toBe(true);
  });
});

describe("collectItinerarySources", () => {
  it("予定と再確認の出典を、URL の重複を除いて集める", () => {
    const itinerary = fictionalItinerary();
    itinerary.items[0]!.sources.push(fictionalSource("2026"));
    itinerary.verification = {
      status: "as_planned",
      checkedAt: "2026-08-15T09:00:00+09:00",
      sources: [fictionalSource("2026-final")],
    };

    expect(collectItinerarySources(itinerary).map((s) => s.url)).toEqual([
      "https://example.com/suzunari/access",
      "https://example.com/suzunari/2026",
      "https://example.com/suzunari/craft-hall",
      "https://example.com/suzunari/2026-final",
    ]);
  });
});
