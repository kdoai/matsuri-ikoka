import { z } from "zod";
import { IsoDateSchema, SessionIdSchema, SlugSchema } from "./common";
import { FestivalCandidateSchema } from "./events";
import { FESTIVAL_CATEGORIES, PrefectureSchema } from "./festival";
import { MAX_ROUTE_AREAS, NightsSchema, PACES } from "./preferences";

// 祭りから探す相談（docs/spec/festival-search.md）。
// 種類・季節・地域は、コードで必ず守る条件にする。自由記述は並び順にだけ効かせ、祭りの有無を変えない。
// 祭りを決めて旅程を組むときは、選んだ祭りを必ず行く場所（アンカー）として固定する。

const TextSchema = z.string().min(1);

/**
 * 祭りの探し方の種類。
 * fireworks 花火 / community 地域の祭り / traditional 伝統的な祭り / participatory 参加型の祭り /
 * hidden マイナーなお祭り / famous メジャーなお祭り。
 * 空の並びは「おまかせ」（種類で絞らない）
 */
export const FESTIVAL_KINDS = [
  "fireworks",
  "community",
  "traditional",
  "participatory",
  "hidden",
  "famous",
] as const;
export const FestivalKindSchema = z.enum(FESTIVAL_KINDS);

/** 季節。春は3〜5月、夏は6〜8月、秋は9〜11月、冬は12〜2月。null は「おまかせ」（季節で絞らない） */
export const SEASONS = ["spring", "summer", "autumn", "winter"] as const;
export const SeasonSchema = z.enum(SEASONS);

/** 一度に出す祭りの数の上限 */
export const MAX_FESTIVAL_RESULTS = 6;
/** 自由記述の長さの上限（文字） */
export const MAX_FESTIVAL_WISH_LENGTH = 200;
/** 「別の祭りを提案してもらう」で、出さない祭りとして渡せる数の上限 */
export const MAX_EXCLUDED_FESTIVALS = 240;

/** 探す条件（次の手で変える条件と、同じ形） */
export const FestivalSearchConditionsSchema = z.strictObject({
  /** 種類。軸（ジャンル・参加・知名度）の中はどれかに合えばよく、軸どうしはすべて合う祭りを出す */
  kinds: z.array(FestivalKindSchema).max(FESTIVAL_KINDS.length),
  season: SeasonSchema.nullable(),
  /** 地域。空の並びは全国 */
  prefectures: z.array(PrefectureSchema).max(47),
});

/** POST /api/festivals/search の本文 */
export const FestivalSearchRequestSchema = FestivalSearchConditionsSchema.extend({
  sessionId: SessionIdSchema,
  /** その他の希望条件（自由記述）。並び順にだけ効かせる */
  wish: z.string().trim().max(MAX_FESTIVAL_WISH_LENGTH).optional(),
  /** すでに見せた祭り。「別の祭りを提案してもらう」で渡す */
  excludeIds: z.array(SlugSchema).max(MAX_EXCLUDED_FESTIVALS).default([]),
});

/** 自由記述に対して、その祭りがどれくらい合うか：合う / 一部合う / 合うと言えない。自由記述がなければ null */
export const FESTIVAL_WISH_FITS = ["matched", "partial", "none"] as const;

/** 探した結果の1件。理由はコードで作るか、モデルの文を祭りのデータと照らして通したものだけ */
export const FestivalSearchResultSchema = z.strictObject({
  candidate: FestivalCandidateSchema,
  /** 合った種類 */
  matchedKinds: z.array(FestivalKindSchema),
  /** この祭りを出した理由（短い文） */
  reasons: z.array(TextSchema).max(3),
  wishFit: z.enum(FESTIVAL_WISH_FITS).nullable(),
});

/** 条件のうち1つだけ外れる祭り。外れている点を添えて、候補とは分けて出す */
export const FestivalNearMatchSchema = z.strictObject({
  result: FestivalSearchResultSchema,
  /** 外れている点（コードで決まった型で作る） */
  miss: TextSchema,
});

/**
 * 見つからないとき、見終えたときの次の手：季節を問わない / 種類を問わない / 隣の県まで / 全国 / 条件を選び直す
 */
export const FESTIVAL_SEARCH_NEXT_KINDS = [
  "any_season",
  "any_kind",
  "neighbor_area",
  "nationwide",
  "edit_conditions",
] as const;

export const FestivalSearchNextSchema = z
  .strictObject({
    kind: z.enum(FESTIVAL_SEARCH_NEXT_KINDS),
    label: TextSchema,
    /** 変えたあとの条件。条件を選び直す手は null */
    conditions: FestivalSearchConditionsSchema.nullable(),
    /** 変えた条件で、まだ見せていない祭りの数（コードで数える）。条件を選び直す手は null */
    found: z.number().int().nonnegative().nullable(),
  })
  .superRefine((next, ctx) => {
    if ((next.kind === "edit_conditions") !== (next.conditions === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["conditions"],
        message: "条件を選び直す手だけ、conditions を null にします",
      });
    }
  });

/** 自由記述をどう受け取って探したか。画面に出し、違っていたら書き直せるようにする */
export const FestivalWishReadingSchema = z.strictObject({
  /** 受け取った内容の短い文 */
  text: TextSchema,
  /** model モデルで読んだ / words 言葉の辞書で読んだ（モデルが使えないとき） */
  by: z.enum(["model", "words"]),
});

/** POST /api/festivals/search の応答 */
export const FestivalSearchResponseSchema = z.strictObject({
  results: z.array(FestivalSearchResultSchema).max(MAX_FESTIVAL_RESULTS),
  /** 条件にすべて合う祭りのうち、まだ見せていない数（今回の results を除く） */
  remaining: z.number().int().nonnegative(),
  /** results が空のときの、条件を1つだけ外せば出る祭り */
  nearMatches: z.array(FestivalNearMatchSchema).max(MAX_FESTIVAL_RESULTS),
  /** 次の手。remaining が 0 のときに出す（最後に「条件を選び直す」） */
  next: z.array(FestivalSearchNextSchema).max(5),
  /** 自由記述の受け取り方。自由記述がなければ null */
  reading: FestivalWishReadingSchema.nullable(),
});

/**
 * 自由記述をモデルで読んだ結果。どの項目も並び順にだけ効かせ、祭りのデータの値は変えない。
 * 祭りの日時や有無をモデルに決めさせない
 */
export const FestivalWishIntentSchema = z.strictObject({
  /** 受け取った内容の短い文（40字まで） */
  summary: TextSchema.max(40),
  categories: z.array(z.enum(FESTIVAL_CATEGORIES)).max(FESTIVAL_CATEGORIES.length),
  /** 祭りのデータの文に当てる言葉（言い換えを含む） */
  terms: z.array(TextSchema.max(20)).max(16),
  /** 避けたいことを表す言葉 */
  avoidTerms: z.array(TextSchema.max(20)).max(8),
  /** 希望の月（1〜12）。言われたときだけ */
  months: z.array(z.number().int().min(1).max(12)).max(12),
  prefectures: z.array(PrefectureSchema).max(47),
  /** 自分も加わりたいと言ったとき true */
  wantsToJoin: z.boolean(),
});

// ---------------------------------------------------------------------------
// 祭りを決めたあとの旅程（選んだ祭りを必ず行く場所にする）

/** 必ず行く祭りと、行く日。行く日は祭りのデータの開催回の中の日だけ */
export const TripAnchorSchema = z
  .strictObject({
    festivalId: SlugSchema,
    date: IsoDateSchema,
    /** 利用者が決めた旅の初日。なければ、回る順からコードで決める */
    startDate: IsoDateSchema.optional(),
  })
  .refine((anchor) => anchor.startDate === undefined || anchor.startDate <= anchor.date, {
    path: ["startDate"],
    message: "旅の初日は、祭りの日以前にしてください",
  });

/**
 * 寄りたい場所の扱い。
 * included 旅程に入れる / maybe 時間に余裕があれば入れる / dropped 今回は外す（理由を添える）
 */
export const ANCHOR_VISIT_STATUSES = ["included", "maybe", "dropped"] as const;

export const AnchorVisitSchema = z.strictObject({
  /** 利用者の言った名前 */
  name: TextSchema,
  /** 当てた都道府県。都道府県に当たらない名前は null（maybe として旅程係に渡す） */
  prefecture: PrefectureSchema.nullable(),
  status: z.enum(ANCHOR_VISIT_STATUSES),
  /** 判断の理由（コードで決まった型で作る）。included では null でよい */
  reason: TextSchema.nullable(),
});

/** POST /api/festival-trips/preview の本文 */
export const AnchorPlanRequestSchema = z.strictObject({
  sessionId: SessionIdSchema,
  anchor: TripAnchorSchema,
  origin: z.string().trim().min(1).max(50),
  nights: NightsSchema,
  /** 寄りたい場所（都道府県か地方の名前、自由な地名） */
  wishes: z.array(z.string().trim().min(1).max(50)).max(MAX_ROUTE_AREAS),
  pace: z.enum(PACES).optional(),
});

/** 選んだ祭りを軸にした旅の組み立て。すべてコードで計算する（旅程係への指示にも、そのまま使う） */
export const AnchorPlanSchema = z.strictObject({
  anchor: TripAnchorSchema,
  festivalName: TextSchema,
  /** 祭りの開催地の都道府県。必ず行く場所 */
  mustPrefectures: z.array(PrefectureSchema).min(1),
  /** 寄りたい場所の判断。言われた順 */
  visits: z.array(AnchorVisitSchema).max(MAX_ROUTE_AREAS),
  /** 回る順（出発地から帰りまでの場所の名前）。祭りの開催地を必ず含む */
  order: z.array(TextSchema).min(1),
  /** 旅の初日と最後の日。祭りの日を必ず含む */
  startDate: IsoDateSchema,
  endDate: IsoDateSchema,
  /** その祭りに無理なく行くのに要る泊数の目安。出発の駅の位置が分からなければ null */
  minNights: NightsSchema.nullable(),
  /** 注意（選んだ泊数では祭りに間に合わない、など。コードで決まった型で作る） */
  warnings: z.array(TextSchema),
});

export type FestivalKind = z.infer<typeof FestivalKindSchema>;
export type Season = z.infer<typeof SeasonSchema>;
export type FestivalSearchConditions = z.infer<typeof FestivalSearchConditionsSchema>;
export type FestivalSearchRequest = z.infer<typeof FestivalSearchRequestSchema>;
export type FestivalSearchResult = z.infer<typeof FestivalSearchResultSchema>;
export type FestivalNearMatch = z.infer<typeof FestivalNearMatchSchema>;
export type FestivalSearchNext = z.infer<typeof FestivalSearchNextSchema>;
export type FestivalWishReading = z.infer<typeof FestivalWishReadingSchema>;
export type FestivalSearchResponse = z.infer<typeof FestivalSearchResponseSchema>;
export type FestivalWishIntent = z.infer<typeof FestivalWishIntentSchema>;
export type TripAnchor = z.infer<typeof TripAnchorSchema>;
export type AnchorVisit = z.infer<typeof AnchorVisitSchema>;
export type AnchorPlanRequest = z.infer<typeof AnchorPlanRequestSchema>;
export type AnchorPlan = z.infer<typeof AnchorPlanSchema>;
