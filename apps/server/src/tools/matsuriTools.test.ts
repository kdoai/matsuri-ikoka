import type { Itinerary, SseEvent } from "@matsuri-ikoka/schema";
import { fictionalItinerary } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { testFestival } from "../domain/testFestivals";
import { YEAR_NOT_STATED_NOTE } from "../domain/verification";
import { createCandidateChecker } from "./candidateCheck";
import { createUnavailableLodging } from "./lodging";
import {
  getAccess,
  getWeather,
  LODGING_NOTICE,
  noteConditions,
  searchFestivals,
  searchLodging,
  searchNearby,
  updateItinerary,
  verifyFestival,
} from "./matsuriTools";
import { testToolContext } from "./testContext";

const signal = new AbortController().signal;
const suzunari = () => testFestival({ id: "suzunari-toro" });

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
    // 4泊の旅なので、探しながら、組む前に要ることを2つずつ聞く
    expect(second).toMatchObject({ readyToSearch: true });
    expect((second.askNext as string[]).length).toBe(2);
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

  it("確かめられなかった見込みの祭りは、未確認のまま結果を付ける", async () => {
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
    expect(result.candidates).toEqual([
      expect.objectContaining({
        confirmed: false,
        check: expect.objectContaining({ result: "not_found" }),
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
    ).toEqual([
      ["suzunari-toro", true],
      ["kazami", false],
    ]);
    expect(ctx.session.conditions).toEqual({
      when: { kind: "date", date: "2026-08-16" },
      origin: "みなと中央駅",
      nights: 0,
      party: { adults: 2, children: 0 },
    });
    expect(ctx.session.preferences.spot).toBe("hidden");
    expect(ctx.session.candidates).toHaveLength(2);
    expect(ctx.turn.searched).toBe(true);
  });

  it("日帰りの所要時間の上限は、聞き取りで書き留めたものを使い、分からない祭りを知らせる", async () => {
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
      "unknown",
    ]);
    expect(output.notes).toContain("日帰りの移動の上限を超える祭りを1件除きました");
    expect(output.notes).toContain(
      "出発地からの所要時間がデータにない祭りが1件あります。上限に収まるかは分からないと伝えてください",
    );
    expect(ctx.session.conditions.maxTravelMinutes).toBe(60);
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

  it("公式のページに今年の開催と書かれていなければ確定させず、その理由を返す", async () => {
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

    expect(output).toMatchObject({ result: "not_found", note: YEAR_NOT_STATED_NOTE });
    expect(ctx.itineraries.get(saved.itineraryId as string)?.verification).toMatchObject({
      status: "not_found",
      note: YEAR_NOT_STATED_NOTE,
    });
    expect(ctx.turn.verification).toBe("not_found");
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
      distanceKmFromVenue: number | null;
      budget: { overBudget: boolean | null };
    }[];
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.map((o) => o.budget.overBudget)).toContain(true);
    expect(offers.map((o) => o.budget.overBudget)).toContain(false);
    expect(offers.every((o) => typeof o.distanceKmFromVenue === "number")).toBe(true);
    expect(ctx.session.lodging.get("2026-08-16")?.offers).toHaveLength(offers.length);
  });

  it("人数が分からなければ調べない", async () => {
    const ctx = testToolContext([suzunari()]);
    await expect(searchLodging.run(args, ctx, signal)).rejects.toThrow("人数");
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
