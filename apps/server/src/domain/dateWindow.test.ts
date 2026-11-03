import { DEFAULT_PREFERENCES, type Preferences } from "@matsuri-ikoka/schema";
import { describe, expect, it } from "vitest";
import {
  DAY_TRIP_MAX_TRAVEL_MINUTES,
  daysFromWish,
  dayTripTravelLimit,
  placeLabel,
  searchFestivalDates,
  searchRanges,
  toCandidate,
  travelMinutesFrom,
} from "./dateWindow";
import { testFestival } from "./testFestivals";

const day = (date: string) => ({ kind: "date" as const, date });
const base = {
  origin: "みなと中央駅",
  nights: 1,
  preferences: { ...DEFAULT_PREFERENCES } as Preferences,
};

const ids = (result: ReturnType<typeof searchFestivalDates>) =>
  result.matches.map((m) => [m.festival.id, m.daysFromWish]);

// docs/spec/testing.md の「日程のルールのテストケース」
describe("日程のルール", () => {
  it("1. 希望日の祭りを先頭に、3件に満たない分を前後2週間で補い、ずれを付ける", () => {
    const festivals = [
      testFestival({ id: "later", date: "2026-08-22" }),
      testFestival({ id: "wish-day", date: "2026-08-16" }),
      testFestival({ id: "day-before", date: "2026-08-15" }),
      testFestival({ id: "too-late", date: "2026-08-31" }),
      testFestival({ id: "past", date: "2026-08-02" }),
    ];

    const result = searchFestivalDates(festivals, {
      ...base,
      wish: day("2026-08-16"),
      today: "2026-08-03",
    });

    expect(result.ranges).toEqual({
      wish: { from: "2026-08-16", to: "2026-08-16" },
      expanded: { from: "2026-08-03", to: "2026-08-30" },
    });
    expect(ids(result)).toEqual([
      ["wish-day", 0],
      ["day-before", -1],
      ["later", 6],
    ]);
  });

  it("2. 希望日に祭りがなければ、前後2週間からずれの日数つきで返す", () => {
    const festivals = [
      testFestival({ id: "before", date: "2026-08-10" }),
      testFestival({ id: "after", date: "2026-08-20" }),
    ];

    const result = searchFestivalDates(festivals, {
      ...base,
      wish: day("2026-08-16"),
      today: "2026-08-03",
    });

    expect(ids(result)).toEqual([
      ["after", 4],
      ["before", -6],
    ]);
  });

  it("3. 期間の希望（来週末）で、前側が過去にかかれば今日以降に絞る", () => {
    const festivals = [
      testFestival({ id: "past", date: "2026-08-05" }),
      testFestival({ id: "soon", date: "2026-08-09" }),
      testFestival({ id: "far", date: "2026-08-29" }),
    ];

    const result = searchFestivalDates(festivals, {
      ...base,
      wish: { kind: "range", from: "2026-08-15", to: "2026-08-16" },
      today: "2026-08-08",
    });

    expect(result.ranges.expanded).toEqual({ from: "2026-08-08", to: "2026-08-30" });
    expect(ids(result)).toEqual([
      ["soon", -6],
      ["far", 13],
    ]);
  });

  it("4. 希望日が近いときも、今日より前の日は出さない", () => {
    const festivals = [
      testFestival({ id: "yesterday", date: "2026-08-02" }),
      testFestival({ id: "edge", date: "2026-08-18" }),
      testFestival({ id: "outside", date: "2026-08-19" }),
    ];

    const result = searchFestivalDates(festivals, {
      ...base,
      wish: day("2026-08-04"),
      today: "2026-08-03",
    });

    expect(result.ranges.expanded).toEqual({ from: "2026-08-03", to: "2026-08-18" });
    expect(ids(result)).toEqual([["edge", 14]]);
  });

  it("5. 開催が確認できていない祭りは「未確認」として返す", () => {
    const festivals = [
      testFestival({
        id: "expected",
        date: "2026-08-16",
        status: "expected",
        confidence: "single",
      }),
    ];

    const result = searchFestivalDates(festivals, {
      ...base,
      wish: day("2026-08-16"),
      today: "2026-08-03",
    });

    expect(result.ranges.wish).toEqual({ from: "2026-08-16", to: "2026-08-16" });
    expect(result.matches).toHaveLength(1);
    const candidate = toCandidate(result.matches[0]!);
    expect(candidate).toMatchObject({ festivalId: "expected", daysFromWish: 0, confirmed: false });
    expect(candidate.confidence).toBe("single");
  });

  it("6. 日帰りでは、移動の上限を超える遠くの祭りを除いて前後2週間へ広げる", () => {
    const festivals = [
      testFestival({ id: "far-away", date: "2026-08-16", fromHubMinutes: [120, 140] }),
      testFestival({ id: "nearby", date: "2026-08-20", fromHubMinutes: [30, 40] }),
    ];

    const result = searchFestivalDates(festivals, {
      ...base,
      nights: 0,
      maxTravelMinutes: 90,
      wish: day("2026-08-16"),
      today: "2026-08-03",
    });

    expect(ids(result)).toEqual([["nearby", 4]]);
    expect(result.tooFar).toEqual([{ festivalId: "far-away", travelMinutes: [128, 152] }]);
  });
});

describe("日帰りの所要時間の上限", () => {
  // 徒歩（8〜12分）を足すので、主要駅からの分に 8〜12 分が加わる
  const festivals = [
    testFestival({ id: "within-hour", date: "2026-08-16", fromHubMinutes: [40, 45] }),
    testFestival({ id: "within-two", date: "2026-08-16", fromHubMinutes: [90, 100] }),
    testFestival({ id: "unknown", date: "2026-08-16", fromHubMinutes: null }),
  ];
  const search = (nights: number, maxTravelMinutes?: number) =>
    searchFestivalDates(festivals, {
      ...base,
      nights,
      wish: day("2026-08-16"),
      today: "2026-08-03",
      ...(maxTravelMinutes === undefined ? {} : { maxTravelMinutes }),
    });

  it("泊まりの旅は絞り込まず、日帰りは言われた上限か初期値を使う", () => {
    expect(dayTripTravelLimit(1, 60)).toBeNull();
    expect(dayTripTravelLimit(0, 60)).toBe(60);
    expect(dayTripTravelLimit(0, undefined)).toBe(DAY_TRIP_MAX_TRAVEL_MINUTES);
  });

  it("1時間以内なら、片道の上側の目安が60分を超える祭りを除く", () => {
    const result = search(0, 60);
    expect(result.matches.map((m) => m.festival.id)).toEqual(["within-hour", "unknown"]);
    expect(result.tooFar).toEqual([{ festivalId: "within-two", travelMinutes: [98, 112] }]);
  });

  it("2時間以内なら、どちらも残し、分かっている祭りを分からない祭りより先に並べる", () => {
    const result = search(0, 120);
    expect(result.matches.map((m) => m.festival.id)).toEqual([
      "within-hour",
      "within-two",
      "unknown",
    ]);
    expect(result.tooFar).toEqual([]);
    expect(result.travelUnknown).toEqual(["unknown"]);
  });

  it("泊まりの旅では、上限を言われても絞り込まない", () => {
    const result = search(1, 60);
    expect(result.matches).toHaveLength(3);
    expect(result.tooFar).toEqual([]);
    expect(result.travelUnknown).toEqual([]);
  });
});

describe("searchFestivalDates", () => {
  const options = { ...base, wish: day("2026-08-16"), today: "2026-08-03" };

  it("掲載停止・中止・延期の祭りは出さない", () => {
    const festivals = [
      testFestival({ id: "opted-out", optOut: true }),
      testFestival({ id: "cancelled", status: "cancelled" }),
      testFestival({ id: "postponed", status: "postponed" }),
      testFestival({ id: "ok" }),
    ];

    expect(ids(searchFestivalDates(festivals, options))).toEqual([["ok", 0]]);
  });

  it("候補は最大3件", () => {
    const festivals = ["a", "b", "c", "d"].map((id) => testFestival({ id }));

    expect(searchFestivalDates(festivals, options).matches).toHaveLength(3);
  });

  it("複数日の開催で希望日にかかれば、希望日をずれ0で返す", () => {
    const festivals = [testFestival({ id: "long", date: "2026-08-14", endDate: "2026-08-17" })];

    const [match] = searchFestivalDates(festivals, options).matches;

    expect(match).toMatchObject({ date: "2026-08-16", daysFromWish: 0 });
  });

  it("同じ日なら、確認済みの祭りを先に、こだわり（穴場・定番）に合う順に並べる", () => {
    const festivals = [
      testFestival({ id: "major", popularity: "major" }),
      testFestival({ id: "local", popularity: "local" }),
      testFestival({ id: "unconfirmed", status: "expected" }),
    ];

    const hidden = searchFestivalDates(festivals, {
      ...options,
      preferences: { ...DEFAULT_PREFERENCES, spot: "hidden" },
    });
    const classic = searchFestivalDates(festivals, {
      ...options,
      preferences: { ...DEFAULT_PREFERENCES, spot: "classic" },
    });

    expect(ids(hidden).map(([id]) => id)).toEqual(["local", "major", "unconfirmed"]);
    expect(ids(classic).map(([id]) => id)).toEqual(["major", "local", "unconfirmed"]);
  });

  it("日帰りでも、移動時間の分からない祭りは除かない", () => {
    const festivals = [testFestival({ id: "unknown-travel", fromHubMinutes: null })];

    const [match] = searchFestivalDates(festivals, { ...options, nights: 0 }).matches;

    expect(match?.festival.id).toBe("unknown-travel");
    expect(match?.travelMinutes).toBeNull();
  });

  it("希望日がすべて過去なら何も返さない", () => {
    const result = searchFestivalDates([testFestival({ id: "old", date: "2026-07-01" })], {
      ...options,
      wish: day("2026-07-01"),
    });

    expect(result.ranges).toEqual({ wish: null, expanded: null });
    expect(result.matches).toEqual([]);
  });
});

describe("searchRanges と daysFromWish", () => {
  it("前後2週間に広げ、今日より前を切る", () => {
    expect(searchRanges(day("2026-08-04"), "2026-08-03")).toEqual({
      wish: { from: "2026-08-04", to: "2026-08-04" },
      expanded: { from: "2026-08-03", to: "2026-08-18" },
    });
  });

  it("期間の中は0、前は負、後は正", () => {
    const wish = { kind: "range" as const, from: "2026-08-15", to: "2026-08-16" };
    expect(daysFromWish("2026-08-15", wish)).toBe(0);
    expect(daysFromWish("2026-08-12", wish)).toBe(-3);
    expect(daysFromWish("2026-08-19", wish)).toBe(3);
  });
});

describe("travelMinutesFrom", () => {
  it("主要駅からの所要時間に、最寄り駅からの徒歩を足す。駅の有無は問わずに照らし合わせる", () => {
    const festival = testFestival({ id: "x", fromHubMinutes: [40, 50] });

    expect(travelMinutesFrom(festival.access, "みなと中央駅")).toEqual([48, 62]);
    expect(travelMinutesFrom(festival.access, "みなと中央")).toEqual([48, 62]);
    expect(travelMinutesFrom(festival.access, "ほかの駅")).toBeNull();
  });
});

describe("toCandidate", () => {
  it("候補カードの形にする", () => {
    const festival = testFestival({ id: "card" });
    const [match] = searchFestivalDates([festival], {
      ...base,
      wish: day("2026-08-16"),
      today: "2026-08-03",
    }).matches;

    expect(toCandidate(match!)).toEqual({
      festivalId: "card",
      name: "card まつり",
      date: "2026-08-16",
      start: "18:30",
      end: "21:00",
      venueName: "鈴鳴川の河原",
      place: placeLabel(festival),
      daysFromWish: 0,
      confidence: "official",
      confirmed: true,
      highlight: "川面に浮かぶ千の灯籠",
      source: festival.occurrences[0]!.sources[0],
    });
    expect(placeLabel(festival)).toBe("滋賀県鈴鳴町");
  });
});
