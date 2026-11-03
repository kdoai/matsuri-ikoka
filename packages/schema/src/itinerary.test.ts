import { describe, expect, it } from "vitest";
import {
  collectItinerarySources,
  ItineraryDiffSchema,
  ItinerarySchema,
  itineraryItems,
  itineraryNights,
  LodgingSearchSchema,
  mainFestivalDay,
  VerificationSchema,
  WeatherSchema,
} from "./itinerary";
import { fictionalItinerary, fictionalLodgingSearch, fictionalSource } from "./testing";

describe("ItinerarySchema", () => {
  it("架空の祭りへの旅程を受け付ける", () => {
    expect(ItinerarySchema.safeParse(fictionalItinerary()).success).toBe(true);
  });

  describe("計画の壁：祭りの時間を動かせない予定として持つ", () => {
    it("主役の祭りの予定がない旅程は不正", () => {
      const itinerary = fictionalItinerary();
      itinerary.days[0]!.items = itinerary.days[0]!.items.filter(
        (item) => item.type !== "festival",
      );
      expect(ItinerarySchema.safeParse(itinerary).success).toBe(false);
    });

    it("祭りの予定が主役と別の祭りを指していれば不正", () => {
      const itinerary = fictionalItinerary();
      itinerary.mainFestivalId = "another-festival";
      expect(ItinerarySchema.safeParse(itinerary).success).toBe(false);
    });

    it("祭りの予定には festivalId が必要", () => {
      const itinerary = fictionalItinerary();
      const festival = itinerary.days[0]!.items[2]!;
      delete festival.festivalId;
      expect(ItinerarySchema.safeParse(itinerary).success).toBe(false);
    });
  });

  describe("情報の壁：予定にも出典を持つ", () => {
    it("出典のない祭りの予定は不正", () => {
      const itinerary = fictionalItinerary();
      itinerary.days[0]!.items[2]!.sources = [];
      expect(ItinerarySchema.safeParse(itinerary).success).toBe(false);
    });

    it("出典のない周辺の場所の予定は不正", () => {
      const itinerary = fictionalItinerary();
      itinerary.days[0]!.items[1]!.sources = [];
      expect(ItinerarySchema.safeParse(itinerary).success).toBe(false);
    });

    it("移動時間は必ず目安として持つ", () => {
      const itinerary = fictionalItinerary();
      itinerary.days[0]!.items[0]!.move = {
        means: "train",
        minutes: [40, 50],
        estimate: false as true,
      };
      expect(ItinerarySchema.safeParse(itinerary).success).toBe(false);
    });
  });

  describe("版と差分", () => {
    it("予定の id が重複していれば不正", () => {
      const itinerary = fictionalItinerary();
      itinerary.days[0]!.items[1]!.id = itinerary.days[0]!.items[0]!.id;
      expect(ItinerarySchema.safeParse(itinerary).success).toBe(false);
    });

    it("旅程の版より新しい changedInVersion は不正", () => {
      const itinerary = fictionalItinerary();
      itinerary.days[0]!.items[0]!.changedInVersion = 2;
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
  it("宿の候補の出典も集める", () => {
    const itinerary = fictionalItinerary();
    const day = itinerary.days[0]!;
    itinerary.days = [
      {
        ...day,
        date: "2026-08-15",
        stay: { area: "鈴鳴町", lodging: fictionalLodgingSearch() },
        items: day.items.map((item) => ({ ...item, id: `d1-${item.id}` })),
      },
      { ...day, date: "2026-08-16" },
    ];
    expect(collectItinerarySources(itinerary).map((s) => s.url)).toContain(
      "https://example.com/lodging",
    );
  });

  it("予定と再確認の出典を、URL の重複を除いて集める", () => {
    const itinerary = fictionalItinerary();
    itinerary.days[0]!.items[0]!.sources.push(fictionalSource("2026"));
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

describe("LodgingSearchSchema", () => {
  it("架空の宿の空きを受け付ける。空きがなければ候補は空", () => {
    expect(LodgingSearchSchema.safeParse(fictionalLodgingSearch()).success).toBe(true);
    expect(LodgingSearchSchema.safeParse({ ...fictionalLodgingSearch(), offers: [] }).success).toBe(
      true,
    );
  });

  it("チェックアウトはチェックインより後", () => {
    const search = { ...fictionalLodgingSearch(), checkOut: "2026-08-15" };
    expect(LodgingSearchSchema.safeParse(search).success).toBe(false);
  });

  it("宿には予約のページ・調べた時刻・出典が要る", () => {
    for (const key of ["bookingUrl", "checkedAt", "source"] as const) {
      const search = fictionalLodgingSearch();
      delete (search.offers[0] as Partial<(typeof search.offers)[number]>)[key];
      expect(LodgingSearchSchema.safeParse(search).success).toBe(false);
    }
  });

  it("予約のページは http(s) だけ", () => {
    const search = fictionalLodgingSearch();
    search.offers[0]!.bookingUrl = "javascript:alert(1)";
    expect(LodgingSearchSchema.safeParse(search).success).toBe(false);
  });
});

describe("日ごとの旅程（日帰りのお出かけから6泊7日まで）", () => {
  /** 架空の旅程を、主役の祭りの前に1泊する2日の旅程にする */
  function twoDays() {
    const itinerary = fictionalItinerary();
    const day = itinerary.days[0]!;
    itinerary.days = [
      {
        date: "2026-08-15",
        weather: { status: "not_yet" },
        stay: { area: "鈴鳴町の駅の近く" },
        items: [{ ...day.items[1]!, id: "day1-hall" }],
      },
      { ...day, date: "2026-08-16" },
    ];
    return itinerary;
  }

  it("1日（日帰り・お出かけ）でも、泊まりの旅でもよい", () => {
    expect(ItinerarySchema.safeParse(fictionalItinerary()).success).toBe(true);
    expect(ItinerarySchema.safeParse(twoDays()).success).toBe(true);
  });

  it("祭りのない日（観光・自由に過ごす時間だけの日）があってよい", () => {
    const itinerary = twoDays();
    itinerary.days[0]!.items = [
      {
        id: "day1-free",
        start: "13:00",
        end: "17:00",
        type: "free",
        name: "宿の近くで自由に過ごす",
        location: null,
        reason: "この日に寄れる場所がデータにないため、自由に過ごす時間にする",
        move: null,
        hours: null,
        cost: null,
        sources: [],
        changedInVersion: 1,
      },
    ];
    expect(ItinerarySchema.safeParse(itinerary).success).toBe(true);
  });

  it("自由に過ごす時間には場所を付けない", () => {
    const itinerary = fictionalItinerary();
    const hall = itinerary.days[0]!.items[1]!;
    itinerary.days[0]!.items[1] = { ...hall, type: "free" };
    expect(ItinerarySchema.safeParse(itinerary).success).toBe(false);
  });

  it("祭りの予定だけの短いお出かけでもよい", () => {
    const itinerary = fictionalItinerary();
    itinerary.days[0]!.items = itinerary.days[0]!.items.filter((item) => item.type === "festival");
    expect(ItinerarySchema.safeParse(itinerary).success).toBe(true);
  });

  it("日付は1日ずつ続ける", () => {
    const itinerary = twoDays();
    itinerary.days[1]!.date = "2026-08-17";
    expect(ItinerarySchema.safeParse(itinerary).success).toBe(false);
  });

  it("泊まりには、調べた宿の候補を付けられる。チェックインはその日", () => {
    const itinerary = twoDays();
    itinerary.days[0]!.stay = { area: "鈴鳴町の駅の近く", lodging: fictionalLodgingSearch() };
    expect(ItinerarySchema.safeParse(itinerary).success).toBe(true);
    itinerary.days[0]!.stay.lodging!.checkIn = "2026-08-14";
    expect(ItinerarySchema.safeParse(itinerary).success).toBe(false);
  });

  it("最後の日は帰る日なので、泊まるところを持たない", () => {
    const itinerary = twoDays();
    itinerary.days[1]!.stay = { area: "鈴鳴町" };
    expect(ItinerarySchema.safeParse(itinerary).success).toBe(false);
  });

  it("予定の id は日をまたいでも重ならない", () => {
    const itinerary = twoDays();
    itinerary.days[0]!.items[0]!.id = "go";
    expect(ItinerarySchema.safeParse(itinerary).success).toBe(false);
  });

  it("7日（6泊）まで。予定のない日は持てない", () => {
    const itinerary = fictionalItinerary();
    const base = itinerary.days[0]!;
    const make = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        ...base,
        date: `2026-08-${String(10 + i).padStart(2, "0")}`,
        stay: i === count - 1 ? null : { area: "鈴鳴町" },
        items: base.items.map((item) => ({ ...item, id: `${item.id}-${i}` })),
      }));
    expect(ItinerarySchema.safeParse({ ...itinerary, days: make(7) }).success).toBe(true);
    expect(ItinerarySchema.safeParse({ ...itinerary, days: make(8) }).success).toBe(false);
    expect(
      ItinerarySchema.safeParse({ ...itinerary, days: [{ ...base, items: [] }] }).success,
    ).toBe(false);
  });

  it("主役の祭りは、どの日にあってもよい", () => {
    const itinerary = twoDays();
    expect(mainFestivalDay(itinerary).date).toBe("2026-08-16");
    expect(itineraryNights(itinerary)).toBe(1);
    expect(itineraryItems(itinerary).map((item) => item.id)).toEqual([
      "day1-hall",
      "go",
      "craft-hall",
      "festival",
    ]);
  });

  it("日ごとの天気の出典も集める", () => {
    const itinerary = twoDays();
    itinerary.days[0]!.weather = {
      status: "forecast",
      summary: "晴れ",
      precipitationPercent: 10,
      highC: 30,
      lowC: 24,
      source: fictionalSource("weather"),
    };
    expect(collectItinerarySources(itinerary).map((s) => s.url)).toContain(
      "https://example.com/suzunari/weather",
    );
  });
});
