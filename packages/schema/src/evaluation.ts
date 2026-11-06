import { z } from "zod";
import { IsoDateTimeSchema } from "./common";

const TextSchema = z.string().min(1);

// ---------------------------------------------------------------------------
// 旅程の点検で見つかった不足（gaps）

/**
 * 旅程にそろっているべきもののうち、足りないもの。分からないところは推測で埋めず、ここに書く。
 * outbound_missing 出発の駅からの移動がない / return_missing 帰りの移動がない /
 * last_mile_missing 祭りの会場までの最後の移動がない / last_return_unknown 帰りの最終の目安が分からない /
 * move_endpoints_missing 移動の出発・到着の場所がない / transfer_unknown 電車・バスの乗り換えの区間が分からない /
 * move_unsourced 電車・バスの移動に出典がない / meal_missing 滞在の時間帯にかかる食事の案がない /
 * meal_unsourced 店や屋台の食事の案に出典がない / research_unreviewed 調べた場所の採否と理由がない /
 * lodging_missing 泊まる夜があるのに宿の候補がない
 */
export const PLAN_GAP_CODES = [
  "outbound_missing",
  "return_missing",
  "last_mile_missing",
  "last_return_unknown",
  "move_endpoints_missing",
  "transfer_unknown",
  "move_unsourced",
  "meal_missing",
  "meal_unsourced",
  "research_unreviewed",
  "lodging_missing",
] as const;

export const PlanGapSchema = z.strictObject({
  code: z.enum(PLAN_GAP_CODES),
  /** 足りない予定。旅程全体や日の不足なら null */
  itemId: TextSchema.nullable(),
  message: TextSchema,
});

// ---------------------------------------------------------------------------
// 旅程の評価（評価係の採点）

/**
 * 採点の観点。coverage 網羅（移動・乗り換え・食事・最後の移動・調べの採否がそろっているか）/
 * specificity 具体さ（路線・乗り換えの駅・店の名前まで書けているか）/
 * feasibility 無理のなさ（時刻の矛盾・営業時間・休憩・歩く時間）/ grounding 出典（予定ごとに出典があるか）
 */
export const EVALUATION_CRITERIA = ["coverage", "specificity", "feasibility", "grounding"] as const;

/** 調べ直しを頼む先。route 経路（乗り換えと帰りの最終まで）/ nearby 食事と寄り道 / lodging 宿 */
export const RESEARCH_TARGETS = ["route", "nearby", "lodging"] as const;

/** 1つの観点の点（0〜100）と、足りない点 */
export const CriterionScoreSchema = z.strictObject({
  criterion: z.enum(EVALUATION_CRITERIA),
  score: z.number().int().min(0).max(100),
  /** 点を下げた理由（足りないところ）。満点なら空 */
  findings: z.array(TextSchema).max(10),
});

/** 調べ直しの頼み。どの観点が足りないために、どの係に何を調べ直してもらうか */
export const ResearchRequestSchema = z.strictObject({
  target: z.enum(RESEARCH_TARGETS),
  criterion: z.enum(EVALUATION_CRITERIA),
  ask: TextSchema.max(200),
});

/**
 * 旅程の評価。点検（コード）の点と、評価係（モデル）の点のうち低いほうを観点ごとの点にする。
 * すべての観点が基準（threshold）に届けば passed。届かなければ redo の係に調べ直しを頼んで作り直す（maxRounds 回まで）
 */
export const PlanEvaluationSchema = z
  .strictObject({
    /** 何回目の評価か（1から） */
    round: z.number().int().min(1),
    maxRounds: z.number().int().min(1),
    threshold: z.number().int().min(0).max(100),
    passed: z.boolean(),
    scores: z.array(CriterionScoreSchema).length(EVALUATION_CRITERIA.length),
    redo: z.array(ResearchRequestSchema).max(10),
    /** code 点検だけで採点した / code+model 評価係の採点も合わせた */
    judgedBy: z.enum(["code", "code+model"]),
    evaluatedAt: IsoDateTimeSchema,
  })
  .superRefine((evaluation, ctx) => {
    const criteria = new Set(evaluation.scores.map((s) => s.criterion));
    if (criteria.size !== EVALUATION_CRITERIA.length) {
      ctx.addIssue({
        code: "custom",
        path: ["scores"],
        message: "観点ごとに1つずつ点を付けてください",
      });
    }
    const passed = evaluation.scores.every((s) => s.score >= evaluation.threshold);
    if (evaluation.passed !== passed) {
      ctx.addIssue({
        code: "custom",
        path: ["passed"],
        message: "passed は、すべての観点が基準に届いたかと一致させてください",
      });
    }
    if (evaluation.round > evaluation.maxRounds) {
      ctx.addIssue({
        code: "custom",
        path: ["round"],
        message: "round は maxRounds 以下にしてください",
      });
    }
  });

export type PlanGapCode = (typeof PLAN_GAP_CODES)[number];
export type PlanGap = z.infer<typeof PlanGapSchema>;
export type EvaluationCriterion = (typeof EVALUATION_CRITERIA)[number];
export type ResearchTarget = (typeof RESEARCH_TARGETS)[number];
export type CriterionScore = z.infer<typeof CriterionScoreSchema>;
export type ResearchRequest = z.infer<typeof ResearchRequestSchema>;
export type PlanEvaluation = z.infer<typeof PlanEvaluationSchema>;
