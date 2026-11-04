import type { DietaryNeed, FoodWish } from "@matsuri-ikoka/schema";
import { toMinutes } from "./calendar";
import { FOOD_WISH_LABELS } from "./food";
import type { TimeWindow } from "./nearby";
import {
  MAX_RESEARCHED_SPOT_KM,
  type ResearchedSpotReport,
  researchedSpotId,
  shopFoodWishes,
} from "./nearbyResearch";

// 会場の周りの店を Web で探すときの「調べ方」（検索の言葉の作り方と、確かめる観点）をコードで決める。
// 料理の種類の大きな言葉（肉料理）のままでは、店の一覧のページに当たりにくい。店は「焼肉」「ステーキ」のような
// 料理の名前と、駅や市町村の名前で探される。グルメの案内サイトの一覧のページには、近くの店がまとまって載る。
// そこで、言葉の言い換え・場所・時間帯・同行者・案内サイトの名前を組み合わせた検索の言葉を、毎回コードで渡す。

/** 1回の調べで渡す検索の言葉の上限（並べて呼ぶ前提） */
export const MAX_NEARBY_QUERIES = 8;
/** 歩いて回るときの、調べた場所の会場からの距離の上限（km、直線） */
export const WALK_SPOT_KM = MAX_RESEARCHED_SPOT_KM;
/** 車で回るときの、調べた場所の会場からの距離の上限（km、直線） */
export const CAR_SPOT_KM = 10;

/** 食べたいものの言い換え。店の一覧のページや店の名前に出てくる料理の言葉を、当たりやすい順に並べる */
export const FOOD_WISH_KEYWORDS: Record<FoodWish, readonly string[]> = {
  meat: [
    "焼肉",
    "ステーキ",
    "ハンバーグ",
    "とんかつ",
    "焼き鳥",
    "鉄板焼き",
    "すき焼き",
    "しゃぶしゃぶ",
  ],
  seafood: ["海鮮丼", "寿司", "魚料理", "海鮮料理", "回転寿司", "定食 魚"],
  vegetables: ["野菜料理", "自然食", "サラダ ランチ", "精進料理", "ベジ"],
  noodles: ["うどん", "そば", "ラーメン", "中華そば", "つけ麺", "ちゃんぽん"],
  local_dish: ["郷土料理", "名物", "地元料理", "ご当地料理"],
  local_gourmet: ["ご当地グルメ", "B級グルメ", "名物 グルメ", "ソウルフード"],
  washoku: ["和食", "定食", "割烹", "天ぷら", "丼"],
  sweets: ["カフェ", "甘味処", "和菓子", "スイーツ", "パフェ"],
  stalls: ["屋台"],
  local_drinks: ["地酒", "地ビール", "居酒屋", "酒蔵"],
};

/** 食べたいものがないときに探す言葉（地元の味と、休憩の場所） */
const DEFAULT_KEYWORDS = ["ランチ", "郷土料理", "カフェ"] as const;

/** 食事で気をつけたいことを、店のページの言葉にしたもの（生ものは料理の言葉で避けるので足さない） */
const DIETARY_KEYWORDS: Partial<Record<DietaryNeed, string>> = {
  vegetarian: "ベジタリアン",
  vegan: "ヴィーガン",
  halal: "ハラール",
  allergy: "アレルギー対応",
};

/** 近くの店がまとまって載る、グルメの案内サイトの名前（一覧のページを狙う） */
export const GOURMET_GUIDES = ["食べログ", "ホットペッパーグルメ", "Retty"] as const;

export type NearbySearchRound = "first" | "widened";
export type MealTime = "lunch" | "dinner";

const MEAL_WORDS: Record<MealTime, string> = { lunch: "ランチ", dinner: "ディナー" };

export interface NearbySearchInput {
  /** 会場の名前 */
  venueName: string;
  /** 会場の市町村（祭りのデータの municipalities） */
  municipalities: readonly { prefecture: string; name: string }[];
  /** 会場の最寄り駅（祭りのデータの access.stations の順。近い順） */
  stations: readonly string[];
  foodWishes: readonly FoodWish[];
  dietary: readonly DietaryNeed[];
  withChildren: boolean;
  byCar: boolean;
  /** 寄り道に使える時間帯。分からなければ昼と夜の両方を探す */
  window?: TimeWindow;
}

export interface NearbySearchPlan {
  round: NearbySearchRound;
  /** 検索の言葉（上から優先。並べて呼ぶ） */
  queries: string[];
  /** 店や施設のページで確かめる観点 */
  checkpoints: string[];
  /** この回で探す範囲（km、会場からの直線） */
  radiusKm: number;
  /** 2回目のとき、1回目からどう広げたか */
  widening: string[];
}

/** 駅の名前を「〇〇駅」の形にそろえる */
export function stationWord(name: string): string {
  const bare = name.replace(/[（(][^）)]*[）)]/g, "").trim();
  return bare.endsWith("駅") ? bare : `${bare}駅`;
}

/** 寄り道に使える時間帯が、昼（11:00〜14:00）・夜（17:00〜21:00）にかかるか */
export function mealTimes(window: TimeWindow | undefined): MealTime[] {
  if (window === undefined) return ["lunch", "dinner"];
  const from = toMinutes(window.from);
  const to = toMinutes(window.to);
  const overlaps = (start: number, end: number) => from < end && start < to;
  const times: MealTime[] = [];
  if (overlaps(11 * 60, 14 * 60)) times.push("lunch");
  if (overlaps(17 * 60, 21 * 60)) times.push("dinner");
  return times;
}

/** 調べた場所の会場からの距離の上限（km）。車で回るなら遠い店も選べる */
export function maxSpotKm(byCar: boolean): number {
  return byCar ? CAR_SPOT_KM : WALK_SPOT_KM;
}

/** この回で探す範囲（km）。1回目は近くを、2回目は距離の上限まで広げる */
export function searchRadiusKm(byCar: boolean, round: NearbySearchRound): number {
  if (round === "widened") return maxSpotKm(byCar);
  return byCar ? 5 : 2;
}

/** 食べたいもの（屋台のほか）ごとの言い換えを、種類をまたいで交互に並べる（どの種類も上位に入る） */
function interleavedKeywords(wishes: readonly FoodWish[]): string[] {
  const lists = wishes.map((wish) => FOOD_WISH_KEYWORDS[wish]);
  const longest = Math.max(0, ...lists.map((list) => list.length));
  const words: string[] = [];
  for (let i = 0; i < longest; i += 1) {
    for (const list of lists) {
      const word = list[i];
      if (word !== undefined) words.push(word);
    }
  }
  return [...new Set(words)];
}

/** 1回目に使う言い換えの数。残りは2回目に回す */
const FIRST_ROUND_KEYWORDS = 4;

/**
 * 店探しの検索の言葉。上から優先する。
 * 1回目（first）：いちばん近い駅と会場の市町村を、言い換えの上位（料理の名前）と組む
 *   1. 最寄り駅 × 言い換え × 時間帯（ランチ・ディナー）
 *   2. 市町村 × 言い換え
 *   3. 最寄り駅 × 言い換え × グルメの案内サイトの名前（一覧のページを狙う）
 *   4. 子ども連れなら「子連れ」、車なら「駐車場」、食事の制限があればその言葉を足したもの
 * 2回目（widened）：1回目で合う店がなかったときに、場所と言葉を広げる
 *   1. 隣の駅（2番目より先の最寄り駅）・会場の名前の「周辺」・都道府県と市町村
 *   2. 言い換えの残りと、料理の種類の大きな言葉（肉料理）
 *   3. ほかのグルメの案内サイトの名前
 */
export function nearbySearchQueries(input: NearbySearchInput, round: NearbySearchRound): string[] {
  const wishes = shopFoodWishes(input.foodWishes);
  const keywords = wishes.length > 0 ? interleavedKeywords(wishes) : [...DEFAULT_KEYWORDS];
  const labels = wishes.map((wish) => FOOD_WISH_LABELS[wish]);
  const city = input.municipalities[0]?.name ?? "";
  const prefecture = input.municipalities[0]?.prefecture ?? "";
  const stations = input.stations.map(stationWord);
  const [nearest = city] = stations;
  const meal = mealTimes(input.window).map((time) => MEAL_WORDS[time]);
  const [firstMeal = ""] = meal;
  const dietary = input.dietary.flatMap((need) => DIETARY_KEYWORDS[need] ?? []);
  const extras = [
    ...(input.withChildren ? ["子連れ"] : []),
    ...(input.byCar ? ["駐車場"] : []),
    ...dietary,
  ];

  // 同じ言葉は重ねない（食べたいものがないときの「ランチ」と時間帯の「ランチ」など）
  const join = (...words: string[]) => [...new Set(words.filter((word) => word !== ""))].join(" ");
  let queries: string[];
  if (round === "first") {
    const top = keywords.slice(0, FIRST_ROUND_KEYWORDS);
    const [k1 = "", k2 = k1, k3 = k2, k4 = k3] = top;
    queries = [
      join(nearest, k1, firstMeal),
      join(city, k2),
      join(nearest, k1, GOURMET_GUIDES[0]),
      ...extras.map((extra, i) => join(nearest, top[i % top.length] ?? "", extra)),
      join(nearest, k3),
      join(city, k1, meal[1] ?? firstMeal),
      join(city, k4, GOURMET_GUIDES[1]),
      join(nearest, k2),
    ];
  } else {
    const rest = keywords.slice(FIRST_ROUND_KEYWORDS);
    const [r1 = keywords[0] ?? "", r2 = r1] = rest;
    const [k1 = ""] = keywords;
    const neighbors = stations.slice(1);
    const [broad = k1] = labels;
    queries = [
      join(input.venueName, "周辺", k1),
      ...neighbors.slice(0, 2).map((station) => join(station, k1)),
      join(city, r1),
      join(prefecture, city, broad, "おすすめ"),
      join(city, r2, firstMeal),
      join(city, broad, GOURMET_GUIDES[2]),
      ...extras.map((extra) => join(city, broad, extra)),
      join(nearest, broad),
    ];
  }
  return [...new Set(queries.filter((query) => query !== ""))].slice(0, MAX_NEARBY_QUERIES);
}

/** 店や施設のページで確かめる観点 */
export function nearbyCheckpoints(input: NearbySearchInput): string[] {
  const wishes = shopFoodWishes(input.foodWishes);
  const points = [
    wishes.length > 0
      ? `出す料理：食べたいもの（${wishes.map((w) => FOOD_WISH_LABELS[w]).join("・")}）に当たるか。言い換え（${interleavedKeywords(wishes).slice(0, 6).join("・")}など）の店も当たる`
      : "出す料理：地元の味か、休憩に向くか",
    "営業時間とラストオーダー（行く日の曜日のもの）",
    "定休日",
    "臨時休業・休業日・貸し切りの告知（店のページのお知らせ、SNS の告知）",
    "1人あたりの料金の目安（ランチ・ディナーの別）",
    "会場からの位置（住所や地図。緯度と経度が分かるもの）",
  ];
  if (input.withChildren) {
    points.push(
      "子ども連れで入れるか（子ども用の椅子・座敷・お子さまメニュー・入店の年齢の決まり）",
    );
  }
  if (input.byCar) points.push("駐車場があるか（台数・提携の駐車場）");
  if (input.dietary.length > 0) {
    points.push("食事で気をつけたいことへの対応が、ページに書かれているか");
  }
  return points;
}

/** 1回目で合う店がなかったときの、広げ方の説明（2回目の依頼に入れる） */
function wideningNotes(input: NearbySearchInput): string[] {
  const notes = [
    "1回目の言葉では、食べたいものに合う店が見つからなかった。言葉と場所を変えて探し直す",
    "隣の駅・市町村の中心（主な駅の周り）・会場の名前の「周辺」まで場所を広げる",
    "料理の言い換えの残りと、料理の種類の大きな言葉でも探す",
    `探す範囲を会場から ${searchRadiusKm(input.byCar, "widened")}km まで広げる`,
  ];
  if (input.byCar) notes.push("車で回るので、駐車場のある郊外の店も探す");
  return notes;
}

/** この回の調べ方（検索の言葉・確かめる観点・範囲） */
export function nearbySearchPlan(
  input: NearbySearchInput,
  round: NearbySearchRound,
): NearbySearchPlan {
  return {
    round,
    queries: nearbySearchQueries(input, round),
    checkpoints: nearbyCheckpoints(input),
    radiusKm: searchRadiusKm(input.byCar, round),
    widening: round === "widened" ? wideningNotes(input) : [],
  };
}

/** 2回の調べの結果をまとめる。同じ場所（名前と位置で決まる ID が同じ）は、先に見つけたものを残す */
export function mergeResearchedReports(
  ...rounds: readonly (readonly ResearchedSpotReport[])[]
): ResearchedSpotReport[] {
  const seen = new Set<string>();
  const merged: ResearchedSpotReport[] = [];
  for (const report of rounds.flat()) {
    const id = researchedSpotId(report.name, report.location);
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(report);
  }
  return merged;
}
