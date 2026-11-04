import { PlanEvaluationSchema, type PlanGap } from "@matsuri-ikoka/schema";
import { fictionalPlannedItinerary } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { findGaps } from "./planCoverage";
import {
  EVALUATION_THRESHOLD,
  evaluatePlan,
  MAX_PLAN_ROUNDS,
  type ModelScore,
  ratingToScore,
  scorePlan,
} from "./planEvaluation";

const NOW = "2026-08-03T10:00:00+09:00";

const scoreOf = (scores: ReturnType<typeof scorePlan>, criterion: string) =>
  scores.find((s) => s.criterion === criterion)?.score;

const mealGap: PlanGap = {
  code: "meal_missing",
  itemId: null,
  message: "昼の食事（11:30〜13:30ごろ）の店か案がありません",
};
const transferGap: PlanGap = {
  code: "transfer_unknown",
  itemId: "go",
  message: "「みなと中央駅から鈴鳴駅へ」の乗り換えの駅と路線が分かっていません",
};

describe("scorePlan：点検の結果から観点ごとの点を出す", () => {
  it("そろった旅程は、すべての観点が満点", () => {
    const itinerary = fictionalPlannedItinerary();
    const scores = scorePlan({ itinerary, gaps: findGaps(itinerary), warnings: [] });
    expect(scores.map((s) => [s.criterion, s.score])).toEqual([
      ["coverage", 100],
      ["specificity", 100],
      ["feasibility", 100],
      ["grounding", 100],
    ]);
  });

  it("不足は観点ごとに点を下げ、足りない点として残す", () => {
    const scores = scorePlan({
      itinerary: fictionalPlannedItinerary(),
      gaps: [mealGap, transferGap],
      warnings: [{ code: "rest_interval", message: "休憩がありません" }],
    });
    // 食事と乗り換えは、1つ欠けただけで基準（70）を下回る
    expect(scoreOf(scores, "coverage")).toBe(65);
    expect(scoreOf(scores, "specificity")).toBe(65);
    expect(scoreOf(scores, "feasibility")).toBe(85);
    expect(scoreOf(scores, "grounding")).toBe(100);
    expect(scores.find((s) => s.criterion === "coverage")?.findings).toEqual([mealGap.message]);
  });

  it("路線の分からない電車の区間は、具体さを下げる", () => {
    const itinerary = fictionalPlannedItinerary();
    itinerary.days[0]!.items[0]!.move!.legs![1]!.line = null;
    const scores = scorePlan({ itinerary, gaps: [], warnings: [] });
    expect(scoreOf(scores, "specificity")).toBe(95);
  });

  it("点は0を下回らない", () => {
    const gaps = Array.from({ length: 10 }, () => mealGap);
    const scores = scorePlan({ itinerary: fictionalPlannedItinerary(), gaps, warnings: [] });
    expect(scoreOf(scores, "coverage")).toBe(0);
  });
});

describe("evaluatePlan：合否と調べ直しの頼み", () => {
  const perfect = () =>
    scorePlan({ itinerary: fictionalPlannedItinerary(), gaps: [], warnings: [] });

  it("すべての観点が基準に届けば合格で、調べ直しは頼まない", () => {
    const evaluation = evaluatePlan({
      code: perfect(),
      judge: null,
      gaps: [],
      round: 1,
      evaluatedAt: NOW,
    });
    expect(evaluation).toMatchObject({
      passed: true,
      redo: [],
      judgedBy: "code",
      threshold: EVALUATION_THRESHOLD,
      maxRounds: MAX_PLAN_ROUNDS,
    });
    expect(PlanEvaluationSchema.safeParse(evaluation).success).toBe(true);
  });

  it("昼の食事が1つ欠けただけでも不合格にする", () => {
    const code = scorePlan({
      itinerary: fictionalPlannedItinerary(),
      gaps: [mealGap],
      warnings: [],
    });
    const evaluation = evaluatePlan({
      code,
      judge: null,
      gaps: [mealGap],
      round: 1,
      evaluatedAt: NOW,
    });
    expect(evaluation.passed).toBe(false);
  });

  it("食事が足りなければ、網羅の観点を名指しして周辺係に調べ直しを頼む", () => {
    const gaps = [
      mealGap,
      { ...mealGap, message: "夜の食事（17:30〜19:30ごろ）の店か案がありません" },
    ];
    const code = scorePlan({ itinerary: fictionalPlannedItinerary(), gaps, warnings: [] });
    const evaluation = evaluatePlan({ code, judge: null, gaps, round: 1, evaluatedAt: NOW });
    expect(evaluation.passed).toBe(false);
    expect(evaluation.redo).toHaveLength(1);
    expect(evaluation.redo[0]).toMatchObject({ target: "nearby", criterion: "coverage" });
    expect(evaluation.redo[0]?.ask).toContain("昼の食事");
    expect(evaluation.redo[0]?.ask).toContain("夜の食事");
    expect(PlanEvaluationSchema.safeParse(evaluation).success).toBe(true);
  });

  it("基準に届いた観点の不足は、調べ直しを頼まない", () => {
    // 出発・到着の場所の不足1つ（具体さ 90）は基準に届いているので頼まない。網羅が届かないので不合格
    const endpointsGap: PlanGap = {
      code: "move_endpoints_missing",
      itemId: "go",
      message: "「みなと中央駅から鈴鳴駅へ」の出発・到着の場所がありません",
    };
    const gaps = [endpointsGap, mealGap];
    const code = scorePlan({ itinerary: fictionalPlannedItinerary(), gaps, warnings: [] });
    const evaluation = evaluatePlan({ code, judge: null, gaps, round: 1, evaluatedAt: NOW });
    expect(evaluation.redo.map((r) => r.target)).toEqual(["nearby"]);
  });

  it("評価係の点が低ければ低いほうを点にし、評価係の名指しした係にも頼む", () => {
    const judge: ModelScore[] = [
      {
        criterion: "specificity",
        rating: 2,
        findings: ["帰りの電車の乗り換えの駅が書かれていない"],
        targets: ["route"],
      },
    ];
    const evaluation = evaluatePlan({
      code: perfect(),
      judge,
      gaps: [],
      round: 2,
      evaluatedAt: NOW,
    });
    expect(evaluation.judgedBy).toBe("code+model");
    expect(evaluation.scores.find((s) => s.criterion === "specificity")).toEqual({
      criterion: "specificity",
      score: 25,
      findings: ["帰りの電車の乗り換えの駅が書かれていない"],
    });
    expect(evaluation.passed).toBe(false);
    expect(evaluation.redo).toEqual([
      {
        target: "route",
        criterion: "specificity",
        ask: expect.stringContaining("帰りの電車の乗り換えの駅が書かれていない"),
      },
    ]);
  });

  it("評価係の点は 1〜5 を 0〜100 にし、範囲の外は丸める", () => {
    expect([1, 3, 4, 5, 0, 9].map(ratingToScore)).toEqual([0, 50, 75, 100, 0, 100]);
  });

  it("回数は上限で止める", () => {
    const evaluation = evaluatePlan({
      code: perfect(),
      judge: null,
      gaps: [],
      round: 5,
      evaluatedAt: NOW,
    });
    expect(evaluation.round).toBe(MAX_PLAN_ROUNDS);
  });
});
