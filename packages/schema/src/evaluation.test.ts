import { describe, expect, it } from "vitest";
import { type PlanEvaluation, PlanEvaluationSchema, PlanGapSchema } from "./evaluation";
import { ItinerarySchema } from "./itinerary";
import { fictionalPlannedItinerary } from "./testing";

function evaluation(): PlanEvaluation {
  return {
    round: 1,
    maxRounds: 3,
    threshold: 70,
    passed: false,
    scores: [
      { criterion: "coverage", score: 60, findings: ["昼の食事の案がない"] },
      { criterion: "specificity", score: 80, findings: [] },
      { criterion: "feasibility", score: 100, findings: [] },
      { criterion: "grounding", score: 90, findings: [] },
    ],
    redo: [
      {
        target: "nearby",
        criterion: "coverage",
        ask: "11:30〜13:30 に会場の近くで昼を食べられる店",
      },
    ],
    judgedBy: "code+model",
    evaluatedAt: "2026-08-03T10:00:00+09:00",
  };
}

describe("PlanEvaluationSchema", () => {
  it("観点ごとの点と、調べ直しの頼みを持つ", () => {
    expect(PlanEvaluationSchema.safeParse(evaluation()).success).toBe(true);
  });

  it("4つの観点に1つずつ点を付ける", () => {
    const duplicated = evaluation();
    duplicated.scores[1] = { criterion: "coverage", score: 80, findings: [] };
    expect(PlanEvaluationSchema.safeParse(duplicated).success).toBe(false);
  });

  it("passed は、すべての観点が基準に届いたかと一致させる", () => {
    const wrong = evaluation();
    wrong.passed = true;
    expect(PlanEvaluationSchema.safeParse(wrong).success).toBe(false);
  });

  it("回数は上限を超えない", () => {
    const over = evaluation();
    over.round = 4;
    expect(PlanEvaluationSchema.safeParse(over).success).toBe(false);
  });

  it("旅程に評価と不足を付けられる", () => {
    const itinerary = {
      ...fictionalPlannedItinerary(),
      evaluation: evaluation(),
      gaps: [{ code: "meal_missing", itemId: null, message: "昼の食事の案がありません" }],
    };
    expect(ItinerarySchema.safeParse(itinerary).success).toBe(true);
  });
});

describe("PlanGapSchema", () => {
  it("決まった種類の不足だけを書ける", () => {
    expect(
      PlanGapSchema.safeParse({ code: "guess", itemId: null, message: "推測した" }).success,
    ).toBe(false);
  });
});
