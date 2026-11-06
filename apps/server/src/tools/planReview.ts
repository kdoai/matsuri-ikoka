import { retryOnce } from "@matsuri-ikoka/agent-kit";
import {
  EVALUATION_CRITERIA,
  type EvaluationCriterion,
  type Itinerary,
  type PlanEvaluation,
  type PlanGap,
  type RedoSubject,
  type ResearchTarget,
  type SseEventOf,
  type StaffId,
} from "@matsuri-ikoka/schema";
import { redoEvent } from "../agent/bubbles";
import { mealGapSlot } from "../domain/planCoverage";
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
/**
 * 発言の始まりからこれだけたったら、基準に届かなくても調べ直さず、保存した旅程で報告する。
 * 相談1回の上限（TURN_MAX_MS）の前に、旅程係とコンシェルジュが報告を書き終える時間を残す
 */
export const PLAN_REDO_DEADLINE_MS = 210_000;

/** 調べ直して作り直す時間が残っているか */
export function canRedoPlan(startedAt: number, now: number = Date.now()): boolean {
  return now - startedAt < PLAN_REDO_DEADLINE_MS;
}

export function nextStepAfter(evaluation: PlanEvaluation, canRedo = true): string {
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
  if (!canRedo) {
    return `時間の残りが少ないので、調べ直しません。保存した旅程の要点と、基準に届かなかった観点（${failing}）の足りない点を報告してください`;
  }
  const targets = [...new Set(evaluation.redo.map((r) => r.target))];
  const research =
    targets.length === 0
      ? "調べ直しは要りません。"
      : `research_trip を only: ${JSON.stringify(targets)} と、redo の ask を focus に付けて呼び、調べ直してください。`;
  return `基準（${evaluation.threshold}点）に届いていない観点があります（${failing}）。${research}調べた結果と gaps をもとに旅程を直し、update_itinerary を呼び直してください（評価はあと${evaluation.maxRounds - evaluation.round}回）`;
}

/** 行き方の調べ直しで直る不足のうち、会場までの最後の移動のほか */
const ROUTE_GAPS = new Set<PlanGap["code"]>([
  "outbound_missing",
  "return_missing",
  "last_return_unknown",
  "move_endpoints_missing",
  "transfer_unknown",
  "move_unsourced",
]);

/** 調べ直しを頼む先の係と、頼む人。周辺の調べは周辺係に、行き方と宿の調べは旅程係に頼む */
const REDO_STAFF: Record<ResearchTarget, { from: StaffId; to: StaffId }> = {
  nearby: { from: "planner", to: "scout" },
  route: { from: "concierge", to: "planner" },
  lodging: { from: "concierge", to: "planner" },
};

/** 調べ直しの頼み（係ごと）に、足りないものの種類を付ける。種類は不足から決め、評価の文は使わない */
export function redoSubjects(
  evaluation: PlanEvaluation,
  gaps: readonly PlanGap[],
): { target: ResearchTarget; subject: RedoSubject }[] {
  const subjects = new Map<string, { target: ResearchTarget; subject: RedoSubject }>();
  const add = (target: ResearchTarget, subject: RedoSubject) =>
    subjects.set(`${target}:${subject}`, { target, subject });
  for (const target of new Set(evaluation.redo.map((r) => r.target))) {
    if (target === "nearby") {
      const meals = gaps.flatMap((gap) => mealGapSlot(gap) ?? []);
      if (meals.length === 0) add(target, "sightseeing");
      for (const slot of meals) add(target, slot);
    } else if (target === "route") {
      // 会場までの最後の移動だけが足りないときは last_mile、それ以外の経路の不足（評価係の指摘を含む）は route
      const lastMileOnly =
        gaps.some((gap) => gap.code === "last_mile_missing") &&
        !gaps.some((gap) => ROUTE_GAPS.has(gap.code));
      if (gaps.some((gap) => gap.code === "last_mile_missing")) add(target, "last_mile");
      if (!lastMileOnly) add(target, "route");
    } else {
      add(target, "lodging");
    }
  }
  return [...subjects.values()];
}

/**
 * 評価が基準に届かず、作り直す回数が残っているときの、調べ直しの頼みのイベント（画面のスタッフどうしのやりとり）
 */
export function redoRequestEvents(
  evaluation: PlanEvaluation,
  gaps: readonly PlanGap[],
): SseEventOf<"staff.redo">[] {
  if (evaluation.passed || evaluation.round >= evaluation.maxRounds) return [];
  return redoSubjects(evaluation, gaps).map(({ target, subject }) =>
    redoEvent("request", REDO_STAFF[target].from, REDO_STAFF[target].to, subject),
  );
}

/** 調べ直しを受けたときのイベント（頼まれた係が、頼んだ人に答える） */
export function redoAcceptEvent(
  target: ResearchTarget,
  subject: RedoSubject,
): SseEventOf<"staff.redo"> {
  const { from, to } = REDO_STAFF[target];
  return redoEvent("accept", to, from, subject);
}
