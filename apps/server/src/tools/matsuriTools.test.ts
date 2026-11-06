import type { FestivalCandidate, Itinerary, SearchOutcome, SseEvent } from "@matsuri-ikoka/schema";
import { fictionalItinerary } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import type { NearbySearchRound } from "../domain/nearbySearch";
import { createOsmPlaceIndex } from "../domain/osmPlaces";
import { testFestival } from "../domain/testFestivals";
import { createStationPointIndex } from "../domain/travelEstimate";
import { YEAR_NOT_STATED_NOTE } from "../domain/verification";
import { type CandidateCheck, createCandidateChecker } from "./candidateCheck";
import { createUnavailableLodging } from "./lodging";
import type {
  LodgingResearcher,
  LodgingResearchRequest,
  PerspectiveLodgingReport,
} from "./lodgingResearch";
import {
  getAccess,
  getWeather,
  LODGING_NOTICE,
  noteConditions,
  pickVerifiedCandidates,
  RESEARCHED_LODGING_NOTICE,
  researchRoute,
  searchFestivals,
  searchLodging,
  searchNearby,
  updateItinerary,
  verifyFestival,
} from "./matsuriTools";
import type {
  NearbyResearcher,
  NearbyResearchRequest,
  ResearchedSpotReport,
} from "./nearbyResearch";
import { testToolContext } from "./testContext";

const signal = new AbortController().signal;
const suzunari = () => testFestival({ id: "suzunari-toro" });
/** search_festivals の結果の、条件の検査と次の手 */
const searchOf = (output: Record<string, unknown>) => output.search as SearchOutcome;

function draftOf(itinerary: Itinerary) {
  const { id: _id, version: _v, verification: _ver, days, ...rest } = itinerary;
  return {
    ...rest,
    days: days.map(({ weather: _w, items, ...day }) => ({
      ...day,
      items: items.map(({ changedInVersion: _c, ...item }) => item),
    })),
  };
}

describe("note_conditions", () => {
  it("言われた項目だけを書き足し、次に聞くことをコードで決めて返す", async () => {
    const ctx = testToolContext([suzunari()]);
    const first = await noteConditions.run({ origin: "みなと中央駅", nights: 4 }, ctx, signal);
    // 日付がそろうまでは、日付だけを聞く
    expect(first).toMatchObject({ readyToSearch: false, askNext: ["日付（または期間）"] });

    const second = await noteConditions.run(
      {
        when: { kind: "range", from: "2026-08-14", to: "2026-08-18" },
        route: { shape: "stay", areas: [] },
      },
      ctx,
      signal,
    );
    // 探してよければ、それ以上は聞かない（宿やペースは案を見てから変えてもらう）
    expect(second).toMatchObject({ readyToSearch: true, askNext: [] });
    expect(ctx.session.conditions).toMatchObject({ origin: "みなと中央駅", nights: 4 });
  });

  it("日帰りは、日付と出発地がそろえば探し始めてよく、それ以上は聞かない", async () => {
    const ctx = testToolContext([suzunari()]);
    const result = await noteConditions.run(
      { when: { kind: "date", date: "2026-08-16" }, origin: "みなと中央駅", nights: 0 },
      ctx,
      signal,
    );
    expect(result).toMatchObject({ readyToSearch: true, askNext: [] });
  });

  it("祭りを探しても、聞き取りで書き留めた条件は残る", async () => {
    const ctx = testToolContext([suzunari()]);
    await noteConditions.run({ pace: "relaxed", interests: ["onsen"] }, ctx, signal);
    await searchFestivals.run(
      { when: { kind: "date", date: "2026-08-16" }, origin: "みなと中央駅", nights: 3 },
      ctx,
      signal,
    );
    expect(ctx.session.conditions).toMatchObject({
      nights: 3,
      pace: "relaxed",
      interests: ["onsen"],
    });
  });
});

describe("search_nearby を地域で探す", () => {
  it("祭りのない日のために、その地域のほかの祭りの周辺の場所と、その日の祭りを返す", async () => {
    const other = testFestival({ id: "kazami-bon", date: "2026-08-17", start: "19:00" });
    const away = testFestival({
      id: "far-away",
      edit: (f) => {
        f.municipalities = [{ prefecture: "京都府", name: "はるか村" }];
      },
    });
    const ctx = testToolContext([suzunari(), other, away]);

    const result = (await searchNearby.run(
      // 2026-08-17 は月曜（鈴鳴和紙の館は火曜休み）
      { area: "滋賀県", date: "2026-08-17" },
      ctx,
      signal,
    )) as { spots: { festivalId: string }[]; festivalsOnDate: { festivalId: string }[] };

    expect(result.festivalsOnDate.map((f) => f.festivalId)).toEqual(["kazami-bon"]);
    expect(new Set(result.spots.map((s) => s.festivalId))).toEqual(
      new Set(["suzunari-toro", "kazami-bon"]),
    );
    expect(ctx.session.selectedFestivalId).toBeNull();
  });

  it("データにない地域では場所を返さず、自由に過ごす時間にするよう伝える", async () => {
    const ctx = testToolContext([suzunari()]);
    const result = await searchNearby.run({ area: "北海道", date: "2026-08-18" }, ctx, signal);
    expect(result).toMatchObject({ spots: [], festivalsOnDate: [] });
    expect((result.notes as string[]).join("")).toContain("自由に過ごす時間");
  });

  it("祭りの ID も地域もなければ断る", async () => {
    const ctx = testToolContext([suzunari()]);
    await expect(searchNearby.run({ date: "2026-08-18" }, ctx, signal)).rejects.toThrow();
  });
});

describe("search_festivals の、候補を出す前の確かめ", () => {
  it("見込みの祭りも公式の情報で確かめ、結果を候補に付けて festival.verified で送る", async () => {
    const expected = testFestival({ id: "suzunari-toro", status: "expected" });
    const ctx = testToolContext([expected], {
      report: {
        result: "as_planned",
        sources: [{ url: "https://example.com/suzunari/2026" }],
        yearStated: true,
      },
    });
    const events: SseEvent[] = [];
    ctx.emit = (event) => events.push(event);
    ctx.candidateChecks = createCandidateChecker({
      verifier: ctx.verifier,
      today: ctx.today,
      now: ctx.now,
    });

    const result = await searchFestivals.run(
      { when: { kind: "date", date: "2026-08-16" }, origin: "みなと中央駅", nights: 0 },
      ctx,
      signal,
    );

    expect(result.candidates).toEqual([
      expect.objectContaining({
        festivalId: "suzunari-toro",
        confirmed: true,
        check: { result: "as_planned", checkedAt: "2026-08-03T10:15:00+09:00" },
      }),
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        type: "festival.verified",
        data: expect.objectContaining({
          festivalId: "suzunari-toro",
          date: "2026-08-16",
          scope: "candidate",
          result: "as_planned",
        }),
      }),
    ]);
  });

  it("どこからも開催の情報が取れなかった祭りは、候補に出さない", async () => {
    const ctx = testToolContext([testFestival({ id: "suzunari-toro", status: "expected" })]);
    ctx.candidateChecks = createCandidateChecker({
      verifier: ctx.verifier,
      today: ctx.today,
      now: ctx.now,
    });
    const result = await searchFestivals.run(
      { when: { kind: "date", date: "2026-08-16" }, origin: "みなと中央駅", nights: 0 },
      ctx,
      signal,
    );
    expect(result.candidates).toEqual([]);
    expect(result.notes).toContain(
      "開催の情報が見つからなかった・中止と分かった祭りを1件、候補から外しました",
    );
  });

  it("公式以外の情報源で確かめた祭りは、要事前確認として出す", async () => {
    const ctx = testToolContext([testFestival({ id: "suzunari-toro", status: "expected" })], {
      report: {
        result: "as_planned",
        sources: [{ url: "https://example.net/news" }],
        yearStated: true,
      },
    });
    ctx.candidateChecks = createCandidateChecker({
      verifier: ctx.verifier,
      today: ctx.today,
      now: ctx.now,
    });
    const result = await searchFestivals.run(
      { when: { kind: "date", date: "2026-08-16" }, origin: "みなと中央駅", nights: 0 },
      ctx,
      signal,
    );
    expect(result.candidates).toEqual([
      expect.objectContaining({
        confirmed: false,
        check: expect.objectContaining({ result: "needs_check" }),
      }),
    ]);
  });
});

describe("search_festivals の日ごとの開催", () => {
  it("複数の日に開かれる祭りは、探す範囲の中の日ごとの時刻と補足を渡す", async () => {
    const festival = testFestival({
      id: "multi-day",
      date: "2026-08-15",
      edit: (f) => {
        f.occurrences.push(
          {
            date: "2026-08-16",
            start: "12:00",
            end: "22:00",
            status: "announced",
            rainPolicy: null,
            note: "本祭。行列がある",
            sources: [
              {
                url: "https://example.com/multi/16",
                checkedAt: "2026-04-01",
                confidence: "official",
              },
            ],
          },
          {
            date: "2026-10-01",
            start: "10:00",
            end: "12:00",
            status: "announced",
            rainPolicy: null,
            sources: [
              {
                url: "https://example.com/multi/10",
                checkedAt: "2026-04-01",
                confidence: "official",
              },
            ],
          },
        );
      },
    });
    const ctx = testToolContext([festival]);

    const output = await searchFestivals.run(
      {
        when: { kind: "range", from: "2026-08-15", to: "2026-08-16" },
        origin: "みなと中央駅",
        nights: 1,
      },
      ctx,
      signal,
    );

    const [detail] = output.details as { daysInRange: { date: string; note: string | null }[] }[];
    expect(detail?.daysInRange.map((d) => [d.date, d.note])).toEqual([
      ["2026-08-15", null],
      ["2026-08-16", "本祭。行列がある"],
    ]);
  });
});

describe("search_festivals の行き先", () => {
  /** 架空の祭りを、開催地の都道府県を変えて作る */
  const at = (
    id: string,
    prefecture: "富山県" | "岐阜県" | "沖縄県" | "滋賀県",
    date = "2026-08-16",
  ) =>
    testFestival({
      id,
      date,
      edit: (f) => {
        f.municipalities = [{ prefecture, name: "鈴鳴町" }];
      },
    });
  const base = {
    when: { kind: "date", date: "2026-08-16" },
    origin: "みなと中央駅",
    nights: 1,
  } as const;
  const ids = (output: Record<string, unknown>) =>
    (output.candidates as { festivalId: string }[]).map((c) => c.festivalId);

  it("選んだ地域の祭りがあれば、それだけを出す", async () => {
    const ctx = testToolContext([at("shiga", "滋賀県"), at("toyama", "富山県")]);
    const output = await searchFestivals.run({ ...base, destinations: ["北陸"] }, ctx, signal);
    expect(ids(output)).toEqual(["toyama"]);
    expect(output.destination).toMatchObject({ stage: "area", needsConsent: null, reason: null });
    expect(ctx.session.conditions.destinations).toEqual(["北陸"]);
  });

  it("選んだ地域の祭りが希望の日程から外れていれば候補に出さず、ずれを添えて紹介する", async () => {
    const ctx = testToolContext([at("shiga", "滋賀県"), at("toyama", "富山県", "2026-08-20")]);
    const output = await searchFestivals.run({ ...base, destinations: ["北陸"] }, ctx, signal);
    expect(ids(output)).toEqual([]);
    expect(output.destination).toMatchObject({ needsConsent: "neighbor", foundIn: ["滋賀県"] });
    expect(searchOf(output).status).toBe("none");
    expect(searchOf(output).nearMisses.map((n) => [n.candidate.festivalId, n.miss.detail])).toEqual(
      [
        ["toyama", "ご希望の日の4日後（8月20日）に開きます"],
        ["shiga", "行き先（北陸）の外の滋賀県にあります"],
      ],
    );
  });

  it("選んだ地域になければ、候補を出さずに、隣の県を紹介してよいかを聞く", async () => {
    const ctx = testToolContext([at("gifu", "岐阜県"), at("shiga", "滋賀県")]);
    const output = await searchFestivals.run({ ...base, destinations: ["富山県"] }, ctx, signal);
    expect(output.candidates).toEqual([]);
    expect(ctx.session.candidates).toEqual([]);
    expect(output.destination).toMatchObject({
      needsConsent: "neighbor",
      foundIn: ["岐阜県"],
      question:
        "富山県には、この日程で開く祭りが見つかりませんでした。隣の岐阜県なら祭りがあります。こちらを紹介してもよいですか？",
    });
  });

  it("了承を得たら、隣の県の祭りを理由を添えて出す（行き先は書き留めたものを使う）", async () => {
    const ctx = testToolContext([at("gifu", "岐阜県"), at("shiga", "滋賀県")]);
    ctx.session.conditions = { destinations: ["富山県"] };
    const output = await searchFestivals.run({ ...base, widen: "neighbor" }, ctx, signal);
    expect(ids(output)).toEqual(["gifu"]);
    expect(output.destination).toMatchObject({
      stage: "neighbor",
      reason: "富山県にはなかったので、隣の岐阜県の祭りです",
    });
  });

  it("隣の県にもなければ、全国から紹介してよいかを聞き、了承を得たらランダムに選ぶ", async () => {
    const ctx = testToolContext([at("okinawa", "沖縄県"), at("shiga", "滋賀県")]);
    ctx.random = () => 0;
    const asked = await searchFestivals.run(
      { ...base, destinations: ["富山県"], widen: "neighbor" },
      ctx,
      signal,
    );
    expect(asked.destination).toMatchObject({ needsConsent: "nationwide" });
    const output = await searchFestivals.run({ ...base, widen: "nationwide" }, ctx, signal);
    expect(ids(output).sort()).toEqual(["okinawa", "shiga"]);
    expect(output.destination).toMatchObject({ stage: "nationwide" });
  });

  it("都道府県にも地方にも当たらない行き先は、推測せずに失敗で返す", async () => {
    const ctx = testToolContext([at("toyama", "富山県")]);
    await expect(
      searchFestivals.run({ ...base, destinations: ["鈴鳴町"] }, ctx, signal),
    ).rejects.toThrow("都道府県か地方の名前");
    await expect(noteConditions.run({ destinations: ["鈴鳴町"] }, ctx, signal)).rejects.toThrow(
      "都道府県か地方の名前",
    );
  });
});

describe("search_festivals", () => {
  it("候補を最大3件返し、聞き取れた条件とこだわりを相談に残す", async () => {
    const ctx = testToolContext([
      suzunari(),
      testFestival({ id: "kazami", date: "2026-08-15", status: "expected", confidence: "single" }),
      testFestival({ id: "opted", optOut: true }),
    ]);

    const output = await searchFestivals.run(
      {
        when: { kind: "date", date: "2026-08-16" },
        origin: "みなと中央駅",
        nights: 0,
        party: { adults: 2, children: 0 },
        preferences: { party: "adults", spot: "hidden", food: "local", move: "train" },
      },
      ctx,
      signal,
    );

    expect(
      (output.candidates as { festivalId: string; confirmed: boolean }[]).map((c) => [
        c.festivalId,
        c.confirmed,
      ]),
    ).toEqual([["suzunari-toro", true]]);
    // 希望日の前の日に開く祭りは、候補ではなく「この祭りならやっています」として、ずれを添えて返す
    expect(
      searchOf(output).nearMisses.map((n) => [n.candidate.festivalId, n.miss.condition]),
    ).toEqual([["kazami", "date"]]);
    expect(ctx.session.nearMisses.map((c) => c.festivalId)).toEqual(["kazami"]);
    expect(ctx.session.conditions).toEqual({
      when: { kind: "date", date: "2026-08-16" },
      origin: "みなと中央駅",
      nights: 0,
      party: { adults: 2, children: 0 },
    });
    expect(ctx.session.preferences.spot).toBe("hidden");
    expect(ctx.session.candidates).toHaveLength(1);
    expect(ctx.turn.searched).toBe(true);
  });

  it("日帰りの所要時間の上限は、聞き取りで書き留めたものを使い、収まると分かる祭りだけを出す", async () => {
    const ctx = testToolContext([
      testFestival({ id: "near", date: "2026-08-16", fromHubMinutes: [40, 45] }),
      testFestival({ id: "far", date: "2026-08-16", fromHubMinutes: [90, 100] }),
      testFestival({ id: "unknown", date: "2026-08-16", fromHubMinutes: null }),
    ]);
    ctx.session.conditions = { maxTravelMinutes: 60 };

    const output = await searchFestivals.run(
      { when: { kind: "date", date: "2026-08-16" }, origin: "みなと中央駅", nights: 0 },
      ctx,
      signal,
    );

    expect((output.candidates as { festivalId: string }[]).map((c) => c.festivalId)).toEqual([
      "near",
    ]);
    expect((output.candidates as FestivalCandidate[])[0]?.travel).toEqual({
      minutes: [48, 57],
      basis: "data",
      limitMinutes: 60,
      fit: "within",
    });
    expect(output.notes).toContain(
      "条件から外れる祭りを候補から外しました（日程0件・片道の所要時間2件・行き先0件）",
    );
    // 少し遠い祭りは「この祭りならやっています」に、所要時間の分からない祭りは出さない
    expect(searchOf(output).nearMisses.map((n) => [n.candidate.festivalId, n.miss.detail])).toEqual(
      [["far", "片道およそ1時間38分〜1時間52分で、上限の1時間を超えます"]],
    );
    expect(ctx.session.conditions.maxTravelMinutes).toBe(60);
  });

  it("条件に合う祭りがなければ、見つからなかったと返し、数え直して見つかる次の手を出す", async () => {
    const ctx = testToolContext([
      testFestival({ id: "next-week", date: "2026-08-22", fromHubMinutes: [40, 45] }),
      testFestival({ id: "far", date: "2026-08-16", fromHubMinutes: [90, 100] }),
    ]);

    const output = await searchFestivals.run(
      {
        when: { kind: "date", date: "2026-08-16" },
        origin: "みなと中央駅",
        nights: 0,
        maxTravelMinutes: 60,
      },
      ctx,
      signal,
    );

    expect(output.candidates).toEqual([]);
    expect(searchOf(output).status).toBe("none");
    expect(searchOf(output).suggestions.map((s) => [s.kind, s.label, s.found])).toEqual([
      ["later_dates", "次の週末（8月22日〜8月23日）で探す", 1],
      ["longer_travel", "片道2時間まで広げる", 1],
      ["stay_over", "1泊の旅にする", 1],
      ["edit_conditions", "条件を選び直す", null],
    ]);
    expect(
      (output.notes as string[]).some((n) => n.startsWith("条件に合う祭りは見つかりませんでした")),
    ).toBe(true);
  });

  it("次の手（ボタン）から探し直すときは、ボタンの条件を正として探す", async () => {
    const ctx = testToolContext([
      testFestival({ id: "next-week", date: "2026-08-22", fromHubMinutes: [40, 45] }),
    ]);
    ctx.turn.searchRetry = { when: { kind: "range", from: "2026-08-22", to: "2026-08-23" } };

    const output = await searchFestivals.run(
      { when: { kind: "date", date: "2026-08-16" }, origin: "みなと中央駅", nights: 0 },
      ctx,
      signal,
    );

    expect((output.candidates as FestivalCandidate[]).map((c) => c.festivalId)).toEqual([
      "next-week",
    ]);
    expect(ctx.session.conditions.when).toEqual({
      kind: "range",
      from: "2026-08-22",
      to: "2026-08-23",
    });
  });

  it("希望日が過ぎていれば、そのことを返す", async () => {
    const ctx = testToolContext([suzunari()], { today: "2026-09-01" });

    const output = await searchFestivals.run(
      { when: { kind: "date", date: "2026-08-16" }, origin: "みなと中央駅", nights: 1 },
      ctx,
      signal,
    );

    expect(output.candidates).toEqual([]);
    expect(output.notes).toContain("希望の日はすでに過ぎています。別の日を聞いてください");
  });

  it("入力の形が違えば例外にする", async () => {
    const ctx = testToolContext([suzunari()]);

    await expect(
      searchFestivals.run({ when: "8月16日", origin: "", nights: "x" }, ctx, signal),
    ).rejects.toThrow();
  });
});

describe("search_nearby", () => {
  it("休業日の場所を除いて返し、選んだ祭りを相談に残す", async () => {
    const ctx = testToolContext([suzunari()]);

    // 2026-08-18 は火曜。鈴鳴和紙の館は火曜休み
    const output = await searchNearby.run(
      { festivalId: "suzunari-toro", date: "2026-08-18" },
      ctx,
      signal,
    );

    expect(output.spots).toEqual([]);
    expect(output.excluded).toEqual([
      { spotId: "suzunari-craft-hall", name: "鈴鳴和紙の館", reason: "closed_day" },
    ]);
    expect(ctx.session.selectedFestivalId).toBe("suzunari-toro");
  });

  it("聞き取りの食べたいもの・食事で気をつけたいことを、組み方の決まりに入れる", async () => {
    const ctx = testToolContext([suzunari()]);
    ctx.session.conditions = { foodWishes: ["noodles"], dietary: ["allergy"] };

    const output = await searchNearby.run(
      { festivalId: "suzunari-toro", date: "2026-08-16" },
      ctx,
      signal,
    );

    const rules = (output.rules as string[]).join("\n");
    expect(rules).toContain("食べたいもの（麺類）");
    expect(rules).toContain("食事で気をつけたいこと（食物アレルギー）");
  });

  it("データにない祭りは失敗にする", async () => {
    await expect(
      searchNearby.run({ festivalId: "no-such" }, testToolContext([]), signal),
    ).rejects.toThrow("祭りのデータにありません");
  });
});

// 周辺係の Web の調べの代わり。架空の店を返す
function grill(edit: Partial<ResearchedSpotReport> = {}): ResearchedSpotReport {
  return {
    name: "鈴鳴グリル",
    kind: "food",
    summary: "炭火焼きの肉料理の店",
    location: { lat: 35.122, lng: 136.082 },
    foods: ["meat"],
    dietaryOk: [],
    adultsOnly: false,
    pricePerPersonYen: [1500, 3000],
    price: "ランチ 1,500円から",
    hours: { open: "11:00", close: "21:00" },
    closedDays: ["wed"],
    openOnDate: "open",
    sources: [{ url: "https://example.com/grill", title: "鈴鳴グリル" }],
    ...edit,
  };
}

function fakeNearby(
  answer: (round: NearbySearchRound) => Promise<{ spots: ResearchedSpotReport[] } | null>,
): NearbyResearcher & { calls: number; requests: NearbyResearchRequest[] } {
  const fake = {
    calls: 0,
    requests: [] as NearbyResearchRequest[],
    async research(request: NearbyResearchRequest) {
      fake.calls += 1;
      fake.requests.push(request);
      return answer(request.plan.round);
    },
  };
  return fake;
}

describe("search_nearby と OpenStreetMap", () => {
  const osmSoba = {
    type: "node" as const,
    id: 7,
    name: "鈴鳴そば庵",
    location: { lat: 35.1221, lng: 136.0786 },
    tags: { amenity: "restaurant", cuisine: "soba" },
  };

  it("Web の調べが失敗しても、OpenStreetMap の店を、営業は要確認として候補に出す", async () => {
    const nearby = fakeNearby(async () => null);
    const ctx = testToolContext([suzunari()], {
      nearby,
      osmPlaces: createOsmPlaceIndex([osmSoba]),
    });

    const output = await searchNearby.run(
      { festivalId: "suzunari-toro", date: "2026-08-16" },
      ctx,
      signal,
    );

    expect(output.research).toMatchObject({ status: "researched" });
    const spots = output.spots as {
      name: string;
      openStatus?: string;
      sources: { title?: string }[];
    }[];
    const soba = spots.find((s) => s.name === "鈴鳴そば庵");
    expect(soba?.openStatus).toBe("needs_check");
    expect(soba?.sources[0]?.title).toContain("OpenStreetMap");
    const candidates = output.mealCandidates as { lunch: { name: string }[] };
    expect(candidates.lunch.map((c) => c.name)).toContain("鈴鳴そば庵");
  });

  it("同じ店は、営業を確かめた Web の報告を残す", async () => {
    const nearby = fakeNearby(async () => ({
      spots: [grill({ name: "鈴鳴 そば庵", location: { lat: 35.1222, lng: 136.0787 } })],
    }));
    const ctx = testToolContext([suzunari()], {
      nearby,
      osmPlaces: createOsmPlaceIndex([osmSoba]),
    });
    ctx.session.preferences = { ...ctx.session.preferences, food: "local" };

    const output = await searchNearby.run(
      { festivalId: "suzunari-toro", date: "2026-08-16" },
      ctx,
      signal,
    );

    const spots = output.spots as { name: string; openStatus?: string }[];
    const sobas = spots.filter((s) => s.name.includes("そば庵"));
    expect(sobas).toHaveLength(1);
    expect(sobas[0]?.openStatus).toBe("confirmed");
  });

  it("会場の近くに店の少ない地域では、少し遠い店まで候補にする", async () => {
    // 会場から北へ約4.4km
    const far = { ...osmSoba, id: 8, name: "山あいの食堂", location: { lat: 35.16, lng: 136.08 } };
    const ctx = testToolContext([suzunari()], {
      osmPlaces: createOsmPlaceIndex([far]),
      nearby: fakeNearby(async () => null),
    });
    const output = await searchNearby.run(
      { festivalId: "suzunari-toro", date: "2026-08-16" },
      ctx,
      signal,
    );
    const candidates = output.mealCandidates as { lunch: { name: string }[] };
    expect(candidates.lunch.map((c) => c.name)).toEqual(["山あいの食堂"]);
  });

  it("OpenStreetMap の店を、Web の調べに確かめる店として渡す", async () => {
    const nearby = fakeNearby(async () => ({ spots: [] }));
    const ctx = testToolContext([suzunari()], {
      nearby,
      osmPlaces: createOsmPlaceIndex([osmSoba]),
    });
    await searchNearby.run({ festivalId: "suzunari-toro", date: "2026-08-16" }, ctx, signal);
    expect(nearby.requests[0]?.references.map((r) => r.name)).toContain("鈴鳴そば庵");
  });
});

describe("search_lodging と OpenStreetMap", () => {
  it("ほかの調べで宿がなければ、OpenStreetMap の宿を、空きは未確認の注意つきで出す", async () => {
    const ctx = testToolContext([suzunari()], {
      lodging: createUnavailableLodging(),
      osmPlaces: createOsmPlaceIndex([
        {
          type: "way",
          id: 9,
          name: "鈴鳴の宿",
          location: { lat: 35.1221, lng: 136.0786 },
          tags: { tourism: "guest_house", website: "https://example.com/inn" },
        },
      ]),
    });
    const result = await searchLodging.run(
      {
        festivalId: "suzunari-toro",
        checkIn: "2026-08-16",
        nights: 1,
        party: { adults: 2, children: 0 },
      },
      ctx,
      signal,
    );
    expect(result).toMatchObject({ status: "ok", provider: "web" });
    expect(result.notice).toContain("空きは調べていません");
    expect((result.offers as { name: string; nightlyTotalYen: number | null }[])[0]).toMatchObject({
      name: "鈴鳴の宿",
      nightlyTotalYen: null,
    });
  });
});

describe("search_nearby と周辺係の Web の調べ", () => {
  it("屋台で十分のこだわりでも、夜の祭りの日は、昼に入れる店を返す", async () => {
    const nearby = fakeNearby(async () => ({ spots: [grill()] }));
    const ctx = testToolContext([suzunari()], { nearby });
    expect(ctx.session.preferences.food).toBe("stalls");

    const output = await searchNearby.run(
      { festivalId: "suzunari-toro", date: "2026-08-16" },
      ctx,
      signal,
    );

    const candidates = output.mealCandidates as { lunch: { name: string }[] };
    expect(candidates.lunch.map((c) => c.name)).toEqual(["鈴鳴グリル"]);
  });

  it("調べた店を、食べたいものに合う順に返し、相談に残す", async () => {
    const nearby = fakeNearby(async () => ({
      spots: [grill(), grill({ name: "鈴鳴うどん", foods: ["noodles"] })],
    }));
    const ctx = testToolContext([suzunari()], { nearby });
    ctx.session.conditions = { foodWishes: ["meat"] };

    const output = await searchNearby.run(
      { festivalId: "suzunari-toro", date: "2026-08-16" },
      ctx,
      signal,
    );

    expect(output.research).toEqual({ status: "researched", foodFound: true, rounds: 1 });
    const spots = output.spots as { name: string; origin: string; openStatus?: string }[];
    expect(spots.map((s) => [s.name, s.origin])).toEqual([
      ["鈴鳴グリル", "web"],
      ["鈴鳴うどん", "web"],
      ["鈴鳴和紙の館", "data"],
    ]);
    expect(spots[0]?.openStatus).toBe("confirmed");
    expect([...ctx.session.researchedSpots.values()].map((s) => s.name)).toEqual([
      "鈴鳴グリル",
      "鈴鳴うどん",
    ]);
    const candidates = output.mealCandidates as { lunch: { name: string }[] };
    expect(candidates.lunch.map((c) => c.name)).toEqual(["鈴鳴グリル", "鈴鳴うどん"]);
  });

  it("食べたいものに合う店がなければ、見つからなかったと返しつつ、食事に入れられる店は候補に残す", async () => {
    const nearby = fakeNearby(async () => ({
      spots: [grill({ name: "鈴鳴うどん", foods: ["noodles"] })],
    }));
    const ctx = testToolContext([suzunari()], { nearby });
    ctx.session.conditions = { foodWishes: ["meat"] };

    const output = await searchNearby.run(
      { festivalId: "suzunari-toro", date: "2026-08-16" },
      ctx,
      signal,
    );

    expect(output.research).toEqual({ status: "researched", foodFound: false, rounds: 2 });
    // 1回目で見つからなければ、広げた言葉でもう1回調べる
    expect(nearby.requests.map((r) => r.plan.round).at(-1)).toBe("widened");
    // 1回目は、観点ごとの調べ役を並べて動かす
    expect(nearby.requests.flatMap((r) => r.plan.perspective ?? [])).toEqual([
      "wish",
      "lunch",
      "local",
    ]);
    const candidates = output.mealCandidates as { lunch: { name: string }[] };
    expect(candidates.lunch.map((c) => c.name)).toEqual(["鈴鳴うどん"]);
    expect((output.notes as string[]).join("\n")).toContain("見つかりませんでした");
  });

  it("観点の1つが失敗しても、ほかの観点の結果を使い、別のサイトの出典を突き合わせる", async () => {
    let call = 0;
    const nearby = fakeNearby(async () => {
      call += 1;
      if (call === 1) throw new Error("調べられない");
      return {
        spots: [grill({ sources: [{ url: `https://site${call}.example.com/grill` }] })],
      };
    });
    const ctx = testToolContext([suzunari()], { nearby });
    ctx.session.conditions = { foodWishes: ["meat"] };

    const output = await searchNearby.run(
      { festivalId: "suzunari-toro", date: "2026-08-16" },
      ctx,
      signal,
    );

    const spots = output.spots as { name: string; sourceSites?: number }[];
    expect(spots.filter((s) => s.name === "鈴鳴グリル")).toEqual([
      expect.objectContaining({ sourceSites: 2 }),
    ]);
  });

  it("1回目で合う店がなく、広げた2回目で見つかれば、2回の結果をまとめて返す", async () => {
    const nearby = fakeNearby(async (round) => ({
      spots:
        round === "first"
          ? [grill({ name: "鈴鳴うどん", foods: ["noodles"] })]
          : [grill({ name: "鈴鳴うどん", foods: ["noodles"] }), grill({ name: "鈴鳴ステーキ" })],
    }));
    const ctx = testToolContext([suzunari()], { nearby });
    ctx.session.conditions = {
      foodWishes: ["meat"],
      party: { adults: 2, children: 0, infants: 1 },
    };
    let progressed = 0;
    ctx.progress = () => {
      progressed += 1;
    };

    const output = await searchNearby.run(
      { festivalId: "suzunari-toro", date: "2026-08-16", window: { from: "11:30", to: "13:00" } },
      ctx,
      signal,
    );

    expect(output.research).toEqual({ status: "researched", foodFound: true, rounds: 2 });
    expect((output.spots as { name: string }[]).map((s) => s.name)).toContain("鈴鳴ステーキ");
    expect(output.notes as string[]).not.toContainEqual(
      expect.stringContaining("見つかりませんでした"),
    );
    // 調べ方は祭りのデータの駅・市町村と、相談の条件（子ども連れ・時間帯）から組んで、毎回渡す
    const first = nearby.requests[0];
    const widened = nearby.requests.at(-1);
    expect(first?.plan.queries[0]).toBe("鈴鳴駅 焼肉 ランチ");
    expect(first?.plan.queries).toContain("鈴鳴駅 焼肉 子連れ");
    expect(widened?.plan.widening.length).toBeGreaterThan(0);
    // 調べの進みは、相談の進みとして知らせる
    expect(first?.onActivity).toBeDefined();
    first?.onActivity?.();
    expect(progressed).toBe(1);
  });

  it("車で回るときは、会場から遠い店も残す", async () => {
    // 会場から北へ約5.5km
    const far = grill({ name: "郊外の焼肉店", location: { lat: 35.17, lng: 136.08 } });
    const walk = testToolContext([suzunari()], {
      nearby: fakeNearby(async () => ({ spots: [far] })),
    });
    walk.session.conditions = { foodWishes: ["meat"] };
    const byWalk = await searchNearby.run(
      { festivalId: "suzunari-toro", date: "2026-08-16" },
      walk,
      signal,
    );
    expect(byWalk.excluded).toContainEqual({ name: "郊外の焼肉店", reason: "too_far" });

    const nearby = fakeNearby(async () => ({ spots: [far] }));
    const car = testToolContext([suzunari()], { nearby });
    car.session.conditions = { foodWishes: ["meat"], transport: ["car"] };
    const byCar = await searchNearby.run(
      { festivalId: "suzunari-toro", date: "2026-08-16" },
      car,
      signal,
    );
    expect((byCar.spots as { name: string }[]).map((s) => s.name)).toContain("郊外の焼肉店");
    expect(nearby.requests[0]?.plan.queries.some((q) => q.includes("駐車場"))).toBe(true);
  });

  it("調べられなかったときや失敗したときは、祭りのデータの周辺の場所に戻す", async () => {
    for (const nearby of [
      fakeNearby(async () => null),
      fakeNearby(async () => {
        throw new Error("時間切れ");
      }),
    ]) {
      const ctx = testToolContext([suzunari()], { nearby });
      const output = await searchNearby.run(
        { festivalId: "suzunari-toro", date: "2026-08-16" },
        ctx,
        signal,
      );
      expect(output.research).toEqual({ status: "fallback", foodFound: null, rounds: 1 });
      expect((output.spots as { spotId: string }[]).map((s) => s.spotId)).toEqual([
        "suzunari-craft-hall",
      ]);
      // 観点ごとに1回ずつ調べて、やり直さない
      expect(nearby.calls).toBe(2);
    }
  });

  it("調べる手段がない（mock・テスト）ときは、祭りのデータの周辺の場所だけから選ぶ", async () => {
    const output = await searchNearby.run(
      { festivalId: "suzunari-toro", date: "2026-08-16" },
      testToolContext([suzunari()]),
      signal,
    );
    expect(output.research).toEqual({ status: "data_only", foodFound: null, rounds: 0 });
  });

  it("調べた店は、旅程に入れて保存できる。調べていない web- の場所は保存しない", async () => {
    const nearby = fakeNearby(async () => ({ spots: [grill()] }));
    const ctx = testToolContext([suzunari()], { nearby });
    ctx.session.conditions = { foodWishes: ["meat"] };
    const output = await searchNearby.run(
      { festivalId: "suzunari-toro", date: "2026-08-16" },
      ctx,
      signal,
    );
    const spotId = (output.spots as { spotId: string }[])[0]!.spotId;

    const draft = draftOf(fictionalItinerary());
    const lunch = {
      ...draft.days[0]!.items[1]!,
      id: "dinner",
      start: "16:40",
      end: "17:40",
      type: "meal" as const,
      name: "鈴鳴グリル",
      reason: "肉料理が食べたいという希望に合う",
      cost: null,
      spotId,
      sources: [],
    };
    draft.days[0]!.items.splice(2, 0, lunch);
    const saved = await updateItinerary.run({ itinerary: draft }, ctx, signal);
    expect(saved).toMatchObject({ saved: true });
    const item = (saved.itinerary as Itinerary).days[0]!.items.find((i) => i.id === "dinner");
    // 場所・営業時間・出典は、調べた結果で入れ直す
    expect(item).toMatchObject({
      location: { lat: 35.122, lng: 136.082 },
      hours: { open: "11:00", close: "21:00" },
      sources: [{ url: "https://example.com/grill", checkedAt: "2026-08-03" }],
    });

    // 調べていない相談では、場所も出典も入れ直せないので保存しない
    const other = testToolContext([suzunari()]);
    const rejected = await updateItinerary.run({ itinerary: draft }, other, signal);
    expect(rejected).toMatchObject({ saved: false });
  });
});

describe("get_access", () => {
  it("出発地からの目安と、車のときの駐車場の注意を返す", async () => {
    const ctx = testToolContext([suzunari()]);
    ctx.session.conditions = { origin: "みなと中央駅" };

    const output = await getAccess.run({ festivalId: "suzunari-toro", move: "car" }, ctx, signal);

    expect(output).toMatchObject({
      estimate: true,
      parking: "none",
      fromOrigin: {
        hub: "みなと中央駅",
        trainMinutesEstimate: [40, 50],
        doorToVenueMinutesEstimate: [48, 62],
      },
      arrivalBufferMinutes: 15,
    });
    expect(output.notes).toContain(
      "会場の近くに駐車場がありません。電車で行くことをすすめてください",
    );
  });
});

describe("get_access の交通手段", () => {
  it("聞き取りの交通手段を決まりに入れ、レンタカーなら駐車場の注意を出す", async () => {
    const ctx = testToolContext([suzunari()]);
    ctx.session.conditions = { origin: "みなと中央駅", transport: ["plane", "rental_car"] };

    const output = await getAccess.run({ festivalId: "suzunari-toro" }, ctx, signal);

    const rules = (output.rules as string[]).join("\n");
    expect(rules).toContain("想定している交通手段（飛行機・レンタカー）");
    expect(rules).toContain("飛行機の便と時刻はデータにない");
    expect(output.notes).toContain(
      "会場の近くに駐車場がありません。電車で行くことをすすめてください",
    );
  });

  it("交通手段を聞いていなければ、決まりを足さない", async () => {
    const ctx = testToolContext([suzunari()]);

    const output = await getAccess.run({ festivalId: "suzunari-toro" }, ctx, signal);

    expect(output.rules).toEqual([]);
  });
});

describe("get_weather", () => {
  it("開催地の天気を返し、旅程に使うために相談に残す", async () => {
    const ctx = testToolContext([suzunari()]);

    const output = await getWeather.run(
      { festivalId: "suzunari-toro", date: "2026-08-16" },
      ctx,
      signal,
    );

    expect(output.weather).toEqual({ status: "not_yet" });
    expect(ctx.weatherCalls).toEqual(["滋賀県@2026-08-16"]);
    expect(ctx.session.weather.get("suzunari-toro@2026-08-16")).toEqual({ status: "not_yet" });
  });
});

describe("update_itinerary", () => {
  it("初版を保存し、差分と旅程を返す。修正では版を上げる", async () => {
    const ctx = testToolContext([suzunari()]);

    const first = await updateItinerary.run(
      { itinerary: draftOf(fictionalItinerary()) },
      ctx,
      signal,
    );
    expect(first).toMatchObject({
      saved: true,
      version: 1,
      diff: { fromVersion: 0, toVersion: 1 },
    });
    expect(ctx.session.itineraryId).toBe(first.itineraryId);
    expect(ctx.turn.savedItinerary).toBe(true);
    // 天気を調べていなければ、保存のときに調べる
    expect(ctx.weatherCalls).toEqual(["滋賀県@2026-08-16"]);

    const revised = draftOf(first.itinerary as Itinerary);
    revised.days[0]!.items = revised.days[0]!.items.filter((item) => item.id !== "craft-hall");
    const second = await updateItinerary.run({ itinerary: revised }, ctx, signal);
    expect(second).toMatchObject({
      saved: true,
      version: 2,
      diff: { fromVersion: 1, toVersion: 2, removed: [{ id: "craft-hall", name: "鈴鳴和紙の館" }] },
    });
    expect(ctx.itineraries.get(first.itineraryId as string)?.version).toBe(2);
  });

  it("何日かの旅は1日ずつ足して保存し、日ごとに版を上げて天気を調べる", async () => {
    const ctx = testToolContext([suzunari()]);
    await updateItinerary.run({ itinerary: draftOf(fictionalItinerary()) }, ctx, signal);
    const hall = draftOf(fictionalItinerary()).days[0]!.items[1]!;

    const noStay = await updateItinerary.run(
      { addDay: { day: { date: "2026-08-17", stay: null, items: [{ ...hall, id: "d2-hall" }] } } },
      ctx,
      signal,
    );
    expect(noStay).toMatchObject({ saved: false });

    const second = await updateItinerary.run(
      {
        addDay: {
          day: { date: "2026-08-17", stay: null, items: [{ ...hall, id: "d2-hall" }] },
          stayBefore: { area: "鈴鳴の町" },
        },
      },
      ctx,
      signal,
    );
    expect(second).toMatchObject({
      saved: true,
      version: 2,
      diff: { fromVersion: 1, toVersion: 2, added: ["d2-hall"] },
    });
    const saved = second.itinerary as Itinerary;
    expect(saved.days.map((d) => d.stay?.area ?? null)).toEqual(["鈴鳴の町", null]);
    expect(ctx.weatherCalls).toEqual(["滋賀県@2026-08-16", "滋賀県@2026-08-17"]);
  });

  it("旅程がないうちは、1日を足せない", async () => {
    const ctx = testToolContext([suzunari()]);
    const hall = draftOf(fictionalItinerary()).days[0]!.items[1]!;
    await expect(
      updateItinerary.run(
        { addDay: { day: { date: "2026-08-17", stay: null, items: [hall] } } },
        ctx,
        signal,
      ),
    ).rejects.toThrow();
  });

  it("検証で誤りがあれば保存せず、誤りを返す", async () => {
    const ctx = testToolContext([suzunari()]);
    const draft = draftOf(fictionalItinerary());
    const items = draft.days[0]!.items;
    items[1] = { ...items[1]!, start: "16:40", end: "17:30" };

    const output = await updateItinerary.run({ itinerary: draft }, ctx, signal);

    expect(output.saved).toBe(false);
    expect((output.errors as { code: string }[]).map((e) => e.code)).toContain("outside_hours");
    expect(ctx.session.itineraryId).toBeNull();
  });

  it("こだわりは相談の状態を正とする", async () => {
    const ctx = testToolContext([suzunari()]);
    ctx.session.preferences = { party: "kids", spot: "auto", food: "stalls", move: "train" };

    const output = await updateItinerary.run(
      { itinerary: draftOf(fictionalItinerary()) },
      ctx,
      signal,
    );

    expect((output.itinerary as Itinerary).preferences.party).toBe("kids");
  });
});

describe("verify_festival", () => {
  it("候補を出す前に確かめた結果を旅程に引き継ぎ、決定では Web で調べ直さずに確定する", async () => {
    const ctx = testToolContext([testFestival({ id: "suzunari-toro", status: "expected" })], {
      report: {
        result: "as_planned",
        sources: [{ url: "https://example.com/suzunari/2026" }],
        yearStated: true,
      },
    });
    let calls = 0;
    const verifier = ctx.verifier;
    ctx.verifier = {
      verify: (input) => {
        calls += 1;
        return verifier.verify(input);
      },
    };
    ctx.candidateChecks = createCandidateChecker({
      verifier: ctx.verifier,
      today: ctx.today,
      now: ctx.now,
    });
    await searchFestivals.run(
      { when: { kind: "date", date: "2026-08-16" }, origin: "みなと中央駅", nights: 0 },
      ctx,
      signal,
    );
    expect(calls).toBe(1);

    const saved = await updateItinerary.run(
      { itinerary: draftOf(fictionalItinerary()) },
      ctx,
      signal,
    );
    // 決定するまでは確定扱いにしない（しおりは決定のあとに出す）
    expect(saved.itinerary).toMatchObject({ verification: { status: "pending" } });

    const output = await verifyFestival.run({ festivalId: "suzunari-toro" }, ctx, signal);
    expect(output).toMatchObject({ result: "as_planned", reused: true });
    expect(calls).toBe(1);
    expect(ctx.turn.verification).toBe("as_planned");
    expect(ctx.itineraries.get(saved.itineraryId as string)?.verification).toMatchObject({
      status: "as_planned",
      checkedAt: "2026-08-03T10:15:00+09:00",
    });
  });

  it("公式の出典で確かめられたら予定どおりにし、旅程の再確認の結果を書き換える", async () => {
    const ctx = testToolContext([suzunari()], {
      report: {
        result: "as_planned",
        sources: [{ url: "https://example.com/suzunari/2026" }],
        yearStated: true,
      },
    });
    const saved = await updateItinerary.run(
      { itinerary: draftOf(fictionalItinerary()) },
      ctx,
      signal,
    );

    const output = await verifyFestival.run({ festivalId: "suzunari-toro" }, ctx, signal);

    expect(output).toMatchObject({
      result: "as_planned",
      date: "2026-08-16",
      checkedAt: "2026-08-03T10:15:00+09:00",
    });
    expect(ctx.itineraries.get(saved.itineraryId as string)?.verification).toMatchObject({
      status: "as_planned",
      sources: [{ url: "https://example.com/suzunari/2026", confidence: "official" }],
    });
    expect(ctx.turn.verification).toBe("as_planned");
  });

  it("公式で確かめられなければ確定させない", async () => {
    const ctx = testToolContext([suzunari()], {
      report: { result: "as_planned", sources: [{ url: "https://example.net/rumor" }] },
    });

    const output = await verifyFestival.run(
      { festivalId: "suzunari-toro", date: "2026-08-16" },
      ctx,
      signal,
    );

    expect(output.result).toBe("not_found");
  });

  it("公式のページに今年の開催と書かれていなければ要事前確認にし、その理由を返す", async () => {
    const ctx = testToolContext([suzunari()], {
      report: {
        result: "as_planned",
        sources: [{ url: "https://example.com/suzunari/" }],
        yearStated: false,
        note: "例年8月16日に開催",
      },
    });
    const saved = await updateItinerary.run(
      { itinerary: draftOf(fictionalItinerary()) },
      ctx,
      signal,
    );

    const output = await verifyFestival.run({ festivalId: "suzunari-toro" }, ctx, signal);

    expect(output).toMatchObject({ result: "needs_check", note: YEAR_NOT_STATED_NOTE });
    expect(ctx.itineraries.get(saved.itineraryId as string)?.verification).toMatchObject({
      status: "needs_check",
      note: YEAR_NOT_STATED_NOTE,
    });
    expect(ctx.turn.verification).toBe("needs_check");
  });
});

describe("止められた発言と、会話の状態", () => {
  it("旅程の主役の祭りと違う祭りを確かめても、旅程も会話の状態も変えない", async () => {
    const ctx = testToolContext([suzunari(), testFestival({ id: "other", date: "2026-08-16" })], {
      report: { result: "as_planned", sources: [{ url: "https://example.com/other/2026" }] },
    });
    const saved = await updateItinerary.run(
      { itinerary: draftOf(fictionalItinerary()) },
      ctx,
      signal,
    );

    const output = await verifyFestival.run({ festivalId: "other" }, ctx, signal);

    expect(output.appliedToItinerary).toBe(false);
    expect(ctx.turn.verification).toBeNull();
    expect(ctx.itineraries.get(saved.itineraryId as string)?.verification.status).toBe("pending");
  });

  it("確かめている間に発言が止められたら、再確認の結果で旅程を書き換えない", async () => {
    const controller = new AbortController();
    const ctx = testToolContext([suzunari()]);
    const saved = await updateItinerary.run(
      { itinerary: draftOf(fictionalItinerary()) },
      ctx,
      signal,
    );
    ctx.verifier = {
      async verify() {
        controller.abort();
        return { result: "as_planned", sources: [{ url: "https://example.com/suzunari/2026" }] };
      },
    };

    await expect(
      verifyFestival.run({ festivalId: "suzunari-toro" }, ctx, controller.signal),
    ).rejects.toThrow("止められた");
    expect(ctx.itineraries.get(saved.itineraryId as string)?.verification.status).toBe("pending");
    expect(ctx.turn.verification).toBeNull();
  });

  it("止められたあとは、旅程を保存しない", async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = testToolContext([suzunari()]);

    await expect(
      updateItinerary.run({ itinerary: draftOf(fictionalItinerary()) }, ctx, controller.signal),
    ).rejects.toThrow("保存しません");
    expect(ctx.session.itineraryId).toBeNull();
  });
});

describe("search_lodging", () => {
  const args = { festivalId: "suzunari-toro", checkIn: "2026-08-16", nights: 1 };

  it("聞き取った人数と予算で調べ、予算の計算・距離・調べた時刻・注意を添えて返す", async () => {
    const ctx = testToolContext([suzunari()]);
    ctx.session.conditions = {
      party: { adults: 2, children: 0 },
      lodgingBudget: { perPersonYen: 9000, per: "night" },
    };
    const result = await searchLodging.run(args, ctx, signal);
    expect(result).toMatchObject({
      status: "ok",
      provider: "fictional",
      checkIn: "2026-08-16",
      checkOut: "2026-08-17",
      searchedAt: "2026-08-03T10:15:00+09:00",
      notice: LODGING_NOTICE,
    });
    const offers = result.offers as {
      name: string;
      fromVenue: { distanceKm: number; mode: string } | null;
      budget: { overBudget: boolean | null };
    }[];
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.map((o) => o.budget.overBudget)).toContain(true);
    expect(offers.map((o) => o.budget.overBudget)).toContain(false);
    expect(offers.every((o) => typeof o.fromVenue?.distanceKm === "number")).toBe(true);
    expect(ctx.session.lodging.get("2026-08-16")?.offers).toHaveLength(offers.length);
    expect(ctx.session.lodging.get("2026-08-16")?.offers[0]?.fromVenue).toBeDefined();
  });

  const researchedInn = (
    name: string,
    lat: number,
  ): PerspectiveLodgingReport["hotels"][number] => ({
    name,
    summary: "河原まで歩ける宿",
    location: { lat, lng: 136.08 },
    perPersonNightYen: [7000, 9000],
    price: null,
    familyFriendly: null,
    pageUrl: `https://example.com/inn/${encodeURIComponent(name)}`,
    sources: [{ url: `https://example.com/inn/${encodeURIComponent(name)}` }],
  });

  it("Web の宿の調べがあれば、観点ごとに調べた宿を突き合わせて1〜3件を提案し、空きを調べていない注意を添える", async () => {
    const requests: LodgingResearchRequest[] = [];
    const lodgingResearch: LodgingResearcher = {
      async research(request) {
        requests.push(request);
        return {
          reports: [
            { perspective: "venue", hotels: [researchedInn("鈴鳴川の宿", 35.121)] },
            {
              perspective: "station",
              hotels: [researchedInn("鈴鳴駅前ホテル", 35.13), researchedInn("鈴鳴川の宿", 35.121)],
            },
          ],
        };
      },
    };
    const ctx = testToolContext([suzunari()], { lodgingResearch });
    ctx.session.conditions = {
      party: { adults: 2, children: 1 },
      lodgingBudget: { perPersonYen: 10000, per: "night" },
    };
    const result = await searchLodging.run(args, ctx, signal);
    expect(requests[0]?.plans.map((p) => p.perspective)).toEqual([
      "venue",
      "station",
      "budget",
      "family",
    ]);
    expect(requests[0]?.perPersonNightLimitYen).toBe(10000);
    expect(result).toMatchObject({
      status: "ok",
      provider: "web",
      notice: RESEARCHED_LODGING_NOTICE,
      credit: null,
    });
    const offers = result.offers as { name: string; perspectives: string[]; budget: unknown }[];
    expect(offers.map((o) => o.name)).toEqual(["鈴鳴川の宿", "鈴鳴駅前ホテル"]);
    expect(offers[0]?.perspectives).toEqual(["venue", "station"]);
    // 空きを調べていないので、1泊の合計からの予算の計算はしない
    expect(offers[0]?.budget).toBeNull();
    expect(ctx.session.lodging.get("2026-08-16")?.provider).toBe("web");
  });

  it("Web の宿の調べで合う宿がなければ、宿の空きの調べ方の結果に戻る", async () => {
    const lodgingResearch: LodgingResearcher = { research: async () => null };
    const ctx = testToolContext([suzunari()], {
      lodgingResearch,
      lodging: createUnavailableLodging(),
    });
    const result = await searchLodging.run(
      { ...args, party: { adults: 2, children: 0 } },
      ctx,
      signal,
    );
    expect(result).toMatchObject({ status: "unavailable" });
  });

  it("人数を聞いていなくても止まらず、大人2人として調べて、そう返す", async () => {
    const ctx = testToolContext([suzunari()]);
    const result = await searchLodging.run(args, ctx, signal);
    expect(result).toMatchObject({
      status: "ok",
      party: { adults: 2, children: 0 },
      partyAssumed: true,
    });
  });

  it("調べられないときは宿の名前を返さず、相談にも残さない", async () => {
    const ctx = testToolContext([suzunari()], { lodging: createUnavailableLodging() });
    const result = await searchLodging.run(
      { ...args, party: { adults: 2, children: 0 } },
      ctx,
      signal,
    );
    expect(result).toMatchObject({ status: "unavailable" });
    expect(result).not.toHaveProperty("offers");
    expect(ctx.session.lodging.size).toBe(0);
  });

  it("旅程を保存すると、チェックインの日の泊まりに調べた宿の候補が付く", async () => {
    const ctx = testToolContext([suzunari()]);
    await updateItinerary.run({ itinerary: draftOf(fictionalItinerary()) }, ctx, signal);
    await searchLodging.run({ ...args, party: { adults: 2, children: 0 } }, ctx, signal);
    const hall = draftOf(fictionalItinerary()).days[0]!.items[1]!;
    const saved = await updateItinerary.run(
      {
        addDay: {
          day: { date: "2026-08-17", stay: null, items: [{ ...hall, id: "d2-hall" }] },
          stayBefore: { area: "鈴鳴の町" },
        },
      },
      ctx,
      signal,
    );
    const stay = (saved.itinerary as Itinerary).days[0]!.stay;
    expect(stay?.area).toBe("鈴鳴の町");
    expect(stay?.lodging?.offers[0]?.name).toMatch(/^（架空）/);
  });
});

describe("候補を確かめてから選ぶ（pickVerifiedCandidates）", () => {
  const check = (festivalId: string, result: CandidateCheck["result"]): CandidateCheck => ({
    festivalId,
    date: "2026-08-16",
    result,
    sources: [],
    checkedAt: "2026-08-03T10:15:00+09:00",
    cached: false,
  });

  it("中止と情報の取れない祭りは出さず、公式で確かめた祭り、要事前確認、変更の順にする", () => {
    const items = [
      { match: { id: "a", confirmed: true }, check: check("a", "not_found") },
      { match: { id: "b", confirmed: false }, check: check("b", "cancelled") },
      { match: { id: "e", confirmed: true }, check: check("e", "changed") },
      { match: { id: "f", confirmed: false }, check: check("f", "needs_check") },
      { match: { id: "c", confirmed: false }, check: check("c", "as_planned") },
      { match: { id: "d", confirmed: true }, check: null },
    ];
    expect(pickVerifiedCandidates(items, 3).map((p) => p.match.id)).toEqual(["c", "d", "f"]);
  });

  it("確かめる手段があるとき、確かめられず（上限など）データでも確認済みでない祭りは出さない", () => {
    const items = [
      { match: { id: "a", confirmed: false }, check: null },
      { match: { id: "b", confirmed: true }, check: null },
    ];
    expect(pickVerifiedCandidates(items, 3, { requireInfo: true }).map((p) => p.match.id)).toEqual([
      "b",
    ]);
    expect(pickVerifiedCandidates(items, 3).map((p) => p.match.id)).toEqual(["b", "a"]);
  });
});

describe("search_festivals と駅の位置", () => {
  // 架空の駅。会場（鈴鳴川の河原）の近くの駅と、主要駅でない出発の駅
  const stations = createStationPointIndex([
    ["鈴鳴", 35.121, 136.081],
    ["こがね台", 34.9, 135.6],
  ]);

  it("出発の駅が主要駅でなくても、駅の位置から所要時間を見積もって返す", async () => {
    const ctx = testToolContext([suzunari()], { stations });
    const output = await searchFestivals.run(
      { when: { kind: "date", date: "2026-08-16" }, origin: "こがね台", nights: 0 },
      ctx,
      signal,
    );
    const detail = (output.details as Record<string, unknown>[])[0];
    expect(detail).toMatchObject({ festivalId: "suzunari-toro", travelBasis: "estimate" });
    expect(detail?.travelMinutesEstimate).not.toBeNull();
  });
});

describe("research_route", () => {
  const stations = createStationPointIndex([
    ["鈴鳴", 35.121, 136.081],
    ["こがね台", 34.9, 135.6],
  ]);
  const withOrigin = (ctx: ReturnType<typeof testToolContext>) => {
    ctx.session.conditions = { ...ctx.session.conditions, origin: "こがね台" };
    return ctx;
  };
  const route = (minutes: [number, number], sources = [{ url: "https://example.com/route" }]) => ({
    async research() {
      return { minutes, summary: "鈴鳴線で乗り換えなし", transfers: 0, sources };
    },
  });

  it("調べる手段がなければ、駅の位置からの見積もりと、出発の駅から始める決まりを返す", async () => {
    const ctx = withOrigin(testToolContext([suzunari()], { stations }));
    const output = await researchRoute.run({ festivalId: "suzunari-toro" }, ctx, signal);
    expect(output).toMatchObject({
      status: "estimate_only",
      origin: "こがね台",
      destinationStation: "鈴鳴駅",
      estimate: { basis: "estimate" },
      researched: null,
    });
    expect((output.rules as string[])[0]).toContain("こがね台");
  });

  it("調べた所要時間が見積もりと合えば使う", async () => {
    const ctx = withOrigin(testToolContext([suzunari()], { stations, routes: route([60, 80]) }));
    const output = await researchRoute.run({ festivalId: "suzunari-toro" }, ctx, signal);
    expect(output).toMatchObject({
      status: "researched",
      researched: { minutes: [60, 80], summary: "鈴鳴線で乗り換えなし" },
    });
  });

  it("見積もりより明らかに短い所要時間は、区間の取り違えとみなして使わない", async () => {
    const ctx = withOrigin(testToolContext([suzunari()], { stations, routes: route([5, 8]) }));
    const output = await researchRoute.run({ festivalId: "suzunari-toro" }, ctx, signal);
    expect(output).toMatchObject({ status: "rejected", researched: null });
  });

  it("出発の駅が分からなければ失敗にする", async () => {
    const ctx = testToolContext([suzunari()], { stations });
    await expect(researchRoute.run({ festivalId: "suzunari-toro" }, ctx, signal)).rejects.toThrow(
      "出発の駅",
    );
  });
});

describe("update_itinerary と出発の駅", () => {
  it("旅程は相談の出発の駅から始め、別の駅から始まる旅程は保存しない", async () => {
    const ctx = testToolContext([suzunari()]);
    ctx.session.conditions = { ...ctx.session.conditions, origin: "こがね台" };
    const output = await updateItinerary.run(
      { itinerary: draftOf(fictionalItinerary()) },
      ctx,
      signal,
    );
    expect(output).toMatchObject({ saved: false, errors: [{ code: "start_not_origin" }] });
  });

  it("出発の駅からの移動で始まれば保存し、旅程の出発地は相談の出発の駅にそろえる", async () => {
    const ctx = testToolContext([suzunari()]);
    ctx.session.conditions = { ...ctx.session.conditions, origin: "みなと中央" };
    const draft = draftOf(fictionalItinerary());
    draft.origin = "どこか";
    const output = await updateItinerary.run({ itinerary: draft }, ctx, signal);
    expect(output).toMatchObject({ saved: true });
    expect((output.itinerary as Itinerary).origin).toBe("みなと中央");
  });
});

describe("update_itinerary と日帰りの片道の上限", () => {
  const dayTrip = (maxTravelMinutes: number) => {
    const ctx = testToolContext([suzunari()]);
    ctx.session.conditions = {
      ...ctx.session.conditions,
      origin: "みなと中央",
      nights: 0,
      maxTravelMinutes,
    };
    return ctx;
  };

  it("行きの移動が上限に収まれば保存する", async () => {
    const output = await updateItinerary.run(
      { itinerary: draftOf(fictionalItinerary()) },
      dayTrip(60),
      signal,
    );
    expect(output).toMatchObject({ saved: true });
  });

  it("行きの移動の下限でも上限を超える旅程は保存しない", async () => {
    const output = await updateItinerary.run(
      { itinerary: draftOf(fictionalItinerary()) },
      dayTrip(30),
      signal,
    );
    expect(output).toMatchObject({ saved: false, errors: [{ code: "over_travel_limit" }] });
  });

  it("泊まりの旅では上限で断らない", async () => {
    const ctx = dayTrip(30);
    ctx.session.conditions = { ...ctx.session.conditions, nights: 1 };
    const output = await updateItinerary.run(
      { itinerary: draftOf(fictionalItinerary()) },
      ctx,
      signal,
    );
    expect(output).not.toMatchObject({ errors: [{ code: "over_travel_limit" }] });
  });
});

describe("verify_festival が失敗したとき", () => {
  it("Web の確かめが失敗しても、祭りのデータの公式の出典で確かめてあれば予定どおりにする", async () => {
    const recent = testFestival({
      id: "suzunari-toro",
      edit: (f) => {
        for (const o of f.occurrences) {
          o.sources = [{ ...o.sources[0]!, checkedAt: "2026-07-30", confidence: "official" }];
        }
      },
    });
    const ctx = testToolContext([recent], { verifyError: new Error("timeout") });
    await updateItinerary.run({ itinerary: draftOf(fictionalItinerary()) }, ctx, signal);
    const output = await verifyFestival.run({ festivalId: "suzunari-toro" }, ctx, signal);
    expect(output).toMatchObject({ result: "as_planned", appliedToItinerary: true });
    expect(ctx.turn.verification).toBe("as_planned");
  });
});
