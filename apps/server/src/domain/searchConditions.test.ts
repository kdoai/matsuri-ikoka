import {
  DEFAULT_PREFERENCES,
  type Festival,
  type FestivalCandidate,
  type Prefecture,
} from "@matsuri-ikoka/schema";
import { fictionalSource } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { searchFestivalDates } from "./dateWindow";
import {
  applyRetry,
  formatMinuteRange,
  formatMinutes,
  nearMissesOf,
  nextWeekend,
  plannedSteps,
  runSearch,
  type SearchDeps,
  type SearchQuery,
  suggestNextSteps,
  withinConditions,
} from "./searchConditions";
import { testFestival } from "./testFestivals";
import { createStationPointIndex, estimateTravel, type StationPoint } from "./travelEstimate";

// 架空の駅と町。実在の駅・町ではない。
// 出発の駅「やまなみ」から、近野（約15km）は近く、遠見（直線で約220km）は遠い
const POINTS: StationPoint[] = [
  ["やまなみ", 36.7, 137.0],
  ["近野", 36.6, 136.9],
  ["遠見", 35.02, 135.68],
];
const stations = createStationPointIndex(POINTS);

function placed(
  id: string,
  options: { date?: string; prefecture: Prefecture; venue: { lat: number; lng: number } },
): Festival {
  return testFestival({
    id,
    date: options.date ?? "2026-11-07",
    fromHubMinutes: null,
    edit: (f) => {
      f.municipalities = [{ prefecture: options.prefecture, name: `${id}町` }];
      f.venue = { name: `${id}の広場`, ...options.venue };
      f.access.stations = [{ name: "近くの駅", walkMinutes: [0, 0] }];
    },
  });
}

const near = (id: string, date?: string) =>
  placed(id, { prefecture: "富山県", venue: { lat: 36.6, lng: 136.9 }, ...(date ? { date } : {}) });
const far = (id: string, date?: string) =>
  placed(id, {
    prefecture: "京都府",
    venue: { lat: 35.02, lng: 135.68 },
    ...(date ? { date } : {}),
  });

function deps(festivals: Festival[]): SearchDeps {
  return {
    today: "2026-11-04",
    festivalsOn: () => festivals,
    travelFor: (festival) =>
      estimateTravel(
        { access: festival.access, venue: festival.venue, origin: "やまなみ" },
        stations,
      ),
    random: () => 0,
  };
}

const dayTrip: SearchQuery = {
  when: { kind: "range", from: "2026-11-07", to: "2026-11-08" },
  origin: "やまなみ",
  nights: 0,
  maxTravelMinutes: 180,
  prefectures: [],
  destinationLabel: "",
  widen: "area",
  preferences: { ...DEFAULT_PREFERENCES },
};

const ids = (items: readonly { festival: Festival }[]) => items.map((m) => m.festival.id);

describe("条件の検査（片道の所要時間）", () => {
  it("これまでの絞り込みでは、見積もりの幅が上限をまたぐ遠い祭りが「境目」として候補に残っていた", () => {
    const old = searchFestivalDates([far("far-kyoto")], {
      wish: dayTrip.when,
      today: "2026-11-04",
      origin: "やまなみ",
      nights: 0,
      maxTravelMinutes: 180,
      preferences: dayTrip.preferences,
      travelFor: deps([]).travelFor,
    });
    expect(old.matches.map((m) => [m.festival.id, m.travelFit])).toEqual([
      ["far-kyoto", "uncertain"],
    ]);
  });

  it("上限を言われた日帰りでは、上限に収まると分かっている祭りだけを候補にし、遠い祭りは理由を残して外す", () => {
    const attempt = runSearch(dayTrip, deps([far("far-kyoto"), near("near-toyama")]));

    expect(ids(attempt.fits)).toEqual(["near-toyama"]);
    expect(attempt.fits[0]?.travel).toMatchObject({ limitMinutes: 180, fit: "within" });
    expect(attempt.misses.map((m) => [m.festival.id, m.misses.map((x) => x.condition)])).toEqual([
      ["far-kyoto", ["travel"]],
    ]);
    expect(attempt.misses[0]?.misses[0]?.detail).toMatch(
      /^片道およそ.+（駅の位置からの見積もり）で、上限の3時間を超えるかもしれません$/,
    );
  });

  it("上限を言われていなければ（初期値）、明らかに遠い祭りだけを外し、境目の祭りは残す", () => {
    const { maxTravelMinutes: _, ...withoutLimit } = dayTrip;
    const attempt = runSearch(
      { ...withoutLimit, when: { kind: "date", date: "2026-11-07" } },
      deps([far("far-kyoto"), near("near-toyama")]),
    );
    expect(ids(attempt.fits)).toEqual(["near-toyama", "far-kyoto"]);
    expect(attempt.fits[1]?.travel).toMatchObject({ limitMinutes: 150, fit: "uncertain" });
  });

  it("所要時間が分からない祭りは、上限を言われたら候補にしない", () => {
    const unknown = testFestival({ id: "no-route", date: "2026-11-07", fromHubMinutes: null });
    const attempt = runSearch(dayTrip, { ...deps([unknown]), travelFor: () => null });
    expect(attempt.fits).toEqual([]);
    expect(attempt.misses[0]?.misses[0]?.detail).toBe(
      "出発の駅からの所要時間が分からず、片道3時間以内に収まるか確かめられません",
    );
  });

  it("泊まりの旅では、片道の時間で外さない", () => {
    const attempt = runSearch({ ...dayTrip, nights: 1 }, deps([far("far-kyoto")]));
    expect(ids(attempt.fits)).toEqual(["far-kyoto"]);
    expect(attempt.fits[0]?.travel).toMatchObject({ limitMinutes: null, fit: null });
  });
});

describe("条件の検査（日程と行き先）", () => {
  it("希望の日程から外れた祭りは候補にせず、何日ずれているかを残す", () => {
    const attempt = runSearch(dayTrip, deps([near("near-later", "2026-11-14")]));
    expect(attempt.fits).toEqual([]);
    expect(attempt.misses[0]?.misses).toEqual([
      { condition: "date", detail: "ご希望の日の6日後（11月14日）に開きます" },
    ]);
  });

  it("行き先の外の祭りは、外れた点を添え、了承を得た段階より先の祭りを候補にしない", () => {
    const query = {
      ...dayTrip,
      nights: 1,
      prefectures: ["石川県"] as Prefecture[],
      destinationLabel: "石川",
    };
    const attempt = runSearch(query, deps([far("far-kyoto")]));
    expect(attempt.fits).toEqual([]);
    expect(attempt.destination.kind).toBe("ask");
    expect(attempt.misses[0]?.misses).toEqual([
      { condition: "area", detail: "行き先（石川）の外の京都府にあります" },
    ]);
  });
});

describe("この祭りならやっています（条件を1つだけ外せば出る祭り）", () => {
  it("外れている条件が1つの祭りを、条件がかたよらないよう選ぶ。2つ外れる祭りと、ずっと遠い祭りは出さない", () => {
    const veryFar = placed("very-far", {
      prefecture: "鹿児島県",
      venue: { lat: 31.6, lng: 130.6 },
    });
    const attempt = runSearch(
      dayTrip,
      deps([
        near("near-later", "2026-11-14"),
        near("near-later-2", "2026-11-15"),
        far("far-kyoto"),
        far("far-later", "2026-11-14"),
        veryFar,
      ]),
    );
    expect(attempt.fits).toEqual([]);
    const picked = nearMissesOf(attempt);
    expect(picked.map((p) => [p.match.festival.id, p.miss.condition])).toEqual([
      ["near-later", "date"],
      ["far-kyoto", "travel"],
      ["near-later-2", "date"],
    ]);
  });
});

describe("次の手", () => {
  it("次の週末は、希望の日程が終わったあとの土日", () => {
    expect(nextWeekend({ kind: "range", from: "2026-11-07", to: "2026-11-08" })).toEqual({
      kind: "range",
      from: "2026-11-14",
      to: "2026-11-15",
    });
    expect(nextWeekend({ kind: "date", date: "2026-11-11" })).toEqual({
      kind: "range",
      from: "2026-11-14",
      to: "2026-11-15",
    });
  });

  it("日帰りでは、日程・片道の時間・泊まりの順に試す。行き先があれば広げる手も試す", () => {
    expect(plannedSteps(dayTrip).map((s) => [s.kind, s.label])).toEqual([
      ["later_dates", "次の週末（11月14日〜11月15日）で探す"],
      ["later_dates", "4週間後（12月5日〜12月6日）で探す"],
      ["longer_travel", "片道4時間まで広げる"],
      ["stay_over", "1泊の旅にする"],
    ]);
    const withArea = { ...dayTrip, nights: 2, prefectures: ["富山県"] as Prefecture[] };
    expect(plannedSteps(withArea).map((s) => s.retry)).toEqual([
      { when: { kind: "range", from: "2026-11-14", to: "2026-11-15" } },
      { when: { kind: "range", from: "2026-12-05", to: "2026-12-06" } },
      { widen: "neighbor" },
      { widen: "nationwide" },
    ]);
  });

  it("変えた条件で探し直して数え、祭りが見つかる手だけを出す。最後に「条件を選び直す」を付ける", () => {
    const festivals = [near("near-later", "2026-11-14"), far("far-kyoto")];
    const { suggestions, attempts } = suggestNextSteps(dayTrip, deps(festivals));
    expect(suggestions.map((s) => [s.kind, s.found])).toEqual([
      ["later_dates", 1],
      ["longer_travel", 1],
      ["stay_over", 1],
      ["edit_conditions", null],
    ]);
    expect(suggestions[0]?.message).toBe(
      "日程を11月14日〜11月15日に変えて、もう一度祭りを探してください。",
    );
    expect(attempts).toBe(5);
  });

  it("いまの候補にある祭りしか見つからない手は出さない", () => {
    const festivals = [near("near-toyama"), near("near-next-week", "2026-11-14")];
    const { suggestions } = suggestNextSteps(dayTrip, deps(festivals), {
      shown: new Set(["near-toyama"]),
    });
    expect(suggestions.map((s) => [s.kind, s.found])).toEqual([
      ["later_dates", 1],
      ["edit_conditions", null],
    ]);
  });

  it("探す回数は、はじめの検索を含めて上限まで", () => {
    const { suggestions, attempts } = suggestNextSteps(dayTrip, deps([]), { maxAttempts: 3 });
    expect(attempts).toBe(3);
    expect(suggestions.map((s) => s.kind)).toEqual(["edit_conditions"]);
  });

  it("次の手の条件は、渡した項目だけを変える", () => {
    expect(applyRetry(dayTrip, { maxTravelMinutes: 240 })).toEqual({
      ...dayTrip,
      maxTravelMinutes: 240,
    });
    expect(applyRetry(dayTrip, { nights: 1 })).toEqual({ ...dayTrip, nights: 1 });
  });
});

describe("出す直前の確かめ", () => {
  const candidate = (overrides: Partial<FestivalCandidate>): FestivalCandidate => ({
    festivalId: "near-toyama",
    name: "near-toyama まつり",
    date: "2026-11-07",
    start: null,
    end: null,
    venueName: "広場",
    place: "富山県近野町",
    daysFromWish: 0,
    confidence: "official",
    confirmed: true,
    highlight: "見どころ",
    source: fictionalSource("2026"),
    travel: { minutes: [40, 60], basis: "estimate", limitMinutes: 180, fit: "within" },
    ...overrides,
  });
  const toyama = { municipalities: [{ prefecture: "富山県" as const, name: "近野町" }] };

  it("希望の日程の中で、上限に収まる候補だけを通す", () => {
    expect(withinConditions(candidate({}), toyama, dayTrip)).toBe(true);
    expect(withinConditions(candidate({ daysFromWish: 1 }), toyama, dayTrip)).toBe(false);
    expect(
      withinConditions(
        candidate({
          travel: { minutes: [80, 235], basis: "estimate", limitMinutes: 180, fit: "uncertain" },
        }),
        toyama,
        dayTrip,
      ),
    ).toBe(false);
  });

  it("行き先があれば、了承を得た段階までの都道府県の候補だけを通す", () => {
    const query = { ...dayTrip, prefectures: ["石川県"] as Prefecture[] };
    expect(withinConditions(candidate({}), toyama, query)).toBe(false);
    expect(withinConditions(candidate({}), toyama, { ...query, widen: "neighbor" })).toBe(true);
  });
});

describe("所要時間の書き方", () => {
  it("時間と分で書き、幅があれば「〜」でつなぐ", () => {
    expect(formatMinutes(45)).toBe("45分");
    expect(formatMinutes(180)).toBe("3時間");
    expect(formatMinutes(130)).toBe("2時間10分");
    expect(formatMinuteRange([110, 150])).toBe("1時間50分〜2時間30分");
    expect(formatMinuteRange([60, 60])).toBe("1時間");
  });
});
