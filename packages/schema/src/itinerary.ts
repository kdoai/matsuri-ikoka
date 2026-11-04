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
import { PartySchema, PreferencesSchema, TripBudgetSchema } from "./preferences";

const TextSchema = z.string().min(1);
const VersionSchema = z.number().int().min(1);

// ---------------------------------------------------------------------------
// 予定（旅程の1行）

/**
 * 予定の種類。
 * move 移動 / sightseeing 観光 / meal 食事 / rest 休憩 /
 * festival_prep 祭りの前の準備（到着の余裕・場所取り・申し込み）/ festival 祭り /
 * free 自由に過ごす時間（データとツールの結果に行き先がないとき。場所は作らない）
 */
export const ITINERARY_ITEM_TYPES = [
  "move",
  "sightseeing",
  "meal",
  "rest",
  "festival_prep",
  "festival",
  "free",
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
    if (item.type === "free" && (item.location !== null || item.spotId !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["location"],
        message: "自由に過ごす時間には、場所（location・spotId）を付けません",
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

/** 旅程の日数の上限（6泊7日） */
export const MAX_TRIP_DAYS = 7;

// ---------------------------------------------------------------------------
// 宿の空き（宿泊予約の API で調べた結果）

/**
 * 空きのあった宿の1件。名前と料金は API の結果だけから入れ、モデルに作らせない。
 * 料金は予約の時点で変わることがあるので、調べた時刻（checkedAt）と必ず一緒に出す。
 */
export const LodgingOfferSchema = z.strictObject({
  /** 予約サイトでの宿の ID（同じ宿を版をまたいで指すため） */
  id: TextSchema.max(100),
  name: TextSchema.max(100),
  /** 1泊の料金（全員分・円）。調べた時点の最安のプランの目安 */
  nightlyTotalYen: z.number().int().min(0),
  /** 予約のページ */
  bookingUrl: z.url({ protocol: /^https?$/ }),
  /** 地図に打つ場所。API に位置がなければ null */
  location: LatLngSchema.nullable(),
  /** 調べた時刻 */
  checkedAt: IsoDateTimeSchema,
  /** 出典（予約サイト。表示が求められるクレジットは title に書く） */
  source: SourceSchema,
});

/** 宿の空きを調べた結果。offers が空なら、条件に合う空きがなかった */
export const LodgingSearchSchema = z
  .strictObject({
    checkIn: IsoDateSchema,
    checkOut: IsoDateSchema,
    /** 調べた時刻 */
    searchedAt: IsoDateTimeSchema,
    offers: z.array(LodgingOfferSchema).max(5),
  })
  .refine((search) => search.checkIn < search.checkOut, {
    path: ["checkOut"],
    message: "チェックアウトはチェックインより後の日にしてください",
  });

/**
 * その夜に泊まるところのうち、接客で書く部分。泊まる地域と注意だけで、宿の名前は持たない
 * （ツールの結果にない宿の名前を作らないため）
 */
export const StayPlanSchema = z.strictObject({
  /** 泊まる地域（例：奈良市の中心部） */
  area: TextSchema,
  note: TextSchema.optional(),
});

/**
 * その夜に泊まるところ。宿の候補（lodging）は、宿の空きを調べたツールの結果をサーバーが付ける。
 * 候補がないときは、泊まる地域と注意だけを案内する
 */
export const StaySchema = StayPlanSchema.extend({
  lodging: LodgingSearchSchema.optional(),
});

/** 旅程の1日。stay が null の日は、その日のうちに帰る（旅の最後の日は必ず null） */
export const ItineraryDaySchema = z.strictObject({
  date: IsoDateSchema,
  weather: WeatherSchema,
  items: z.array(ItineraryItemSchema).min(1),
  stay: StaySchema.nullable(),
});

/** YYYY-MM-DD の次の日 */
function nextDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * 旅程。日帰りのお出かけ（1日）から6泊7日までを、続いた日付の日ごとの予定で持つ。
 * 祭りの開催時間を動かせない予定として先に置き、前後の空き時間を埋める。
 * 修正のたびに版（version）が上がる。
 */
export const ItinerarySchema = z
  .strictObject({
    id: TextSchema,
    version: VersionSchema,
    /** しおりの表紙に出す名前 */
    title: TextSchema.max(40),
    origin: TextSchema,
    returnTo: TextSchema,
    party: PartySchema,
    preferences: PreferencesSchema,
    /** 旅の予算の上限（聞き取った条件をサーバーが付ける）。言われていなければない */
    budget: TripBudgetSchema.optional(),
    /** 主役の祭り。どこかの日に必ず予定がある。ほかの日に別の祭りを入れてもよい */
    mainFestivalId: SlugSchema,
    verification: VerificationSchema,
    days: z.array(ItineraryDaySchema).min(1).max(MAX_TRIP_DAYS),
    /** 持ち物と注意 */
    notes: z.array(TextSchema),
    alternatives: z.array(AlternativeSchema),
  })
  .superRefine((itinerary, ctx) => {
    const { days } = itinerary;
    days.forEach((day, index) => {
      const previous = days[index - 1];
      if (previous !== undefined && day.date !== nextDate(previous.date)) {
        ctx.addIssue({
          code: "custom",
          path: ["days", index, "date"],
          message: "日付は1日ずつ続けてください",
        });
      }
      if (day.stay?.lodging !== undefined && day.stay.lodging.checkIn !== day.date) {
        ctx.addIssue({
          code: "custom",
          path: ["days", index, "stay", "lodging", "checkIn"],
          message: "宿の候補のチェックインは、その日の日付にしてください",
        });
      }
      if (index === days.length - 1 && day.stay !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["days", index, "stay"],
          message: "最後の日は帰る日なので、stay を null にしてください",
        });
      }
      day.items.forEach((item, itemIndex) => {
        if (item.changedInVersion > itinerary.version) {
          ctx.addIssue({
            code: "custom",
            path: ["days", index, "items", itemIndex, "changedInVersion"],
            message: "changedInVersion は旅程の版以下にしてください",
          });
        }
      });
    });
    const items = days.flatMap((day) => day.items);
    const ids = items.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: "custom",
        path: ["days"],
        message: "予定の id は旅程全体で重ならないようにしてください",
      });
    }
    const hasMainFestival = items.some(
      (item) => item.type === "festival" && item.festivalId === itinerary.mainFestivalId,
    );
    if (!hasMainFestival) {
      ctx.addIssue({
        code: "custom",
        path: ["days"],
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
export type LodgingOffer = z.infer<typeof LodgingOfferSchema>;
export type LodgingSearch = z.infer<typeof LodgingSearchSchema>;
export type StayPlan = z.infer<typeof StayPlanSchema>;
export type Stay = z.infer<typeof StaySchema>;
export type ItineraryDay = z.infer<typeof ItineraryDaySchema>;
export type Itinerary = z.infer<typeof ItinerarySchema>;
export type ItineraryDiff = z.infer<typeof ItineraryDiffSchema>;

/** 旅程で使った出典（予定・天気・再確認・宿の候補）を、URL の重複を除いて集める（しおりの「出典」に出す） */
export function collectItinerarySources(itinerary: Itinerary): Source[] {
  const all = [
    ...itineraryItems(itinerary).flatMap((item) => item.sources),
    ...itinerary.days.flatMap((day) =>
      day.weather.status === "forecast" ? [day.weather.source] : [],
    ),
    ...(itinerary.verification.status === "pending" ? [] : itinerary.verification.sources),
    ...itinerary.days.flatMap(
      (day) => day.stay?.lodging?.offers.map((offer) => offer.source) ?? [],
    ),
  ];
  const byUrl = new Map<string, Source>();
  for (const source of all) {
    if (!byUrl.has(source.url)) {
      byUrl.set(source.url, source);
    }
  }
  return [...byUrl.values()];
}

/** 旅程のすべての予定（日の順・時刻の順） */
export function itineraryItems(itinerary: Pick<Itinerary, "days">): ItineraryItem[] {
  return itinerary.days.flatMap((day) => day.items);
}

/** 旅程の泊数（日数 − 1）。0 は日帰り・お出かけ */
export function itineraryNights(itinerary: Pick<Itinerary, "days">): number {
  return itinerary.days.length - 1;
}

/** 主役の祭りの予定がある日。見つからなければ最初の日 */
export function mainFestivalDay(
  itinerary: Pick<Itinerary, "days" | "mainFestivalId">,
): ItineraryDay {
  return (
    itinerary.days.find((day) =>
      day.items.some(
        (item) => item.type === "festival" && item.festivalId === itinerary.mainFestivalId,
      ),
    ) ?? (itinerary.days[0] as ItineraryDay)
  );
}
