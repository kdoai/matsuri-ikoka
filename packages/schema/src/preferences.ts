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

/**
 * 同行者の人数。adults は中学生以上の全員、children は小学生以下の全員。
 * seniors と infants は内訳で、seniors は adults のうちのシニア（65歳以上）、
 * infants は children のうちの未就学の子ども。内訳がないときは 0 として扱う。
 * 内訳を大人・子どもの内数にするのは、合計を出す計算と人数の表示が内訳を知らなくても正しくなるため。
 */
export const PartySchema = z
  .strictObject({
    adults: z.number().int().min(1).max(20),
    children: z.number().int().min(0).max(20),
    seniors: z.number().int().min(0).max(20).optional(),
    infants: z.number().int().min(0).max(20).optional(),
  })
  .superRefine((party, ctx) => {
    if ((party.seniors ?? 0) > party.adults) {
      ctx.addIssue({
        code: "custom",
        path: ["seniors"],
        message: "シニアは大人の内数なので、大人の人数以下にしてください",
      });
    }
    if ((party.infants ?? 0) > party.children) {
      ctx.addIssue({
        code: "custom",
        path: ["infants"],
        message: "幼児は子どもの内数なので、子どもの人数以下にしてください",
      });
    }
  });
export type Party = z.infer<typeof PartySchema>;

/** 宿の予算の単位：1泊あたり / 泊まり全体（全泊の合計） */
export const BUDGET_PERIODS = ["night", "trip"] as const;

/**
 * 宿の予算の上限。1人あたりの円で持つ（幼児は人数に数えない）。
 * 交通費や食事は含めない。合計と上限を超えるかの判断はコードで計算する。
 */
export const LodgingBudgetSchema = z.strictObject({
  perPersonYen: z.number().int().min(1).max(1_000_000),
  per: z.enum(BUDGET_PERIODS),
});
export type LodgingBudget = z.infer<typeof LodgingBudgetSchema>;

/** 旅の予算の単位：1人あたり / 全員の合計 */
export const BUDGET_BASES = ["perPerson", "total"] as const;
export type BudgetBasis = (typeof BUDGET_BASES)[number];

/** 旅の予算に入れられる金額の上限（円） */
export const MAX_BUDGET_YEN = 10_000_000;

/**
 * 旅の予算の上限（交通・宿・食事などを合わせた目安、円）。利用者の言った単位（1人あたりか全員の合計か）の
 * まま持ち、1人あたりと合計の換算はコードで行う（tripBudgetAmounts）
 */
export const TripBudgetSchema = z.strictObject({
  yen: z.number().int().min(1).max(MAX_BUDGET_YEN),
  basis: z.enum(BUDGET_BASES),
});
export type TripBudget = z.infer<typeof TripBudgetSchema>;

/** 予算を割る人数。幼児は数えない（宿の予算と同じ） */
export function budgetPayers(party: Party): number {
  return Math.max(1, party.adults + party.children - (party.infants ?? 0));
}

export interface TripBudgetAmounts {
  basis: BudgetBasis;
  /** 1人あたりの上限（円）。合計で受けて人数が分からなければ null。割り切れないときは切り捨て */
  perPersonYen: number | null;
  /** 全員の合計の上限（円）。1人あたりで受けて人数が分からなければ null */
  totalYen: number | null;
  /** 割った・掛けた人数。人数が分からなければ null */
  payers: number | null;
}

/** 旅の予算を、1人あたりと全員の合計の両方にする。合計で受けたときは人数で割る */
export function tripBudgetAmounts(budget: TripBudget, party: Party | undefined): TripBudgetAmounts {
  const payers = party === undefined ? null : budgetPayers(party);
  if (budget.basis === "perPerson") {
    return {
      basis: budget.basis,
      perPersonYen: budget.yen,
      totalYen: payers === null ? null : budget.yen * payers,
      payers,
    };
  }
  return {
    basis: budget.basis,
    perPersonYen: payers === null ? null : Math.floor(budget.yen / payers),
    totalYen: budget.yen,
    payers,
  };
}

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

/** 日帰りで選べる、出発の駅からの片道の所要時間の上限（分）：1時間・2時間・3時間 */
export const DAY_TRIP_TRAVEL_LIMITS = [60, 120, 180] as const;

/**
 * 出発の駅から会場までの片道の所要時間の上限（分）。日帰り（0泊）の旅だけで祭りを絞り込み、
 * 泊まりの旅では使わない（泊まるなら遠くても行けるため）。所要時間の判定はコードで計算する
 */
export const MaxTravelMinutesSchema = z.number().int().min(30).max(600);

// 泊まりの旅で聞く項目。どれも任意で、分からないときは推測で埋めない。
// 「おまかせ」（auto）を選べる項目は、選んだことと、まだ聞いていないこと（項目がない）を分けて持つ。

/** 旅のかたち：ずっと一か所を拠点にする / いくつかの地域を巡る / 目的地へ向かう途中で祭りに寄る / おまかせ */
export const ROUTE_SHAPES = ["stay", "loop", "via", "auto"] as const;
/** 回りたい地域の数の上限 */
export const MAX_ROUTE_AREAS = 5;

const PlaceNameSchema = z.string().trim().min(1).max(50);

/** 旅のかたちと、回りたい地域（名前の並び。巡る順の希望があればその順） */
export const RouteSchema = z.strictObject({
  shape: z.enum(ROUTE_SHAPES),
  areas: z.array(PlaceNameSchema).max(MAX_ROUTE_AREAS),
});
export type Route = z.infer<typeof RouteSchema>;

/** 泊まる場所の希望：祭りの会場の近く / 街（駅や繁華街の近く）/ おまかせ */
export const STAY_NEAR = ["festival", "town", "auto"] as const;
/** 祭りに行く日の数：1日だけ / 何日か / おまかせ */
export const FESTIVAL_DAYS = ["one", "several", "auto"] as const;
/** 旅のペース：ゆっくり / ふつう / たっぷり / おまかせ */
export const PACES = ["relaxed", "normal", "packed", "auto"] as const;
/** 祭りのほかに楽しみたいこと：温泉 / 食 / 自然 / 街歩き / 歴史 / 買い物 */
export const INTERESTS = ["onsen", "food", "nature", "town_walk", "history", "shopping"] as const;

/**
 * 旅先で食べたいもの：海鮮 / 肉料理 / 野菜中心 / 麺類（そば・うどん・ラーメン）/ 郷土料理 /
 * ご当地・B級グルメ / 和食 / 甘味・カフェ / 屋台 / 地酒・地ビール
 */
export const FOOD_WISHES = [
  "seafood",
  "meat",
  "vegetables",
  "noodles",
  "local_dish",
  "local_gourmet",
  "washoku",
  "sweets",
  "stalls",
  "local_drinks",
] as const;
export type FoodWish = (typeof FOOD_WISHES)[number];

/** 食事で気をつけたいこと：ベジタリアン / ヴィーガン / ハラール / 食物アレルギー / 生ものが苦手 */
export const DIETARY_NEEDS = ["vegetarian", "vegan", "halal", "allergy", "no_raw"] as const;
export type DietaryNeed = (typeof DIETARY_NEEDS)[number];

/**
 * 想定している交通手段：車（自家用車）/ 新幹線 / 在来線 / バス / 船 / 飛行機 / レンタカー / 徒歩。
 * いくつでも選べる。こだわりの「移動」（電車 / 車）より細かく、道のりを調べるときの決まりに使う
 */
export const TRANSPORT_MODES = [
  "car",
  "shinkansen",
  "local_train",
  "bus",
  "ferry",
  "plane",
  "rental_car",
  "walk",
] as const;
export type TransportMode = (typeof TRANSPORT_MODES)[number];

/**
 * 旅の条件。日付・出発地・泊数がそろうと、祭りを探し始める。同行者は任意。
 * 近場のお出かけと分かる相談では、泊まるかを聞き直さず 0 泊にしてよい。
 * 出発地は駅名までにとどめ、住所は聞かない。
 * 泊まりの旅では、泊数に応じて旅のかたち・終わりの場所・ペースなどを聞く（どれも任意）。
 */
export const TripConditionsSchema = z.strictObject({
  when: DateWishSchema,
  origin: PlaceNameSchema,
  nights: NightsSchema,
  /** 日帰りの片道の所要時間の上限（分）。利用者が言ったときだけ。泊まりの旅では使わない */
  maxTravelMinutes: MaxTravelMinutesSchema.optional(),
  party: PartySchema.optional(),
  /** 宿の予算の上限（1人あたり）。泊まりの旅で、利用者が言ったときだけ */
  lodgingBudget: LodgingBudgetSchema.optional(),
  /** 旅全体の予算の上限。1人あたりか全員の合計かを持つ。利用者が言ったときだけ */
  budget: TripBudgetSchema.optional(),
  /** 旅の終わりの場所（駅名まで）。出発地と違ってよい。ないときは出発地に戻る */
  returnTo: PlaceNameSchema.optional(),
  route: RouteSchema.optional(),
  stayNear: z.enum(STAY_NEAR).optional(),
  festivalDays: z.enum(FESTIVAL_DAYS).optional(),
  pace: z.enum(PACES).optional(),
  /** 楽しみたいこと。空の並びは「特にない・おまかせ」 */
  interests: z.array(z.enum(INTERESTS)).max(INTERESTS.length).optional(),
  /** 食べたいもの。空の並びは「こだわらない・おまかせ」 */
  foodWishes: z.array(z.enum(FOOD_WISHES)).max(FOOD_WISHES.length).optional(),
  /** 食事で気をつけたいこと。利用者が言ったときだけ。アレルギーの中身などは持たない */
  dietary: z.array(z.enum(DIETARY_NEEDS)).max(DIETARY_NEEDS.length).optional(),
  /** 想定している交通手段。空の並びは「おまかせ」 */
  transport: z.array(z.enum(TRANSPORT_MODES)).max(TRANSPORT_MODES.length).optional(),
  /** 「あとはおまかせ」。true のとき、まだ聞いていない項目は聞かずに組む */
  leaveToStaff: z.boolean().optional(),
});
export type TripConditions = z.infer<typeof TripConditionsSchema>;

/** 聞き取りの途中の条件。分かったものから埋まる */
export const PartialTripConditionsSchema = TripConditionsSchema.partial();
export type PartialTripConditions = z.infer<typeof PartialTripConditionsSchema>;
