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
import { PlanEvaluationSchema, PlanGapSchema } from "./evaluation";
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

/**
 * 移動の役目。outbound 出発の駅から目的地の駅へ / last_mile 駅から祭りの会場へ（最後の移動）/
 * between 寄り道どうしの移動 / return 帰り（終わりの場所へ）
 */
export const MOVE_PURPOSES = ["outbound", "last_mile", "between", "return"] as const;

/**
 * 移動の1区間（乗り換えまでの1本）。区間の境の駅が乗り換えの駅になる。
 * 路線と区間の所要時間は調べた結果にあるものだけを書き、分からなければ null
 */
export const MoveLegSchema = z.strictObject({
  means: z.enum(MOVE_MEANS),
  from: TextSchema.max(60),
  to: TextSchema.max(60),
  line: TextSchema.max(60).nullable(),
  minutes: MinuteRangeSchema.nullable(),
});

/** 区間の境が同じ場所か。「鈴鳴」と「鈴鳴駅」の書き方の違いでは断らない */
function samePlace(a: string, b: string): boolean {
  const name = (text: string) => text.trim().replace(/駅$/, "");
  return name(a) === name(b);
}

/** 前の予定からの移動。所要時間は必ず目安として扱う */
export const MoveSchema = z
  .strictObject({
    means: z.enum(MOVE_MEANS),
    minutes: MinuteRangeSchema,
    estimate: z.literal(true),
    note: TextSchema.optional(),
    /** 出発の場所（駅・会場・店の名前） */
    from: TextSchema.max(60).optional(),
    /** 到着の場所 */
    to: TextSchema.max(60).optional(),
    purpose: z.enum(MOVE_PURPOSES).optional(),
    /** 乗り換えごとの区間（電車・バスの移動）。区間はつながった順に並べる */
    legs: z.array(MoveLegSchema).min(1).max(6).optional(),
  })
  .superRefine((move, ctx) => {
    const legs = move.legs ?? [];
    legs.forEach((leg, index) => {
      const next = legs[index + 1];
      if (next !== undefined && !samePlace(leg.to, next.from)) {
        ctx.addIssue({
          code: "custom",
          path: ["legs", index + 1, "from"],
          message: "区間は、前の区間の到着の場所から始めてください",
        });
      }
    });
    const first = legs[0];
    const last = legs.at(-1);
    if (first !== undefined && move.from !== undefined && !samePlace(first.from, move.from)) {
      ctx.addIssue({
        code: "custom",
        path: ["legs", 0, "from"],
        message: "最初の区間は、移動の出発の場所から始めてください",
      });
    }
    if (last !== undefined && move.to !== undefined && !samePlace(last.to, move.to)) {
      ctx.addIssue({
        code: "custom",
        path: ["legs", legs.length - 1, "to"],
        message: "最後の区間は、移動の到着の場所で終えてください",
      });
    }
  });

/** 乗り換えの駅（区間の境の場所）。区間がなければ空 */
export function transferStations(move: Pick<Move, "legs">): string[] {
  return (move.legs ?? []).slice(1).map((leg) => leg.from);
}

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

/**
 * 開催の確かめの結果：予定どおり（公式の情報で確認）/ 要事前確認（公式以外の情報源や、公式の例年の日程で確認。
 * 出発の前に主催者の案内で確かめる）/ 変更あり / 中止 / 確認できず（どこからも情報が取れない。提案しない）
 */
export const VERIFICATION_RESULTS = [
  "as_planned",
  "needs_check",
  "changed",
  "cancelled",
  "not_found",
] as const;
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
    .refine(
      (v) => (v.status !== "as_planned" && v.status !== "needs_check") || v.sources.length > 0,
      {
        path: ["sources"],
        message: "予定どおり・要事前確認とするには出典が必要です",
      },
    ),
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
// 宿の候補（宿泊予約の API で調べた空き、または公開の Web で調べた宿）

/** 宿の候補を調べた方法。rakuten 空室検索 API / web 公開の Web の調べ / fictional 架空の宿（開発の見本） */
export const LODGING_PROVIDERS = ["rakuten", "web", "fictional"] as const;

/**
 * 宿を探した観点。venue 会場の近く / station 駅の近く / budget 予算に合う / family 家族向け。
 * Web の調べでは観点ごとに並べて探し、いくつの観点で挙がったかを突き合わせて選ぶ
 */
export const LODGING_PERSPECTIVES = ["venue", "station", "budget", "family"] as const;

/** 会場から宿までの目安。直線の距離からコードで計算する（道のりではない） */
export const LodgingFromVenueSchema = z.strictObject({
  distanceKm: z.number().min(0),
  /** walk 歩いて行ける距離 / ride バス・タクシーなどで移る距離 */
  mode: z.enum(["walk", "ride"]),
  minutes: MinuteRangeSchema,
});

/**
 * 宿の候補の1件。名前と料金は API の結果か、Web の調べで実際に読んだページだけから入れ、モデルに作らせない。
 * 料金は予約の時点で変わることがあるので、調べた時刻（checkedAt）と必ず一緒に出す。
 */
export const LodgingOfferSchema = z.strictObject({
  /** 宿の ID（同じ宿を版をまたいで指すため） */
  id: TextSchema.max(100),
  name: TextSchema.max(100),
  /**
   * 1泊の料金（全員分・円）。空室検索では調べた時点の最安のプランの目安。
   * Web の調べでは空きを確かめていないので null にし、ページにある料金の目安は priceNote・perPersonNightYen に書く
   */
  nightlyTotalYen: z.number().int().min(0).nullable(),
  /** ページに書かれた1泊1人あたりの料金の幅（円）。書かれていなければ持たない */
  perPersonNightYen: z
    .tuple([z.number().int().min(0), z.number().int().min(0)])
    .refine(([min, max]) => min <= max, { message: "料金の幅は下限 ≦ 上限にしてください" })
    .optional(),
  /** 料金の目安の文（自分の言葉。例：素泊まり1人6,000円台から） */
  priceNote: TextSchema.max(80).optional(),
  /** 宿の特徴の要約（自分の言葉で1文） */
  summary: TextSchema.max(120).optional(),
  /** 予約のページ（Web の調べでは、宿の公式か予約サイトの宿のページ） */
  bookingUrl: z.url({ protocol: /^https?$/ }),
  /** 地図に打つ場所。分からなければ null */
  location: LatLngSchema.nullable(),
  /** 会場からの距離と移動の目安（コードで計算）。場所が分からなければ持たない */
  fromVenue: LodgingFromVenueSchema.optional(),
  /** この宿が挙がった観点（Web の調べ） */
  perspectives: z.array(z.enum(LODGING_PERSPECTIVES)).max(LODGING_PERSPECTIVES.length).optional(),
  /** 調べた時刻 */
  checkedAt: IsoDateTimeSchema,
  /** 出典（予約サイトや宿のページ。表示が求められるクレジットは title に書く） */
  source: SourceSchema,
});

/** 宿の候補を調べた結果。offers が空なら、条件に合う宿がなかった */
export const LodgingSearchSchema = z
  .strictObject({
    checkIn: IsoDateSchema,
    checkOut: IsoDateSchema,
    /** 調べた時刻 */
    searchedAt: IsoDateTimeSchema,
    /** 調べた方法。古い版の旅程にはない */
    provider: z.enum(LODGING_PROVIDERS).optional(),
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

// ---------------------------------------------------------------------------
// 食事・帰りの最終・調べの採否

/** 食事の時間帯。lunch 昼 / dinner 夜 */
export const MEAL_SLOTS = ["lunch", "dinner"] as const;

/** 食事の案の種類。shop 店 / stalls 祭りの会場の屋台 / station 駅や道中で買う / bring 持っていく */
export const MEAL_PLAN_KINDS = ["shop", "stalls", "station", "bring"] as const;

/**
 * 滞在の時間帯にかかる食事（昼・夜）ごとの案。店の予定（type: meal）のほかに、
 * 祭りの最中に屋台で食べるなど、ほかの予定の中でとる食事もここに書く
 */
export const MealPlanSchema = z
  .strictObject({
    slot: z.enum(MEAL_SLOTS),
    kind: z.enum(MEAL_PLAN_KINDS),
    /** 店の名前か、案の短い説明（例：会場の屋台で鈴鳴焼き） */
    name: TextSchema.max(60),
    /** この食事をとる予定の id（店の予定、または祭りの予定など）。予定の外なら null */
    itemId: TextSchema.nullable(),
    /** 店の場所の ID（祭りのデータの周辺の場所か、周辺係が調べた場所） */
    spotId: SlugSchema.optional(),
    sources: z.array(SourceSchema),
  })
  .refine((meal) => (meal.kind !== "shop" && meal.kind !== "stalls") || meal.sources.length > 0, {
    path: ["sources"],
    message: "店や屋台の食事の案には出典が必要です",
  });

/**
 * 帰りの最終の目安。乗る駅と、そこを出る最終の時刻。調べて分からなければ departBy を null にする
 * （その日の不足 last_return_unknown になる）
 */
export const LastReturnSchema = z
  .strictObject({
    /** 帰りに乗る駅 */
    station: TextSchema.max(60),
    /** この時刻までに乗る（最終の目安） */
    departBy: LocalTimeSchema.nullable(),
    note: TextSchema.max(120).optional(),
    sources: z.array(SourceSchema),
  })
  .refine((last) => last.departBy === null || last.sources.length > 0, {
    path: ["sources"],
    message: "最終の時刻を書くときは出典が必要です",
  });

/** 旅程の1日。stay が null の日は、その日のうちに帰る（旅の最後の日は必ず null） */
export const ItineraryDaySchema = z.strictObject({
  date: IsoDateSchema,
  weather: WeatherSchema,
  items: z.array(ItineraryItemSchema).min(1),
  stay: StaySchema.nullable(),
  /** 滞在の時間帯にかかる食事の案。古い版の旅程にはない */
  meals: z.array(MealPlanSchema).max(4).optional(),
  /** 帰りの最終の目安（その日のうちに帰る日）。古い版の旅程にはない */
  lastReturn: LastReturnSchema.nullable().optional(),
});

/** 調べた場所を見つけた係。nearby 周辺係 / lodging 宿の係 */
export const CONSIDERED_FROM = ["nearby", "lodging"] as const;

/**
 * 周辺係・宿の係が見つけた場所の採否。採ったか（adopted）は旅程の予定と宿の候補からサーバーが決め、
 * 理由は旅程係が書く（採らなかったときは、なぜ採らなかったか）
 */
export const ConsideredPlaceSchema = z.strictObject({
  /** 場所の ID（周辺の場所の spotId か、宿の候補の id） */
  id: TextSchema.max(100),
  name: TextSchema.max(100),
  from: z.enum(CONSIDERED_FROM),
  adopted: z.boolean(),
  reason: TextSchema.max(120),
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
    /** 周辺係・宿の係が見つけた場所の採否と理由。古い版の旅程にはない */
    considered: z.array(ConsideredPlaceSchema).max(40).optional(),
    /** 点検で見つかった不足（サーバーがコードで決める）。古い版の旅程にはない */
    gaps: z.array(PlanGapSchema).max(40).optional(),
    /** 評価係の採点（サーバーが付ける）。古い版の旅程にはない */
    evaluation: PlanEvaluationSchema.optional(),
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
      const itemIds = new Set(day.items.map((item) => item.id));
      day.meals?.forEach((meal, mealIndex) => {
        if (meal.itemId !== null && !itemIds.has(meal.itemId)) {
          ctx.addIssue({
            code: "custom",
            path: ["days", index, "meals", mealIndex, "itemId"],
            message: "食事の itemId は、その日の予定の id にしてください",
          });
        }
      });
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
export type MoveLeg = z.infer<typeof MoveLegSchema>;
export type MovePurpose = (typeof MOVE_PURPOSES)[number];
export type MealSlot = (typeof MEAL_SLOTS)[number];
export type MealPlanKind = (typeof MEAL_PLAN_KINDS)[number];
export type MealPlan = z.infer<typeof MealPlanSchema>;
export type LastReturn = z.infer<typeof LastReturnSchema>;
export type ConsideredPlace = z.infer<typeof ConsideredPlaceSchema>;
export type ItineraryItem = z.infer<typeof ItineraryItemSchema>;
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
export type Verification = z.infer<typeof VerificationSchema>;
export type Weather = z.infer<typeof WeatherSchema>;
export type Alternative = z.infer<typeof AlternativeSchema>;
export type LodgingOffer = z.infer<typeof LodgingOfferSchema>;
export type LodgingFromVenue = z.infer<typeof LodgingFromVenueSchema>;
export type LodgingPerspective = (typeof LODGING_PERSPECTIVES)[number];
export type LodgingProvider = (typeof LODGING_PROVIDERS)[number];
export type LodgingSearch = z.infer<typeof LodgingSearchSchema>;
export type StayPlan = z.infer<typeof StayPlanSchema>;
export type Stay = z.infer<typeof StaySchema>;
export type ItineraryDay = z.infer<typeof ItineraryDaySchema>;
export type Itinerary = z.infer<typeof ItinerarySchema>;
export type ItineraryDiff = z.infer<typeof ItineraryDiffSchema>;

/**
 * 場所を Google マップで開く URL。店や宿の名前と位置から作る（Google のデータは使わず、キーも要らない）。
 * 名前だけでは同じ名前の別の店に当たることがあるので、位置を添える
 */
export function googleMapsUrl(place: {
  name: string;
  location: { lat: number; lng: number };
}): string {
  const query = `${place.name} ${place.location.lat},${place.location.lng}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/** 旅程で使った出典（予定・天気・再確認・宿の候補・食事・帰りの最終）を、URL の重複を除いて集める（しおりの「出典」に出す） */
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
    ...itinerary.days.flatMap((day) => day.meals?.flatMap((meal) => meal.sources) ?? []),
    ...itinerary.days.flatMap((day) => day.lastReturn?.sources ?? []),
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
