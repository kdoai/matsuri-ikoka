import { z } from "zod";
import {
  IsoDateSchema,
  LatLngSchema,
  LocalTimeSchema,
  MinuteRangeSchema,
  OpeningHoursSchema,
  orUnknown,
  SlugSchema,
  SourceSchema,
  strongestConfidence,
  UNKNOWN,
  WeekdaySchema,
} from "./common";

const TextSchema = z.string().min(1);
const TextListSchema = z.array(TextSchema).min(1);

export const PREFECTURES = [
  "北海道",
  "青森県",
  "岩手県",
  "宮城県",
  "秋田県",
  "山形県",
  "福島県",
  "茨城県",
  "栃木県",
  "群馬県",
  "埼玉県",
  "千葉県",
  "東京都",
  "神奈川県",
  "新潟県",
  "富山県",
  "石川県",
  "福井県",
  "山梨県",
  "長野県",
  "岐阜県",
  "静岡県",
  "愛知県",
  "三重県",
  "滋賀県",
  "京都府",
  "大阪府",
  "兵庫県",
  "奈良県",
  "和歌山県",
  "鳥取県",
  "島根県",
  "岡山県",
  "広島県",
  "山口県",
  "徳島県",
  "香川県",
  "愛媛県",
  "高知県",
  "福岡県",
  "佐賀県",
  "長崎県",
  "熊本県",
  "大分県",
  "宮崎県",
  "鹿児島県",
  "沖縄県",
] as const;
export const PrefectureSchema = z.enum(PREFECTURES);

/** 開催地の市町村。川をはさむ祭りなど、都道府県をまたぐこともある */
export const MunicipalitySchema = z.strictObject({
  prefecture: PrefectureSchema,
  name: TextSchema,
});

/**
 * 祭りの種類。
 * fireworks 花火 / float 山車・曳山・だんじり / mikoshi 神輿・行列 / dance 踊り / fire 火祭り /
 * lantern 灯籠・提灯 / performing_arts 神楽・獅子舞などの芸能 / ritual 神事 / market 市・縁日 / other その他
 */
export const FESTIVAL_CATEGORIES = [
  "fireworks",
  "float",
  "mikoshi",
  "dance",
  "fire",
  "lantern",
  "performing_arts",
  "ritual",
  "market",
  "other",
] as const;

/**
 * 規模ランク。打ち上げ数や山車の数で決め、来場者数の公表値は参考にとどめる。
 * 会場への到着の余裕（XS・S：15分、M：30分、L：60分）の初期値に使う
 */
export const SCALE_TIERS = ["XS", "S", "M", "L"] as const;

/**
 * 知名度。大手の観光サイトに載っている数から付ける。
 * major 多くに載る（定番）/ regional 一部に載る / local ほとんど載っていない（穴場）
 */
export const POPULARITY_LEVELS = ["major", "regional", "local"] as const;
export const PopularitySchema = z.enum(POPULARITY_LEVELS);

// ---------------------------------------------------------------------------
// 作法（作法の壁）

/** 見学だけか、だれでも加われるか、申し込みが必要か */
export const PARTICIPATION_TYPES = ["watch_only", "join_open", "join_by_application"] as const;
export const RISK_LEVELS = ["low", "medium", "high"] as const;
/** 写真：allowed 撮ってよい / restricted 場所や場面に制限がある / prohibited 撮らない */
export const PHOTO_POLICIES = ["allowed", "restricted", "prohibited"] as const;

/** しおりの「はじめての方へ」に出す作法の項目 */
export const ETIQUETTE_ITEMS = [
  "participation",
  "howToJoin",
  "rules",
  "dress",
  "bring",
  "risk",
  "photo",
] as const;
export type EtiquetteItem = (typeof ETIQUETTE_ITEMS)[number];

/**
 * 作法。どの項目も省略できず、値か "unknown" を必ず書く。
 * howToJoin だけは、見学のみの祭りでは当てはまらないので null にする。
 */
export const EtiquetteSchema = z
  .strictObject({
    participation: z.enum([...PARTICIPATION_TYPES, UNKNOWN]),
    howToJoin: orUnknown(TextSchema).nullable(),
    rules: orUnknown(TextListSchema),
    dress: orUnknown(TextListSchema),
    bring: orUnknown(TextListSchema),
    risk: orUnknown(z.strictObject({ level: z.enum(RISK_LEVELS), reason: TextSchema })),
    photo: orUnknown(
      z.strictObject({ policy: z.enum(PHOTO_POLICIES), note: TextSchema.optional() }),
    ),
    sources: z.array(SourceSchema),
  })
  .superRefine((etiquette, ctx) => {
    if (etiquette.participation === "watch_only" && etiquette.howToJoin !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["howToJoin"],
        message: "見学のみの祭りでは howToJoin を null にしてください",
      });
    }
    if (etiquette.participation === "join_by_application" && etiquette.howToJoin === null) {
      ctx.addIssue({
        code: "custom",
        path: ["howToJoin"],
        message: "申し込みが必要な祭りでは、申し込み方法か unknown を書いてください",
      });
    }
    const hasKnownItem = ETIQUETTE_ITEMS.some(
      (item) => etiquette[item] !== UNKNOWN && etiquette[item] !== null,
    );
    if (hasKnownItem && etiquette.sources.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["sources"],
        message: "分かっている作法には出典が必要です",
      });
    }
  });

/** "unknown" の作法の項目を返す。しおりで「不明」と出す項目や、埋まっている割合の計算に使う */
export function unknownEtiquetteItems(
  etiquette: Pick<z.infer<typeof EtiquetteSchema>, EtiquetteItem>,
): EtiquetteItem[] {
  return ETIQUETTE_ITEMS.filter((item) => etiquette[item] === UNKNOWN);
}

// ---------------------------------------------------------------------------
// 開催回（年ごとに変わる情報）

/**
 * 開催の状態。
 * announced 今回の日付が年つきで発表されている（確かさは出典の確度で見る）/
 * expected 例年の決まりや傾向からの見込み（今回の日付の発表は未確認）/
 * postponed 延期 / cancelled 中止
 */
export const OCCURRENCE_STATUSES = ["announced", "expected", "postponed", "cancelled"] as const;

/** 1回の開催。分からない時刻や雨天の扱いは推測で埋めず、null にして gaps に書く */
export const OccurrenceSchema = z
  .strictObject({
    date: IsoDateSchema,
    endDate: IsoDateSchema.optional(),
    start: LocalTimeSchema.nullable(),
    end: LocalTimeSchema.nullable(),
    status: z.enum(OCCURRENCE_STATUSES),
    rainPolicy: TextSchema.nullable(),
    note: TextSchema.optional(),
    sources: z.array(SourceSchema).min(1),
  })
  .refine((o) => o.endDate === undefined || o.endDate >= o.date, {
    path: ["endDate"],
    message: "endDate は date 以降にしてください",
  });

/** 開催が確かめられているか。発表済みで、公式か複数の情報源で確認できたものだけ */
export function isOccurrenceConfirmed(occurrence: z.infer<typeof OccurrenceSchema>): boolean {
  const confidence = strongestConfidence(occurrence.sources);
  return (
    occurrence.status === "announced" &&
    (confidence === "official" || confidence === "corroborated")
  );
}

// ---------------------------------------------------------------------------
// アクセス・食・周辺

/** 会場へのアクセス。所要時間はどれも目安として幅で持つ */
export const AccessSchema = z
  .strictObject({
    /** 最寄り駅と、駅から会場までの徒歩 */
    stations: z.array(
      z.strictObject({
        name: TextSchema,
        walkMinutes: MinuteRangeSchema,
        note: TextSchema.optional(),
      }),
    ),
    /** 主要駅から最寄り駅までの所要時間 */
    fromHubs: z.array(
      z.strictObject({
        hub: TextSchema,
        minutes: MinuteRangeSchema,
        route: TextSchema.optional(),
      }),
    ),
    parking: z.enum(["available", "limited", "none", UNKNOWN]),
    trafficRestrictions: z.array(TextSchema),
    sources: z.array(SourceSchema),
  })
  .refine(
    (a) =>
      a.sources.length > 0 ||
      (a.stations.length === 0 &&
        a.fromHubs.length === 0 &&
        a.parking === UNKNOWN &&
        a.trafficRestrictions.length === 0),
    { path: ["sources"], message: "アクセスの情報には出典が必要です" },
  );

/** 地元の味。店や料理の要約だけを持ち、文章や画像はコピーしない */
export const FoodSchema = z.strictObject({
  stalls: z.enum(["yes", "no", UNKNOWN]),
  local: z.array(
    z.strictObject({
      name: TextSchema,
      note: TextSchema.optional(),
      sources: z.array(SourceSchema).min(1),
    }),
  ),
});

export const NEARBY_KINDS = ["sightseeing", "food", "rest"] as const;
export const NEARBY_TAGS = [
  "kid_friendly",
  "senior_friendly",
  "indoor",
  "seating",
  "local_food",
] as const;

/** 祭りの前後に寄れる観光・食・休憩の場所。分からない営業時間や休業日は null にする */
export const NearbySpotSchema = z.strictObject({
  id: SlugSchema,
  name: TextSchema,
  kind: z.enum(NEARBY_KINDS),
  summary: TextSchema.max(120),
  location: LatLngSchema,
  walkMinutesFromVenue: MinuteRangeSchema.nullable(),
  hours: OpeningHoursSchema.nullable(),
  /** 定休日。定休日がなければ空の配列 */
  closedDays: z.array(WeekdaySchema).nullable(),
  price: TextSchema.nullable(),
  tags: z.array(z.enum(NEARBY_TAGS)),
  popularity: PopularitySchema,
  sources: z.array(SourceSchema).min(1),
});

/** 待ち時間に出す小話。60字以内で、出典を必ず付ける */
export const TRIVIA_MAX_LENGTH = 60;
export const TriviaSchema = z.strictObject({
  text: TextSchema.max(TRIVIA_MAX_LENGTH),
  source: SourceSchema,
});

/**
 * 祭りの性格（祭りから探すときの種類に使う）。
 * traditional 由来や文化財の指定など、受け継がれてきたことが出典で分かる /
 * community 氏子や町内など、地元の人が担っていることが出典で分かる
 */
export const FESTIVAL_STYLES = ["traditional", "community"] as const;

/** 祭りの性格と、そう言える根拠。出典で確かめられるものだけを書き、分からなければ書かない */
export const FestivalStyleSchema = z.strictObject({
  style: z.enum(FESTIVAL_STYLES),
  /** 根拠の要約（60字まで）。画面の理由にも使う */
  basis: TextSchema.max(60),
  sources: z.array(SourceSchema).min(1),
});

// ---------------------------------------------------------------------------
// 祭り（1件1ファイル：data/festivals/{id}.json）

export const FestivalSchema = z
  .strictObject({
    id: SlugSchema,
    name: z.strictObject({ ja: TextSchema, en: TextSchema.optional() }),
    category: z.enum(FESTIVAL_CATEGORIES),
    municipalities: z.array(MunicipalitySchema).min(1),
    venue: z.strictObject({ name: TextSchema, ...LatLngSchema.shape }),
    scaleTier: z.enum(SCALE_TIERS),
    popularity: PopularitySchema,
    /** 載っている大手の観光サイト（例：walkerplus） */
    listedIn: z.array(SlugSchema),
    highlights: TextListSchema,
    /** 祭りの性格。まだ調べていなければ空の並び */
    styles: z.array(FestivalStyleSchema).default([]),
    trivia: z.array(TriviaSchema),
    etiquette: EtiquetteSchema,
    occurrences: z.array(OccurrenceSchema).min(1),
    access: AccessSchema,
    food: FoodSchema,
    nearby: z.array(NearbySpotSchema),
    /** 祭りそのもの（名前・会場・種類）の出典 */
    sources: z.array(SourceSchema).min(1),
    /** 調べても分からなかったこと。推測で埋めずにここへ書く */
    gaps: z.array(TextSchema),
    /** 祭りを運営する方から掲載停止の依頼があった。true のものは検索に出さない */
    optOut: z.boolean().default(false),
  })
  .superRefine((festival, ctx) => {
    const dates = festival.occurrences.map((o) => o.date);
    if (new Set(dates).size !== dates.length) {
      ctx.addIssue({
        code: "custom",
        path: ["occurrences"],
        message: "同じ日の開催回が重複しています",
      });
    }
    const spotIds = festival.nearby.map((s) => s.id);
    if (new Set(spotIds).size !== spotIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["nearby"],
        message: "周辺の場所の id が重複しています",
      });
    }
  });

export type Prefecture = z.infer<typeof PrefectureSchema>;
export type Municipality = z.infer<typeof MunicipalitySchema>;
export type Popularity = z.infer<typeof PopularitySchema>;
export type Etiquette = z.infer<typeof EtiquetteSchema>;
export type Occurrence = z.infer<typeof OccurrenceSchema>;
export type Access = z.infer<typeof AccessSchema>;
export type Food = z.infer<typeof FoodSchema>;
export type NearbySpot = z.infer<typeof NearbySpotSchema>;
export type Trivia = z.infer<typeof TriviaSchema>;
export type FestivalStyle = z.infer<typeof FestivalStyleSchema>;
export type Festival = z.infer<typeof FestivalSchema>;
/** JSON ファイルに書く形（optOut を省略できる） */
export type FestivalInput = z.input<typeof FestivalSchema>;
