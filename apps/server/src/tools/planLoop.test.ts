import type { Itinerary, SseEvent } from "@matsuri-ikoka/schema";
import { fictionalPlannedItinerary } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { researchedSpotId } from "../domain/nearbyResearch";
import { testFestival } from "../domain/testFestivals";
import { createStationPointIndex } from "../domain/travelEstimate";
import { prefetchBriefing, researchTrip, searchNearby, updateItinerary } from "./matsuriTools";
import type {
  NearbyResearcher,
  NearbyResearchRequest,
  ResearchedSpotReport,
} from "./nearbyResearch";
import type { ModelScore, PlanEvaluationRequest, PlanEvaluator } from "./planEvaluator";
import { redoSubjects } from "./planReview";
import type { RouteResearcher } from "./routeResearch";
import { testToolContext } from "./testContext";

// 旅程を評価して、点が届くまで調べ直して作り直すループ。係（周辺・経路・評価）はすべて偽物。
// 祭り・店・駅・URL はすべて架空

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

/** 朝に出る日帰りの旅程。滞在が昼にかかるのに、昼の食事の案がない */
function morningPlan(): Itinerary {
  const itinerary = fictionalPlannedItinerary();
  const go = itinerary.days[0]!.items[0]!;
  go.start = "09:30";
  go.end = "10:20";
  // 行き方の出典は、祭りのデータのアクセス案内
  go.sources = suzunari().access.sources;
  itinerary.days[0]!.items.at(-1)!.sources = suzunari().access.sources;
  itinerary.days[0]!.lastReturn!.sources = suzunari().access.sources;
  return itinerary;
}

const soba: ResearchedSpotReport = {
  name: "鈴鳴そば庵",
  kind: "food",
  summary: "町の名物のそばの店",
  location: { lat: 35.1221, lng: 136.0786 },
  foods: ["noodles"],
  dietaryOk: [],
  adultsOnly: false,
  pricePerPersonYen: [900, 1500],
  price: "そば 900円から",
  hours: { open: "11:00", close: "15:00" },
  closedDays: ["tue"],
  openOnDate: "open",
  sources: [{ url: "https://example.com/soba-an", title: "鈴鳴そば庵" }],
};

function fakeNearby(): NearbyResearcher & { requests: NearbyResearchRequest[] } {
  const fake = {
    requests: [] as NearbyResearchRequest[],
    async research(request: NearbyResearchRequest) {
      fake.requests.push(request);
      return { spots: [soba] };
    },
  };
  return fake;
}

function fakeEvaluator(
  answer: (request: PlanEvaluationRequest) => Promise<ModelScore[] | null>,
): PlanEvaluator & { requests: PlanEvaluationRequest[] } {
  const fake = {
    requests: [] as PlanEvaluationRequest[],
    async evaluate(request: PlanEvaluationRequest) {
      fake.requests.push(request);
      return answer(request);
    },
  };
  return fake;
}

const allFours = async (): Promise<ModelScore[]> =>
  (["coverage", "specificity", "feasibility", "grounding"] as const).map((criterion) => ({
    criterion,
    rating: 4,
    findings: [],
    targets: [],
  }));

describe("評価して、点が届くまで調べ直して作り直す", () => {
  it("昼の食事が足りなければ保存せず、調べた店を昼に入れて作り直すと基準に届く", async () => {
    const nearby = fakeNearby();
    const evaluator = fakeEvaluator(allFours);
    const ctx = testToolContext([suzunari()], { nearby, planEvaluator: evaluator });
    // 地元の店も楽しむ
    ctx.session.preferences = { ...ctx.session.preferences, food: "local" };
    const events: SseEvent[] = [];
    ctx.emit = (event) => events.push(event);
    const redo = () =>
      events.flatMap((e) =>
        e.type === "staff.redo" ? [[e.data.kind, e.data.from, e.data.to, e.data.subject]] : [],
      );

    // 1回目：昼の食事がないので保存せず、評価もしない
    const first = await updateItinerary.run({ itinerary: draftOf(morningPlan()) }, ctx, signal);
    expect(first).toMatchObject({ saved: false });
    expect((first.errors as { code: string }[]).map((e) => e.code)).toEqual(["meal_missing"]);
    expect(evaluator.requests).toEqual([]);
    expect(ctx.session.itineraryId ?? null).toBeNull();

    // 調べる：周辺係に、昼の時間帯で探してもらう
    const ask = "昼の食事の店を探す";
    const research = await researchTrip.run(
      { festivalId: "suzunari-toro", only: ["nearby"], focus: ask, meals: ["lunch"] },
      ctx,
      signal,
    );
    expect(research.failed).toEqual([]);
    expect(research.route).toBeNull();
    expect(nearby.requests[0]?.plan.checkpoints[0]).toBe(`調べ直し：${ask}`);
    expect(nearby.requests[0]?.plan.queries.join(" ")).toContain("ランチ");
    expect(redo()).toEqual([["accept", "scout", "planner", "lunch"]]);
    expect(
      (research.nearby as { mealCandidates: { lunch: { name: string }[] } }).mealCandidates.lunch[0]
        ?.name,
    ).toBe(soba.name);

    // 作り直し：調べた店を昼に入れる
    const revised = draftOf(morningPlan());
    const spotId = researchedSpotId(soba.name, soba.location);
    revised.days[0]!.items.splice(1, 0, {
      id: "lunch",
      start: "11:30",
      end: "12:30",
      type: "meal",
      name: soba.name,
      location: null,
      reason: "町の名物のそばをお昼に",
      move: { means: "walk", minutes: [5, 8], estimate: true, from: "鈴鳴駅", to: soba.name },
      hours: null,
      cost: "そば 900円から",
      spotId,
      sources: [],
    });
    const second = await updateItinerary.run({ itinerary: revised }, ctx, signal);
    expect(second).toMatchObject({ saved: true, version: 1, gaps: [] });
    expect(second.evaluation).toMatchObject({ round: 1, passed: true, redo: [] });
    expect(second.next).toContain("基準に届きました");
    // 調べた店は採った場所として残り、出典は読んだページになる
    const saved = second.itinerary as Itinerary;
    expect(saved.considered).toContainEqual(
      expect.objectContaining({ id: spotId, adopted: true, from: "nearby" }),
    );
    expect(saved.days[0]?.items[1]?.sources[0]?.url).toBe("https://example.com/soba-an");
    expect(ctx.turn.lastEvaluation?.passed).toBe(true);
  });

  it("調べた店を使わないときは、理由がなければ不足になり、理由を書けば採らなかった場所として残る", async () => {
    const ctx = testToolContext([suzunari()], { nearby: fakeNearby() });
    ctx.session.preferences = { ...ctx.session.preferences, food: "local" };
    await researchTrip.run({ festivalId: "suzunari-toro", only: ["nearby"] }, ctx, signal);
    const spotId = researchedSpotId(soba.name, soba.location);

    const draft = draftOf(fictionalPlannedItinerary());
    const withoutReason = await updateItinerary.run({ itinerary: draft }, ctx, signal);
    expect((withoutReason.gaps as { code: string }[]).map((g) => g.code)).toContain(
      "research_unreviewed",
    );

    const withReason = await updateItinerary.run(
      {
        itinerary: {
          ...draft,
          considered: [
            { id: "suzunari-craft-hall", reason: "灯籠の和紙が分かる" },
            { id: spotId, reason: "15時に閉まり、夕方の祭りの前に寄れない" },
          ],
        },
      },
      ctx,
      signal,
    );
    expect(withReason.gaps).toEqual([]);
    expect((withReason.itinerary as Itinerary).considered).toContainEqual({
      id: spotId,
      name: soba.name,
      from: "nearby",
      adopted: false,
      reason: "15時に閉まり、夕方の祭りの前に寄れない",
    });
  });

  it("評価の回数が上限に届いたら、作り直しを頼まず、足りない点をそのまま報告させる", async () => {
    const ctx = testToolContext([suzunari()]);
    ctx.turn.planRounds = 2;
    // 乗り換えが分からない旅程（具体さが基準に届かない）
    const plan = fictionalPlannedItinerary();
    delete plan.days[0]!.items[0]!.move!.legs;
    const output = await updateItinerary.run({ itinerary: draftOf(plan) }, ctx, signal);
    expect(output.evaluation).toMatchObject({ round: 3, maxRounds: 3, passed: false });
    expect(output.next).toContain("評価は3回まで");
    expect(output.next).not.toContain("research_trip");
  });

  it("評価係が動かないときや失敗したときは、点検の点だけで決める", async () => {
    const noEvaluator = testToolContext([suzunari()]);
    const plain = await updateItinerary.run(
      { itinerary: draftOf(fictionalPlannedItinerary()) },
      noEvaluator,
      signal,
    );
    expect(plain.evaluation).toMatchObject({ judgedBy: "code", passed: true });

    const failing = fakeEvaluator(async () => {
      throw Object.assign(new Error("unauthorized"), { status: 401 });
    });
    const ctx = testToolContext([suzunari()], { planEvaluator: failing });
    const output = await updateItinerary.run(
      { itinerary: draftOf(fictionalPlannedItinerary()) },
      ctx,
      signal,
    );
    expect(output).toMatchObject({ saved: true, evaluation: { judgedBy: "code", passed: true } });
    // やり直しても直らない失敗（認証）は、やり直さない
    expect(failing.requests).toHaveLength(1);
  });

  it("評価係の点が低ければ、点検で足りていても作り直しを頼む", async () => {
    const evaluator = fakeEvaluator(async () => [
      {
        criterion: "specificity",
        rating: 2,
        findings: ["帰りの乗り換えの駅で待つ時間が分からない"],
        targets: ["route"],
      },
    ]);
    const ctx = testToolContext([suzunari()], { planEvaluator: evaluator });
    const output = await updateItinerary.run(
      { itinerary: draftOf(fictionalPlannedItinerary()) },
      ctx,
      signal,
    );
    expect(output.evaluation).toMatchObject({
      passed: false,
      redo: [{ target: "route", criterion: "specificity" }],
    });
  });

  it("今の旅程を写して評価や不足を付けたまま渡されても、サーバーが付け直す", async () => {
    const ctx = testToolContext([suzunari()]);
    const first = await updateItinerary.run(
      { itinerary: draftOf(fictionalPlannedItinerary()) },
      ctx,
      signal,
    );
    const copied = { ...draftOf(first.itinerary as Itinerary) };
    expect(copied).toHaveProperty("evaluation");
    const again = await updateItinerary.run({ itinerary: copied }, ctx, signal);
    expect(again).toMatchObject({ unchanged: true });
  });
});

describe("research_trip：経路と食事・寄り道を並べて調べる", () => {
  const stations = createStationPointIndex([
    ["鈴鳴", 35.121, 136.081],
    ["こがね台", 34.9, 135.6],
  ]);

  function fakeRoutes(failFirst: boolean): RouteResearcher & { calls: string[] } {
    let failed = !failFirst;
    const fake = {
      calls: [] as string[],
      async research(input: Parameters<RouteResearcher["research"]>[0]) {
        fake.calls.push(`${input.direction}:${input.from}→${input.to}`);
        if (!failed) {
          failed = true;
          throw Object.assign(new Error("overloaded"), { status: 529 });
        }
        const outbound = input.direction !== "return";
        return {
          minutes: [60, 80] as [number, number],
          summary: outbound
            ? "こがね線で川辺へ、鈴鳴線に乗り換えて鈴鳴"
            : "鈴鳴線で川辺へ、こがね線に乗り換えてこがね台",
          transfers: 1,
          legs: outbound
            ? [
                {
                  from: "こがね台",
                  to: "川辺",
                  line: "こがね線",
                  minutes: [30, 40] as [number, number],
                },
                {
                  from: "川辺",
                  to: "鈴鳴駅",
                  line: "鈴鳴線",
                  minutes: [25, 35] as [number, number],
                },
              ]
            : [
                {
                  from: "鈴鳴駅",
                  to: "川辺",
                  line: "鈴鳴線",
                  minutes: [25, 35] as [number, number],
                },
                {
                  from: "川辺",
                  to: "こがね台",
                  line: "こがね線",
                  minutes: [30, 40] as [number, number],
                },
              ],
          ...(outbound ? {} : { lastDeparture: "22:40" }),
          sources: [
            { url: `https://example.com/route/${outbound ? "go" : "back"}`, title: "乗り換え案内" },
          ],
        };
      },
    };
    return fake;
  }

  it("周辺を調べ始めると経路も並べて始め、旅程係に結果を渡し、同じ経路を2回調べない", async () => {
    const routes = fakeRoutes(false);
    const ctx = testToolContext([suzunari()], { stations, routes, nearby: fakeNearby() });
    ctx.session.conditions = { origin: "こがね台駅" };

    await searchNearby.run({ festivalId: "suzunari-toro", date: "2026-08-16" }, ctx, signal);
    expect(ctx.turn.prefetch).not.toBeNull();

    const briefing = await prefetchBriefing(ctx);
    expect(briefing).toContain("先にサーバーが調べた結果");
    expect(briefing).toContain("行きの経路");
    expect(briefing).toContain("帰りの経路");
    expect(briefing).not.toContain("祭りの夜の宿");

    await researchTrip.run(
      { festivalId: "suzunari-toro", date: "2026-08-16", only: ["route"] },
      ctx,
      signal,
    );
    expect(routes.calls).toHaveLength(2);
  });

  it("泊まりなら祭りの夜の宿も先に調べ、候補を相談に残す", async () => {
    const routes = fakeRoutes(false);
    const ctx = testToolContext([suzunari()], { stations, routes, nearby: fakeNearby() });
    ctx.session.conditions = { origin: "こがね台駅", nights: 1 };

    await searchNearby.run({ festivalId: "suzunari-toro", date: "2026-08-16" }, ctx, signal);
    const briefing = await prefetchBriefing(ctx);

    expect(briefing).toContain("祭りの夜の宿");
    expect(ctx.session.lodging.has("2026-08-16")).toBe(true);
  });

  it("調べが待ち切れなければ、まだ調べていると伝えて先へ進む", async () => {
    const routes = fakeRoutes(false);
    routes.research = () => new Promise(() => {});
    const ctx = testToolContext([suzunari()], { stations, routes, nearby: fakeNearby() });
    ctx.session.conditions = { origin: "こがね台駅" };
    await searchNearby.run({ festivalId: "suzunari-toro", date: "2026-08-16" }, ctx, signal);

    expect(await prefetchBriefing(ctx, 1)).toContain("まだ調べています");
  });

  it("旅程があるとき（修正）や、調べ直しのときは、先の調べを始めない", async () => {
    const routes = fakeRoutes(false);
    const editing = testToolContext([suzunari()], { stations, routes, nearby: fakeNearby() });
    editing.session.conditions = { origin: "こがね台駅" };
    editing.session.itineraryId = "trip-1";
    await searchNearby.run({ festivalId: "suzunari-toro", date: "2026-08-16" }, editing, signal);
    expect(editing.turn.prefetch).toBeNull();

    const redo = testToolContext([suzunari()], { stations, routes, nearby: fakeNearby() });
    redo.session.conditions = { origin: "こがね台駅" };
    await searchNearby.run(
      { festivalId: "suzunari-toro", date: "2026-08-16", focus: "昼の店" },
      redo,
      signal,
    );
    expect(redo.turn.prefetch).toBeNull();
  });

  it("行き・帰り・食事を並べて調べ、乗り換えの区間と帰りの最終を返し、読んだページを出典に残す", async () => {
    const routes = fakeRoutes(false);
    const nearby = fakeNearby();
    const ctx = testToolContext([suzunari()], { stations, routes, nearby });
    ctx.session.conditions = { ...ctx.session.conditions, origin: "こがね台" };

    const output = await researchTrip.run({ festivalId: "suzunari-toro" }, ctx, signal);

    expect(routes.calls.sort()).toEqual(["outbound:こがね台→鈴鳴駅", "return:鈴鳴駅→こがね台"]);
    expect(nearby.requests.map((r) => r.plan.perspective)).toEqual(["lunch", "local"]);
    expect(output.failed).toEqual([]);
    const route = output.route as {
      outbound: { status: string; researched: { legs: unknown[] } };
      return: {
        status: string;
        researched: { lastDeparture: string; sources: { confidence: string }[] };
      };
    };
    expect(route.outbound.status).toBe("researched");
    expect(route.outbound.researched.legs).toHaveLength(2);
    expect(route.return.researched.lastDeparture).toBe("22:40");
    expect(route.return.researched.sources[0]?.confidence).toBe("single");
    expect([...ctx.session.researchedSources.keys()].sort()).toEqual([
      "https://example.com/route/back",
      "https://example.com/route/go",
    ]);
    expect((output.nearby as { spots: unknown[] }).spots.length).toBeGreaterThan(0);
  });

  it("経路の係が一時的に失敗したら、1回だけ自動でやり直す", async () => {
    const routes = fakeRoutes(true);
    const ctx = testToolContext([suzunari()], { stations, routes });
    ctx.session.conditions = { ...ctx.session.conditions, origin: "こがね台" };

    const output = await researchTrip.run(
      { festivalId: "suzunari-toro", only: ["route"] },
      ctx,
      signal,
    );

    // 最初の1本が失敗し、やり直して2本とも調べられた
    expect(routes.calls).toHaveLength(3);
    const route = output.route as { outbound: { status: string }; return: { status: string } };
    expect([route.outbound.status, route.return.status]).toEqual(["researched", "researched"]);
    expect(output.nearby).toBeNull();
  });
});

describe("redoSubjects：調べ直しの頼みの、足りないものの種類", () => {
  const failing = (targets: ("route" | "nearby" | "lodging")[]) => ({
    round: 1,
    maxRounds: 3,
    threshold: 70,
    passed: false,
    scores: [
      { criterion: "coverage" as const, score: 0, findings: [] },
      { criterion: "specificity" as const, score: 100, findings: [] },
      { criterion: "feasibility" as const, score: 100, findings: [] },
      { criterion: "grounding" as const, score: 100, findings: [] },
    ],
    redo: targets.map((target) => ({ target, criterion: "coverage" as const, ask: "調べ直す" })),
    judgedBy: "code" as const,
    evaluatedAt: "2026-08-03T10:15:00+09:00",
  });
  const gap = (code: "meal_missing" | "last_mile_missing" | "transfer_unknown", message = "") => ({
    code,
    itemId: null,
    message,
  });

  it("食事の不足は昼・夜に分け、食事の不足がない周辺の頼みは寄り道にする", () => {
    expect(
      redoSubjects(failing(["nearby"]), [
        gap("meal_missing", "夜の食事（17:30〜19:30ごろ）の店か案がありません"),
      ]),
    ).toEqual([{ target: "nearby", subject: "dinner" }]);
    expect(redoSubjects(failing(["nearby"]), [])).toEqual([
      { target: "nearby", subject: "sightseeing" },
    ]);
  });

  it("会場までの最後の移動だけが足りなければ last_mile、ほかの経路の不足もあれば route も", () => {
    expect(redoSubjects(failing(["route"]), [gap("last_mile_missing")])).toEqual([
      { target: "route", subject: "last_mile" },
    ]);
    expect(
      redoSubjects(failing(["route"]), [gap("last_mile_missing"), gap("transfer_unknown")]),
    ).toEqual([
      { target: "route", subject: "last_mile" },
      { target: "route", subject: "route" },
    ]);
  });
});
