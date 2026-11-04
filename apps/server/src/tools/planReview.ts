import { retryOnce } from "@matsuri-ikoka/agent-kit";
import {
  EVALUATION_CRITERIA,
  type EvaluationCriterion,
  type Itinerary,
  type PlanEvaluation,
  type PlanGap,
} from "@matsuri-ikoka/schema";
import { evaluatePlan, type ModelScore, scorePlan } from "../domain/planEvaluation";
import type { ToolContext } from "./context";

// 保存した旅程の評価（評価して作り直すループの1回分）。
// 点検の結果からコードの点を出し、評価係（ToolContext.planEvaluator）がいれば採点を頼んで合わせ、
// 合否と調べ直しの頼みをコードで決める。評価係が失敗しても、点検の点だけで続ける。

/** 評価係の採点を打ち切る時間（ミリ秒）。update_itinerary の上限に収まる長さにする */
export const EVALUATION_MS = 50_000;

/** 無理のなさの点に入れる注意（planCheck の warnings）。出典を外した知らせなどは入れない */
const FEASIBILITY_WARNINGS = new Set([
  "rest_interval",
  "long_walk",
  "local_meal_missing",
  "shop_meal_unwanted",
]);

const CRITERION_LABELS: Record<EvaluationCriterion, string> = {
  coverage: "網羅",
  specificity: "具体さ",
  feasibility: "無理のなさ",
  grounding: "出典",
};

/**
 * 旅程を評価する。この発言の評価の回数を1つ進め、最後の評価として残す。
 * signal が止まったら評価係を待たず、点検の点だけで決める
 */
export async function reviewPlan(input: {
  ctx: ToolContext;
  itinerary: Itinerary;
  gaps: readonly PlanGap[];
  warnings: readonly { code: string; message: string }[];
  conditions: string;
  signal: AbortSignal;
}): Promise<PlanEvaluation> {
  const { ctx, itinerary, gaps } = input;
  const warnings = input.warnings.filter((w) => FEASIBILITY_WARNINGS.has(w.code));
  const code = scorePlan({ itinerary, gaps, warnings });
  let model: ModelScore[] | null = null;
  const evaluator = ctx.planEvaluator;
  if (evaluator !== undefined && !input.signal.aborted) {
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(EVALUATION_MS)]);
    try {
      model = await retryOnce(
        () =>
          evaluator.evaluate({
            itinerary,
            gaps,
            codeScores: code,
            conditions: input.conditions,
            signal,
          }),
        {
          signal,
          onRetry: (failure) =>
            console.info(JSON.stringify({ kind: "plan_evaluation_retry", failure: failure.kind })),
        },
      );
    } catch (error) {
      console.info(
        JSON.stringify({
          kind: "plan_evaluation_failed",
          error: error instanceof Error ? error.name : "unknown",
        }),
      );
      model = null;
    }
  }
  ctx.turn.planRounds += 1;
  const evaluation = evaluatePlan({
    code,
    judge: model,
    gaps,
    round: ctx.turn.planRounds,
    evaluatedAt: ctx.now(),
  });
  ctx.turn.lastEvaluation = evaluation;
  // 評価の傾向をつかむため、点と合否と回数だけを残す（旅程の中身は残さない）
  console.info(
    JSON.stringify({
      kind: "plan_evaluation",
      round: evaluation.round,
      passed: evaluation.passed,
      judgedBy: evaluation.judgedBy,
      scores: Object.fromEntries(evaluation.scores.map((s) => [s.criterion, s.score])),
      redo: evaluation.redo.map((r) => r.target),
    }),
  );
  return evaluation;
}

/** 評価のあとに旅程係がすること（ツールの結果の next に入れる） */
export function nextStepAfter(evaluation: PlanEvaluation): string {
  if (evaluation.passed) {
    return "評価の基準に届きました。保存した旅程の要点を報告してください";
  }
  const failing = EVALUATION_CRITERIA.filter((criterion) =>
    evaluation.scores.some((s) => s.criterion === criterion && s.score < evaluation.threshold),
  )
    .map((criterion) => CRITERION_LABELS[criterion])
    .join("・");
  if (evaluation.round >= evaluation.maxRounds) {
    return `評価は${evaluation.maxRounds}回までです。基準に届かなかった観点（${failing}）の足りない点（scores の findings）を、推測で埋めずに、そのままコンシェルジュに報告してください`;
  }
  const targets = [...new Set(evaluation.redo.map((r) => r.target))];
  const research =
    targets.length === 0
      ? "調べ直しは要りません。"
      : `research_trip を only: ${JSON.stringify(targets)} と、redo の ask を focus に付けて呼び、調べ直してください。`;
  return `基準（${evaluation.threshold}点）に届いていない観点があります（${failing}）。${research}調べた結果と gaps をもとに旅程を直し、update_itinerary を呼び直してください（評価はあと${evaluation.maxRounds - evaluation.round}回）`;
}
