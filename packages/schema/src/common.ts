import { z } from "zod";

/** ID。小文字の英数字をハイフンでつなぐ（例：suzunari-toro） */
export const SlugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "小文字の英数字とハイフンで書いてください");

/** 日付（YYYY-MM-DD） */
export const IsoDateSchema = z.iso.date();

/** 日時（ISO 8601。時差を付ける。例：2026-05-01T09:00:00+09:00） */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/** 時刻（HH:MM の24時間制）。日をまたぐ予定は、終了が開始より前になる */
export const LocalTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM の24時間制で書いてください");

/** 分の幅 [最短, 最長]。移動や徒歩の時間は1つの値にせず、幅のある目安として持つ */
export const MinuteRangeSchema = z
  .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
  .refine(([min, max]) => min <= max, "最短は最長以下にしてください");

export const LatLngSchema = z.strictObject({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export const WeekdaySchema = z.enum(WEEKDAYS);

/** 営業時間。最終入場があれば lastEntry に書く */
export const OpeningHoursSchema = z.strictObject({
  open: LocalTimeSchema,
  close: LocalTimeSchema,
  lastEntry: LocalTimeSchema.optional(),
});

/**
 * 確度。強い順に並べる。
 * - official：主催者・自治体の情報で確認した
 * - corroborated：公式はないが、2つ以上の情報源で一致した
 * - single：1つの情報源だけ
 * - inferred：推定（確定した旅程には入れない）
 */
export const CONFIDENCE_LEVELS = ["official", "corroborated", "single", "inferred"] as const;
export const ConfidenceSchema = z.enum(CONFIDENCE_LEVELS);

/** 出典。URL・確認した日・確度の3つを必ず持つ */
export const SourceSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }),
  title: z.string().min(1).optional(),
  checkedAt: IsoDateSchema,
  confidence: ConfidenceSchema,
});

/** 分からないことを、空欄ではなく明示するための値 */
export const UNKNOWN = "unknown";

/** 値か、分からないこと（"unknown"）のどちらかを必ず書かせる */
export function orUnknown<T extends z.ZodType>(schema: T) {
  return z.union([schema, z.literal(UNKNOWN)]);
}

export type IsoDate = z.infer<typeof IsoDateSchema>;
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;
export type LocalTime = z.infer<typeof LocalTimeSchema>;
export type MinuteRange = z.infer<typeof MinuteRangeSchema>;
export type LatLng = z.infer<typeof LatLngSchema>;
export type Weekday = z.infer<typeof WeekdaySchema>;
export type OpeningHours = z.infer<typeof OpeningHoursSchema>;
export type Confidence = z.infer<typeof ConfidenceSchema>;
export type Source = z.infer<typeof SourceSchema>;

/** 出典のうち、いちばん強い確度を返す。出典がなければ null */
export function strongestConfidence(sources: readonly Source[]): Confidence | null {
  let best: Confidence | null = null;
  for (const { confidence } of sources) {
    if (best === null || CONFIDENCE_LEVELS.indexOf(confidence) < CONFIDENCE_LEVELS.indexOf(best)) {
      best = confidence;
    }
  }
  return best;
}
