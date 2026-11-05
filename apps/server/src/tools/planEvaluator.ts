import type { CriterionScore, Itinerary, PlanGap } from "@matsuri-ikoka/schema";
import type { ModelScore } from "../domain/planEvaluation";

export type { ModelScore };

export interface PlanEvaluationRequest {
  itinerary: Itinerary;
  /** 点検で見つかった不足 */
  gaps: readonly PlanGap[];
  /** 点検の結果からコードで出した点 */
  codeScores: readonly CriterionScore[];
  /** 聞き取った条件の要約（店の記録） */
  conditions: string;
  signal: AbortSignal;
}

/**
 * 保存した旅程を、観点ごとに採点する口（評価係）。
 * live では道具を持たない1回きりのエージェントが受け持つ（agent/planEvaluator.ts、モデルは MODEL_EVALUATOR）。
 * 返す点は信用しない入力として、合否と調べ直しの頼みはコードで決める（domain/planEvaluation.ts）。
 */
export interface PlanEvaluator {
  /** 採点できなかったときは null（点検の点だけで決める） */
  evaluate(input: PlanEvaluationRequest): Promise<ModelScore[] | null>;
}
