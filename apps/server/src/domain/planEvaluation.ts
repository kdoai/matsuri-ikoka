import {
  type CriterionScore,
  EVALUATION_CRITERIA,
  type EvaluationCriterion,
  type Itinerary,
  type PlanEvaluation,
  type PlanGap,
  type PlanGapCode,
  type ResearchRequest,
  type ResearchTarget,
} from "@matsuri-ikoka/schema";
import { isTransitMove } from "./planCoverage";

// 旅程の評価のうち、コードで決める部分。点検の結果（不足・注意）から観点ごとの点を出し、
// 評価係（モデル）の点と合わせて合否を決め、足りない観点の係への調べ直しの頼みを作る。
// 点の計算と合否はコードで決め、モデルには計算させない。

/** 合格の基準（観点ごとの点がこれ以上） */
export const EVALUATION_THRESHOLD = 70;
/** 1回の相談で評価する回数の上限（最初の1回と、作り直し2回） */
export const MAX_PLAN_ROUNDS = 3;

/**
 * 不足1つで下げる点。行き・帰り・最後の移動・食事・乗り換え・移動の出典は、1つ欠けたら基準（70）を下回る重さにする。
 * 帰りの最終・採否の理由・食事の出典は、2つ欠けたら下回る
 */
const GAP_PENALTY: Readonly<
  Record<PlanGapCode, { criterion: EvaluationCriterion; points: number }>
> = {
  outbound_missing: { criterion: "coverage", points: 40 },
  return_missing: { criterion: "coverage", points: 40 },
  last_mile_missing: { criterion: "coverage", points: 35 },
  last_return_unknown: { criterion: "coverage", points: 20 },
  meal_missing: { criterion: "coverage", points: 35 },
  research_unreviewed: { criterion: "coverage", points: 20 },
  move_endpoints_missing: { criterion: "specificity", points: 10 },
  transfer_unknown: { criterion: "specificity", points: 35 },
  move_unsourced: { criterion: "grounding", points: 35 },
  meal_unsourced: { criterion: "grounding", points: 20 },
};

/** 不足に応じて調べ直しを頼む係。旅程係が書けば済む不足（採否の理由）は頼まない */
const GAP_TARGET: Readonly<Partial<Record<PlanGapCode, ResearchTarget>>> = {
  outbound_missing: "route",
  return_missing: "route",
  last_mile_missing: "route",
  last_return_unknown: "route",
  move_endpoints_missing: "route",
  transfer_unknown: "route",
  move_unsourced: "route",
  meal_missing: "nearby",
  meal_unsourced: "nearby",
};

/** 注意（planCheck の warnings）1つで下げる無理のなさの点 */
const WARNING_PENALTY = 15;
/** 路線の分からない電車・バスの区間1つで下げる具体さの点 */
const UNKNOWN_LINE_PENALTY = 5;

export interface PlanWarning {
  code: string;
  message: string;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** 点検の結果から、観点ごとの点（コードの点）を出す */
export function scorePlan(input: {
  itinerary: Pick<Itinerary, "days">;
  gaps: readonly PlanGap[];
  warnings: readonly PlanWarning[];
}): CriterionScore[] {
  const points = new Map<EvaluationCriterion, number>(EVALUATION_CRITERIA.map((c) => [c, 100]));
  const findings = new Map<EvaluationCriterion, string[]>(EVALUATION_CRITERIA.map((c) => [c, []]));
  const take = (criterion: EvaluationCriterion, penalty: number, finding: string) => {
    points.set(criterion, (points.get(criterion) ?? 100) - penalty);
    findings.get(criterion)?.push(finding);
  };

  for (const gap of input.gaps) {
    const { criterion, points: penalty } = GAP_PENALTY[gap.code];
    take(criterion, penalty, gap.message);
  }
  for (const warning of input.warnings) take("feasibility", WARNING_PENALTY, warning.message);

  const items = input.itinerary.days.flatMap((day) => day.items);
  for (const item of items) {
    const unknownLines = (item.move?.legs ?? []).filter(
      (leg) => (leg.means === "train" || leg.means === "bus") && leg.line === null,
    );
    if (item.type === "move" && isTransitMove(item.move) && unknownLines.length > 0) {
      take(
        "specificity",
        UNKNOWN_LINE_PENALTY * unknownLines.length,
        `「${item.name}」に路線の分からない区間があります`,
      );
    }
  }

  return EVALUATION_CRITERIA.map((criterion) => ({
    criterion,
    score: clamp(points.get(criterion) ?? 0),
    findings: (findings.get(criterion) ?? []).slice(0, 10),
  }));
}

/** 評価係（モデル）の採点。1〜5 の点と、足りない点と、調べ直しを頼みたい係 */
export interface ModelScore {
  criterion: EvaluationCriterion;
  /** 1（足りない）〜5（十分） */
  rating: number;
  findings: string[];
  targets: ResearchTarget[];
}

/** 評価係の 1〜5 の点を 0〜100 にする */
export function ratingToScore(rating: number): number {
  return clamp((Math.min(5, Math.max(1, rating)) - 1) * 25);
}

/**
 * コードの点と評価係の点を合わせて、評価を決める。観点ごとに低いほうを点にし、
 * すべての観点が基準に届けば合格。届かなければ、不足と評価係の指摘から調べ直しの頼みを作る
 */
export function evaluatePlan(input: {
  code: readonly CriterionScore[];
  judge: readonly ModelScore[] | null;
  gaps: readonly PlanGap[];
  round: number;
  maxRounds?: number;
  threshold?: number;
  evaluatedAt: string;
}): PlanEvaluation {
  const threshold = input.threshold ?? EVALUATION_THRESHOLD;
  const maxRounds = input.maxRounds ?? MAX_PLAN_ROUNDS;
  const scores = EVALUATION_CRITERIA.map((criterion): CriterionScore => {
    const code = input.code.find((s) => s.criterion === criterion);
    const judge = input.judge?.find((s) => s.criterion === criterion);
    const codeScore = code?.score ?? 100;
    const modelScore = judge === undefined ? 100 : ratingToScore(judge.rating);
    const findings = [...(code?.findings ?? []), ...(judge?.findings ?? [])];
    return {
      criterion,
      score: Math.min(codeScore, modelScore),
      findings: [...new Set(findings)].slice(0, 10),
    };
  });
  const passed = scores.every((s) => s.score >= threshold);
  const failing = new Set(scores.filter((s) => s.score < threshold).map((s) => s.criterion));
  return {
    round: Math.min(input.round, maxRounds),
    maxRounds,
    threshold,
    passed,
    scores,
    redo: passed ? [] : researchRequests(input.gaps, input.judge ?? [], failing),
    judgedBy: input.judge === null ? "code" : "code+model",
    evaluatedAt: input.evaluatedAt,
  };
}

const TARGET_LEAD: Record<ResearchTarget, string> = {
  route: "行き・帰りの乗り換えの駅と路線、会場までの最後の移動、帰りの最終を調べ直す",
  nearby: "滞在の時間帯にかかる食事の店（屋台で済ませるなら屋台の情報）を調べ直す",
  lodging: "泊まる夜の宿を調べ直す",
};

/** 足りない観点の係への調べ直しの頼み。係と観点ごとに1つにまとめる */
function researchRequests(
  gaps: readonly PlanGap[],
  judge: readonly ModelScore[],
  failing: ReadonlySet<EvaluationCriterion>,
): ResearchRequest[] {
  const asks = new Map<
    string,
    { target: ResearchTarget; criterion: EvaluationCriterion; details: string[] }
  >();
  const add = (target: ResearchTarget, criterion: EvaluationCriterion, detail: string) => {
    const key = `${target}:${criterion}`;
    const entry = asks.get(key) ?? { target, criterion, details: [] };
    if (!entry.details.includes(detail)) entry.details.push(detail);
    asks.set(key, entry);
  };
  for (const gap of gaps) {
    const target = GAP_TARGET[gap.code];
    const { criterion } = GAP_PENALTY[gap.code];
    if (target !== undefined && failing.has(criterion)) add(target, criterion, gap.message);
  }
  for (const score of judge) {
    if (!failing.has(score.criterion)) continue;
    for (const target of score.targets) {
      add(target, score.criterion, score.findings[0] ?? TARGET_LEAD[target]);
    }
  }
  return [...asks.values()].slice(0, 10).map(({ target, criterion, details }) => ({
    target,
    criterion,
    ask: `${TARGET_LEAD[target]}：${details.join("／")}`.slice(0, 200),
  }));
}
