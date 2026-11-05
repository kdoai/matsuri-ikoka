import { z } from "zod";
import { MinuteRangeSchema } from "./common";
import { DateWishSchema, MaxTravelMinutesSchema, NightsSchema } from "./preferences";

// 祭りを探すときの条件の検査と、条件に合う祭りがないときの次の手（docs/spec/agents.md の「条件の守り方」）。
// 条件に照らした値・外れた理由・次の手は、どれもコードで決める。モデルには判断させない。

const TextSchema = z.string().min(1);

/** 行き先をどこまで広げてよいか：選んだ地域だけ / 隣接する県まで / 全国からランダムに */
export const DESTINATION_WIDEN_STAGES = ["area", "neighbor", "nationwide"] as const;
export const DestinationWidenSchema = z.enum(DESTINATION_WIDEN_STAGES);

/**
 * 出発の駅からの片道の所要時間を、上限と比べた結果：
 * within 収まる / uncertain 見積もりの幅が上限をまたぐ / over 超える / unknown 所要時間が分からない
 */
export const TRAVEL_FITS = ["within", "uncertain", "over", "unknown"] as const;
export const TravelFitSchema = z.enum(TRAVEL_FITS);

/** 候補に出す、出発の駅からの片道の所要時間を条件に照らした値 */
export const CandidateTravelSchema = z.strictObject({
  /** 片道の所要時間の目安（分の幅）。分からなければ null */
  minutes: MinuteRangeSchema.nullable(),
  /** 目安の根拠：data 祭りのデータ / estimate 駅の位置からの見積もり。分からなければ null */
  basis: z.enum(["data", "estimate"]).nullable(),
  /** 照らした片道の上限（分）。泊まりの旅のように上限がなければ null */
  limitMinutes: MaxTravelMinutesSchema.nullable(),
  /** 上限と比べた結果。上限がなければ null */
  fit: TravelFitSchema.nullable(),
});

/** 探すときに守る条件：日程（希望の日・期間）/ 片道の所要時間 / 行き先 */
export const SEARCH_CONDITIONS = ["date", "travel", "area"] as const;
export const SearchConditionSchema = z.enum(SEARCH_CONDITIONS);

/** 条件から外れている点。detail はコードで決まった型で作る */
export const SearchMissSchema = z.strictObject({
  condition: SearchConditionSchema,
  detail: TextSchema,
});

/** 次の手で変える条件。渡した項目だけを変えて探し直す */
export const SearchRetrySchema = z
  .strictObject({
    when: DateWishSchema.optional(),
    maxTravelMinutes: MaxTravelMinutesSchema.optional(),
    nights: NightsSchema.optional(),
    widen: DestinationWidenSchema.optional(),
  })
  .refine((retry) => Object.values(retry).some((value) => value !== undefined), {
    message: "変える条件を1つ以上渡してください",
  });

/**
 * 次の手：日程を先に延ばす / 片道の時間を延ばす / 行き先を広げる / 泊まりにする /
 * 条件を選び直す（聞き取りに戻る）
 */
export const SEARCH_SUGGESTION_KINDS = [
  "later_dates",
  "longer_travel",
  "wider_area",
  "stay_over",
  "edit_conditions",
] as const;
export const SearchSuggestionKindSchema = z.enum(SEARCH_SUGGESTION_KINDS);

/** 次の手の数の上限（条件を選び直すを含む） */
export const MAX_SEARCH_SUGGESTIONS = 6;
/** 1回の検索で、条件を変えて探し直す回数も含めて探す回数の上限 */
export const MAX_SEARCH_ATTEMPTS = 6;

export const SearchSuggestionSchema = z
  .strictObject({
    kind: SearchSuggestionKindSchema,
    /** ボタンの文。コードで決まった型で作る */
    label: TextSchema,
    /** 探し直す条件。条件を選び直す（edit_conditions）では null */
    retry: SearchRetrySchema.nullable(),
    /** 探し直すときに送る発言。条件を選び直す（edit_conditions）では null */
    message: TextSchema.nullable(),
    /** 変えた条件で、祭りのデータの上で条件に合う祭りの数（探し直す前にコードで数えたもの） */
    found: z.number().int().nonnegative().nullable(),
  })
  .superRefine((suggestion, ctx) => {
    const edit = suggestion.kind === "edit_conditions";
    if (edit !== (suggestion.retry === null) || edit !== (suggestion.message === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["retry"],
        message: "条件を選び直す次の手だけ、retry と message を null にします",
      });
    }
  });

export type DestinationWiden = z.infer<typeof DestinationWidenSchema>;
export type TravelFit = z.infer<typeof TravelFitSchema>;
export type CandidateTravel = z.infer<typeof CandidateTravelSchema>;
export type SearchCondition = z.infer<typeof SearchConditionSchema>;
export type SearchMiss = z.infer<typeof SearchMissSchema>;
export type SearchRetry = z.infer<typeof SearchRetrySchema>;
export type SearchSuggestionKind = z.infer<typeof SearchSuggestionKindSchema>;
export type SearchSuggestion = z.infer<typeof SearchSuggestionSchema>;
