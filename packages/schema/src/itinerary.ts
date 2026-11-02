import { z } from "zod";
import {
  IsoDateSchema,
  IsoDateTimeSchema,
  LatLngSchema,
  LocalTimeSchema,
  MinuteRangeSchema,
  OpeningHoursSchema,
  SlugSchema,
  type Source,
  SourceSchema,
} from "./common";
import { PartySchema, PreferencesSchema } from "./preferences";

const TextSchema = z.string().min(1);
const VersionSchema = z.number().int().min(1);

// ---------------------------------------------------------------------------
// 予定（旅程の1行）

/**
 * 予定の種類。
 * move 移動 / sightseeing 観光 / meal 食事 / rest 休憩 /
 * festival_prep 祭りの前の準備（到着の余裕・場所取り・申し込み）/ festival 祭り
 */
export const ITINERARY_ITEM_TYPES = [
  "move",
  "sightseeing",
  "meal",
  "rest",
  "festival_prep",
  "festival",
] as const;

export const MOVE_MEANS = ["walk", "train", "bus", "car", "taxi"] as const;

/** 前の予定からの移動。所要時間は必ず目安として扱う */
export const MoveSchema = z.strictObject({
  means: z.enum(MOVE_MEANS),
  minutes: MinuteRangeSchema,
  estimate: z.literal(true),
  note: TextSchema.optional(),
});

export const ItineraryItemSchema = z
  .strictObject({
    /** 版をまたいで同じ予定を指す ID。差分の計算に使う */
    id: TextSchema,
    start: LocalTimeSchema,
    end: LocalTimeSchema,
    type: z.enum(ITINERARY_ITEM_TYPES),
    name: TextSchema,
    /** 地図に打つ場所。移動の予定などでは null */
    location: LatLngSchema.nullable(),
    /** ここに入れた理由（1文） */
    reason: TextSchema,
    move: MoveSchema.nullable(),
    /** 当日の営業時間。営業時間のない場所では null */
    hours: OpeningHoursSchema.nullable(),
    /** 費用の目安（例：無料、体験 600円） */
    cost: TextSchema.nullable(),
    festivalId: SlugSchema.optional(),
    /** 祭りデータの周辺の場所（NearbySpot）の ID */
    spotId: SlugSchema.optional(),
    sources: z.array(SourceSchema),
    /** この予定が最後に変わった版。画面で、変わった予定に色を付ける */
    changedInVersion: VersionSchema,
  })
  .superRefine((item, ctx) => {
    if (item.type === "festival" && item.festivalId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["festivalId"],
        message: "祭りの予定には festivalId が必要です",
      });
    }
    if ((item.type === "festival" || item.spotId !== undefined) && item.sources.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["sources"],
        message: "祭りや周辺の場所の予定には出典が必要です",
      });
    }
  });

// ---------------------------------------------------------------------------
// 旅全体の情報

/** 開催の再確認の結果：予定どおり / 変更あり / 中止 / 確認できず */
export const VERIFICATION_RESULTS = ["as_planned", "changed", "cancelled", "not_found"] as const;
export const VerificationResultSchema = z.enum(VERIFICATION_RESULTS);

/** 確定前の再確認。予定どおりと言えるのは、確認した出典があるときだけ */
export const VerificationSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pending") }),
  z
    .strictObject({
      status: VerificationResultSchema,
      checkedAt: IsoDateTimeSchema,
      sources: z.array(SourceSchema),
      note: TextSchema.optional(),
    })
    .refine((v) => v.status !== "as_planned" || v.sources.length > 0, {
      path: ["sources"],
      message: "予定どおりと確認するには出典が必要です",
    }),
]);

/** 天気。予報の範囲外の日は not_yet（予報前）、取得できなかったときは unavailable */
export const WeatherSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("forecast"),
    summary: TextSchema,
    precipitationPercent: z.number().int().min(0).max(100).nullable(),
    highC: z.number().nullable(),
    lowC: z.number().nullable(),
    source: SourceSchema,
  }),
  z.strictObject({ status: z.literal("not_yet") }),
  z.strictObject({ status: z.literal("unavailable") }),
]);

/** 主役の祭りに行けないときの代わり：雨の日 / 中止のとき / その他 */
export const AlternativeSchema = z.strictObject({
  kind: z.enum(["rain", "cancelled", "other"]),
  summary: TextSchema,
});

/**
 * 旅程。祭りの開催時間を動かせない予定として先に置き、前後の空き時間を埋める。
 * 修正のたびに版（version）が上がる。
 */
export const ItinerarySchema = z
  .strictObject({
    id: TextSchema,
    version: VersionSchema,
    /** しおりの表紙に出す名前 */
    title: TextSchema.max(40),
    date: IsoDateSchema,
    origin: TextSchema,
    returnTo: TextSchema,
    party: PartySchema,
    preferences: PreferencesSchema,
    mainFestivalId: SlugSchema,
    verification: VerificationSchema,
    weather: WeatherSchema,
    items: z.array(ItineraryItemSchema).min(1),
    /** 持ち物と注意 */
    notes: z.array(TextSchema),
    alternatives: z.array(AlternativeSchema),
  })
  .superRefine((itinerary, ctx) => {
    const ids = itinerary.items.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", path: ["items"], message: "予定の id が重複しています" });
    }
    itinerary.items.forEach((item, index) => {
      if (item.changedInVersion > itinerary.version) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index, "changedInVersion"],
          message: "changedInVersion は旅程の版以下にしてください",
        });
      }
    });
    const hasMainFestival = itinerary.items.some(
      (item) => item.type === "festival" && item.festivalId === itinerary.mainFestivalId,
    );
    if (!hasMainFestival) {
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: "主役の祭り（mainFestivalId）の予定が必要です",
      });
    }
  });

/** 前の版からの差分。追加・変更は予定の ID、削除は ID と名前で持つ */
export const ItineraryDiffSchema = z
  .strictObject({
    /** 0 は初版（前の版がない） */
    fromVersion: z.number().int().min(0),
    toVersion: VersionSchema,
    added: z.array(TextSchema),
    changed: z.array(TextSchema),
    removed: z.array(z.strictObject({ id: TextSchema, name: TextSchema })),
  })
  .refine((diff) => diff.fromVersion < diff.toVersion, {
    path: ["toVersion"],
    message: "toVersion は fromVersion より大きくしてください",
  });

export type Move = z.infer<typeof MoveSchema>;
export type ItineraryItem = z.infer<typeof ItineraryItemSchema>;
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
export type Verification = z.infer<typeof VerificationSchema>;
export type Weather = z.infer<typeof WeatherSchema>;
export type Alternative = z.infer<typeof AlternativeSchema>;
export type Itinerary = z.infer<typeof ItinerarySchema>;
export type ItineraryDiff = z.infer<typeof ItineraryDiffSchema>;

/** 旅程で使った出典を、URL の重複を除いて集める（しおりの「出典」に出す） */
export function collectItinerarySources(itinerary: Itinerary): Source[] {
  const all = [
    ...itinerary.items.flatMap((item) => item.sources),
    ...(itinerary.weather.status === "forecast" ? [itinerary.weather.source] : []),
    ...(itinerary.verification.status === "pending" ? [] : itinerary.verification.sources),
  ];
  const byUrl = new Map<string, Source>();
  for (const source of all) {
    if (!byUrl.has(source.url)) {
      byUrl.set(source.url, source);
    }
  }
  return [...byUrl.values()];
}
