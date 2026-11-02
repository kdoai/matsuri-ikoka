import { z } from "zod";
import { IsoDateSchema } from "./common";

// ---------------------------------------------------------------------------
// 旅のこだわり（4項目。どれも1つ選ぶ切り替え）

/** だれと：大人だけ / 子連れ / シニアと一緒 */
export const PARTY_TYPES = ["adults", "kids", "seniors"] as const;
/** どんな場所：定番どころ / おまかせ / 穴場 */
export const SPOT_STYLES = ["classic", "auto", "hidden"] as const;
/** ごはん：屋台で十分 / 地元の店も楽しむ */
export const FOOD_STYLES = ["stalls", "local"] as const;
/** 移動：電車（と徒歩）/ 車 */
export const MOVE_MODES = ["train", "car"] as const;

export const PreferencesSchema = z.strictObject({
  party: z.enum(PARTY_TYPES),
  spot: z.enum(SPOT_STYLES),
  food: z.enum(FOOD_STYLES),
  move: z.enum(MOVE_MODES),
});
export type Preferences = z.infer<typeof PreferencesSchema>;

export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({
  party: "adults",
  spot: "auto",
  food: "stalls",
  move: "train",
});

// ---------------------------------------------------------------------------
// 旅の条件（会話で聞き取る）

/** 同行者の人数 */
export const PartySchema = z.strictObject({
  adults: z.number().int().min(1).max(20),
  children: z.number().int().min(0).max(20),
});
export type Party = z.infer<typeof PartySchema>;

/** 希望の日。1日か、期間（例：来週末） */
export const DateWishSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("date"), date: IsoDateSchema }),
  z
    .strictObject({ kind: z.literal("range"), from: IsoDateSchema, to: IsoDateSchema })
    .refine((range) => range.from <= range.to, {
      path: ["to"],
      message: "期間の終わりは始まり以降にしてください",
    }),
]);
export type DateWish = z.infer<typeof DateWishSchema>;

/** 泊数の上限（6泊7日） */
export const MAX_NIGHTS = 6;

/** 泊数。0 は日帰り・週末のちょっとしたお出かけ、1〜6 は泊まりの旅 */
export const NightsSchema = z.number().int().min(0).max(MAX_NIGHTS);

/**
 * 旅の条件。日付・出発地・泊数がそろうと、祭りを探し始める。同行者は任意。
 * 近場のお出かけと分かる相談では、泊まるかを聞き直さず 0 泊にしてよい。
 * 出発地は駅名までにとどめ、住所は聞かない。
 */
export const TripConditionsSchema = z.strictObject({
  when: DateWishSchema,
  origin: z.string().trim().min(1).max(50),
  nights: NightsSchema,
  party: PartySchema.optional(),
});
export type TripConditions = z.infer<typeof TripConditionsSchema>;

/** 聞き取りの途中の条件。分かったものから埋まる */
export const PartialTripConditionsSchema = TripConditionsSchema.partial();
export type PartialTripConditions = z.infer<typeof PartialTripConditionsSchema>;
