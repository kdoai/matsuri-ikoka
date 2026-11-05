import { createHash } from "node:crypto";
import type {
  DietaryNeed,
  FoodWish,
  IsoDate,
  Itinerary,
  LatLng,
  NEARBY_KINDS,
  NearbySpot,
  OpeningHours,
  Party,
  Preferences,
  Source,
  Weekday,
} from "@matsuri-ikoka/schema";
import { distanceKm } from "./lodging";
import { fitsOpeningHours, isClosedOn, type TimeWindow } from "./nearby";
import { preferenceEffects } from "./preferences";
import { lastMileMinutes } from "./travelEstimate";

// 周辺係が Web で調べた店・寄り道を、聞き取った条件と行く日の営業でコードが最後に絞る。
// 調べた報告は信用しない入力なので、合うかどうかはモデルの言い分ではなく、報告の値とこの決まりで決める。
// 合うものがなければ、合わないもので埋めずに「見つからなかった」と返す。

/** 会場からこれより遠い場所は、祭りの前後の寄り道にしない（km、直線）。車で回るときは ScreenOptions.maxKm で広げる */
export const MAX_RESEARCHED_SPOT_KM = 3;
/** 1か所の食事・寄り道に、1人あたりの旅の予算のこの割合より多くはかけない */
export const SPOT_BUDGET_SHARE = 0.3;
/** 返す場所の数の上限 */
export const MAX_RESEARCHED_SPOTS = 8;
/** 店が対応しているとページに書かれていなければ、店を選ばない食事の制限 */
const STRICT_DIETARY: readonly DietaryNeed[] = ["vegetarian", "vegan", "halal"];

/** 周辺係が調べた1か所の報告（信用しない入力） */
export interface ResearchedSpotReport {
  name: string;
  kind: (typeof NEARBY_KINDS)[number];
  /** 自分の言葉の要約 */
  summary: string;
  location: LatLng;
  /** ページに書かれている、出す料理の種類 */
  foods: FoodWish[];
  /** ページに対応すると書かれている、食事で気をつけたいこと */
  dietaryOk: DietaryNeed[];
  /** 子どもは入れない（酒場など）とページに書かれている */
  adultsOnly: boolean;
  /** 1人あたりの料金の幅（円）。分からなければ null */
  pricePerPersonYen: [number, number] | null;
  /** 料金の目安の文（例：ランチ 1,200円前後） */
  price: string | null;
  /** 行く日の営業時間。分からなければ null */
  hours: OpeningHours | null;
  /** 定休日。定休日がなければ空の配列、分からなければ null */
  closedDays: Weekday[] | null;
  /** 行く日に営業しているか（定休日・臨時休業の告知まで確かめた結果） */
  openOnDate: "open" | "closed" | "unconfirmed";
  /** 実際に読んだページだけ */
  sources: { url: string; title?: string }[];
}

export type ResearchedExclusionReason =
  | "too_far"
  | "closed_on_date"
  | "outside_hours"
  | "shop_meal_not_wanted"
  | "food_not_wished"
  | "dietary_unconfirmed"
  | "over_budget"
  | "adults_only";

/** 調べた場所。祭りのデータの場所と同じ形に、営業の確かめと、合った食べたいものを足す */
export interface ResearchedSpot extends NearbySpot {
  /** confirmed：行く日の営業を確かめた / needs_check：確かめられなかった（行く前に要確認） */
  openStatus: "confirmed" | "needs_check";
  matchedFoods: FoodWish[];
}

export interface ResearchedSelection {
  spots: ResearchedSpot[];
  excluded: { name: string; reason: ResearchedExclusionReason }[];
  /** 食べたいもの（屋台のほか）に合う店が残ったか。食べたいものがなければ null */
  foodFound: boolean | null;
}

/** 調べた場所の ID。祭りのデータの場所と重ならないよう web- を付け、名前と位置から決める */
export function researchedSpotId(name: string, location: LatLng): string {
  const hash = createHash("sha256")
    .update(`${name}@${location.lat.toFixed(4)},${location.lng.toFixed(4)}`)
    .digest("hex")
    .slice(0, 10);
  return `web-${hash}`;
}

/** 屋台のほかに食べたいもの（屋台は祭りの屋台で叶う） */
export function shopFoodWishes(wishes: readonly FoodWish[]): FoodWish[] {
  return wishes.filter((wish) => wish !== "stalls");
}

function exclusionReason(
  report: ResearchedSpotReport,
  options: ScreenOptions,
): ResearchedExclusionReason | null {
  if (distanceKm(options.venue, report.location) > (options.maxKm ?? MAX_RESEARCHED_SPOT_KM)) {
    return "too_far";
  }
  if (report.openOnDate === "closed" || isClosedOn(report, options.date)) return "closed_on_date";
  if (options.window !== undefined && !fitsOpeningHours(report.hours, options.window)) {
    return "outside_hours";
  }
  const children = (options.party?.children ?? 0) + (options.party?.infants ?? 0);
  if (report.adultsOnly && children > 0) return "adults_only";
  const perPerson = options.perPersonBudgetYen;
  if (
    perPerson !== null &&
    report.pricePerPersonYen !== null &&
    report.pricePerPersonYen[0] > perPerson * SPOT_BUDGET_SHARE
  ) {
    return "over_budget";
  }
  if (report.kind !== "food") return null;

  const wanted = shopFoodWishes(options.foodWishes);
  const includeShopMeals =
    preferenceEffects(options.preferences).includeShopMeals || wanted.length > 0;
  if (!includeShopMeals) return "shop_meal_not_wanted";
  if (wanted.length > 0 && !report.foods.some((food) => wanted.includes(food))) {
    return "food_not_wished";
  }
  for (const need of options.dietary) {
    if (STRICT_DIETARY.includes(need) && !report.dietaryOk.includes(need)) {
      return "dietary_unconfirmed";
    }
  }
  // 生ものが苦手なら、海鮮だけの店は、生もの以外も出すと書かれていなければ選ばない
  if (
    options.dietary.includes("no_raw") &&
    !report.dietaryOk.includes("no_raw") &&
    report.foods.length > 0 &&
    report.foods.every((food) => food === "seafood")
  ) {
    return "dietary_unconfirmed";
  }
  return null;
}

export interface ScreenOptions {
  date: IsoDate;
  window?: TimeWindow;
  venue: LatLng;
  /** 会場からの距離の上限（km）。省略すると MAX_RESEARCHED_SPOT_KM（歩いて回る範囲） */
  maxKm?: number;
  /** 確かめた日（出典の checkedAt） */
  today: IsoDate;
  preferences: Preferences;
  foodWishes: readonly FoodWish[];
  dietary: readonly DietaryNeed[];
  perPersonBudgetYen: number | null;
  party: Party | null;
}

/**
 * 調べた場所を、行く日の営業・距離・同行者・予算・食べたいもの・食事の制限で絞り、祭りのデータの場所と同じ形にする。
 * 出典のない場所は入れない。確度は、読んだページが2つ以上なら corroborated、1つなら single にする
 */
export function screenResearchedSpots(
  reports: readonly ResearchedSpotReport[],
  options: ScreenOptions,
): ResearchedSelection {
  const wanted = shopFoodWishes(options.foodWishes);
  const kept: ResearchedSpot[] = [];
  const excluded: ResearchedSelection["excluded"] = [];
  const seen = new Set<string>();

  for (const report of reports) {
    if (report.sources.length === 0) continue;
    const id = researchedSpotId(report.name, report.location);
    if (seen.has(id)) continue;
    seen.add(id);
    const reason = exclusionReason(report, options);
    if (reason !== null) {
      excluded.push({ name: report.name, reason });
      continue;
    }
    const confidence = report.sources.length >= 2 ? "corroborated" : "single";
    const sources: Source[] = report.sources.map((s) => ({
      url: s.url,
      ...(s.title ? { title: s.title } : {}),
      checkedAt: options.today,
      confidence,
    }));
    const local = report.foods.some((food) => food === "local_dish" || food === "local_gourmet");
    kept.push({
      id,
      name: report.name,
      kind: report.kind,
      summary: report.summary,
      location: report.location,
      walkMinutesFromVenue: lastMileMinutes(distanceKm(options.venue, report.location)),
      hours: report.hours,
      closedDays: report.closedDays,
      price: report.price,
      tags: local ? ["local_food"] : [],
      // 知名度は調べていないので、いちばん控えめな「地元で知られる」にする
      popularity: "local",
      sources,
      openStatus:
        report.openOnDate === "open" && report.hours !== null ? "confirmed" : "needs_check",
      matchedFoods: report.foods.filter((food) => wanted.includes(food)),
    });
  }

  kept.sort((a, b) => {
    const byMatch = b.matchedFoods.length - a.matchedFoods.length;
    if (byMatch !== 0) return byMatch;
    if (a.openStatus !== b.openStatus) return a.openStatus === "confirmed" ? -1 : 1;
    return (a.walkMinutesFromVenue?.[1] ?? 0) - (b.walkMinutesFromVenue?.[1] ?? 0);
  });

  const spots = kept.slice(0, MAX_RESEARCHED_SPOTS);
  const foodFound =
    wanted.length === 0
      ? null
      : spots.some((spot) => spot.kind === "food" && spot.matchedFoods.length > 0);
  return { spots, excluded, foodFound };
}

/** 旅程に入れる形（祭りのデータの場所と同じ形）に戻す */
export function asNearbySpot(spot: ResearchedSpot): NearbySpot {
  const { openStatus: _status, matchedFoods: _foods, ...rest } = spot;
  return rest;
}

/** 調べた場所の ID か */
export function isResearchedSpotId(id: string): boolean {
  return id.startsWith("web-");
}

/**
 * 保存してある旅程に入っている、調べた場所を取り出す。相談を保存の口から戻したあとなど、
 * 調べた結果が手元にないときに、前の版の場所（位置・営業時間・出典）のまま直せるようにする。定休日は分からないので null
 */
export function researchedSpotsInItinerary(itinerary: Itinerary): Map<string, NearbySpot> {
  const spots = new Map<string, NearbySpot>();
  for (const item of itinerary.days.flatMap((day) => day.items)) {
    if (item.spotId === undefined || !isResearchedSpotId(item.spotId)) continue;
    if (item.location === null || item.sources.length === 0) continue;
    spots.set(item.spotId, {
      id: item.spotId,
      name: item.name,
      kind: item.type === "meal" ? "food" : item.type === "rest" ? "rest" : "sightseeing",
      summary: item.reason.slice(0, 120),
      location: item.location,
      walkMinutesFromVenue: null,
      hours: item.hours,
      closedDays: null,
      price: item.cost,
      tags: [],
      popularity: "local",
      sources: item.sources,
    });
  }
  return spots;
}
