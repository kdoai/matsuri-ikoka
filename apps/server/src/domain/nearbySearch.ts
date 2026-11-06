import type { DietaryNeed, FoodWish } from "@matsuri-ikoka/schema";
import { toMinutes } from "./calendar";
import { FOOD_WISH_LABELS } from "./food";
import { distanceKm } from "./lodging";
import type { TimeWindow } from "./nearby";
import {
  MAX_RESEARCHED_SPOT_KM,
  type ResearchedSpotReport,
  shopFoodWishes,
} from "./nearbyResearch";

// 会場の周りの店を Web で探すときの「調べ方」（検索の言葉の作り方と、確かめる観点）をコードで決める。
// 料理の種類の大きな言葉（肉料理）のままでは、店の一覧のページに当たりにくい。店は「焼肉」「ステーキ」のような
// 料理の名前と、駅や市町村の名前で探される。店の公式のページと観光協会の案内に当たるよう、
// 言葉の言い換え・場所・時間帯・同行者を組み合わせた検索の言葉を、毎回コードで渡す。

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

export type NearbySearchRound = "first" | "widened";
/**
 * 調べる観点。別の言葉と別の種類のページから探すと、1つの調べでは当たらない店が見つかり、突き合わせもできる。
 * wish 食べたいもの / lunch 食事に入れられる店 / local 観光協会・自治体・商店街の案内 / official 見つけた店の公式のページ
 */
export type NearbyPerspective = "wish" | "lunch" | "local" | "official";
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
  /** 調べ直しで特に確かめること（評価係の指摘）。確かめる観点の先頭に入れる */
  focus?: readonly string[];
}

export interface NearbySearchPlan {
  round: NearbySearchRound;
  /** 観点。省略すると観点を分けない調べ */
  perspective?: NearbyPerspective;
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

/** 会場の近くの店がこれより少なければ、店の少ない地域として探す範囲を広げる */
export const SPARSE_SHOP_COUNT = 3;
/** 店の少ない地域で、歩いて回るときの距離の上限（km、直線）。バスやタクシーで寄る距離 */
export const SPARSE_SPOT_KM = 5;

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
 *   3. 最寄り駅 × 言い換え × 公式（店のページを狙う）
 *   4. 子ども連れなら「子連れ」、車なら「駐車場」、食事の制限があればその言葉を足したもの
 * 2回目（widened）：1回目で合う店がなかったときに、場所と言葉を広げる
 *   1. 隣の駅（2番目より先の最寄り駅）・会場の名前の「周辺」・都道府県と市町村
 *   2. 言い換えの残りと、料理の種類の大きな言葉（肉料理）
 *   3. 公式サイト
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
      // 食べたいものに合う店がなくても食事の予定を入れられるよう、料理を問わない店も探す
      join(nearest, firstMeal === "" ? "ランチ" : firstMeal),
      join(city, k2),
      join(nearest, k1, "公式"),
      ...extras.map((extra, i) => join(nearest, top[i % top.length] ?? "", extra)),
      join(nearest, k3),
      join(city, k1, meal[1] ?? firstMeal),
      join(city, "観光協会", k4),
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
      join(city, broad, "公式サイト"),
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
    "昼・夜の食事に入れられる店を、時間帯ごとに少なくとも2つ（食べたいものに合う店を先に。なければ料理を問わず近くの店）",
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
    checkpoints: [
      ...(input.focus ?? []).map((point) => `調べ直し：${point}`),
      ...nearbyCheckpoints(input),
    ],
    radiusKm: searchRadiusKm(input.byCar, round),
    widening: round === "widened" ? wideningNotes(input) : [],
  };
}

/** 観点ごとの検索の言葉の数の上限。並べて動かすので、1つの調べは短く済ませる */
export const MAX_PERSPECTIVE_QUERIES = 5;
/** 公式のページで確かめる店の数の上限 */
const MAX_OFFICIAL_LEADS = 6;

/**
 * 1回目の調べ方を、観点ごとに決める。観点ごとに1つの調べ役を並べて動かす。
 * 評価の頼み（focus）で調べ直すときは、頼まれたことだけを1つの調べで確かめる
 */
export function nearbySearchPlans(
  input: NearbySearchInput,
  /** 公式のページを確かめたい店（OpenStreetMap で見つけた店など） */
  leads: readonly { name: string }[] = [],
): NearbySearchPlan[] {
  if ((input.focus ?? []).length > 0) return [nearbySearchPlan(input, "first")];
  const hasWishes = shopFoodWishes(input.foodWishes).length > 0;
  const base = nearbySearchPlan(input, "first");
  const plans: NearbySearchPlan[] = [{ ...base, perspective: hasWishes ? "wish" : "lunch" }];
  if (hasWishes) {
    plans.push({
      ...nearbySearchPlan({ ...input, foodWishes: [] }, "first"),
      perspective: "lunch",
    });
  }
  const city = input.municipalities[0]?.name ?? "";
  plans.push({
    ...base,
    perspective: "local",
    queries: [
      `${city} 観光協会 グルメ`,
      `${city} 名物 食事 店`,
      `${city} 商店街 飲食店`,
      `${input.venueName} 周辺 食事`,
    ],
    checkpoints: [
      "自治体・観光協会・商店街の案内に載っている店と見どころを拾い、店のページで確かめる",
      ...base.checkpoints,
    ],
  });
  if (leads.length > 0) {
    plans.push({
      ...base,
      perspective: "official",
      queries: leads.slice(0, MAX_OFFICIAL_LEADS).map((lead) => `${lead.name} ${city}`),
      checkpoints: [
        "「参考」の店が今も営業しているかを、店の公式のページで確かめる。公式のページの候補があれば、まずそれを読む",
        ...base.checkpoints,
      ],
    });
  }
  return plans.map((plan) => ({
    ...plan,
    queries: plan.queries.slice(0, MAX_PERSPECTIVE_QUERIES),
  }));
}

/** 同じ店とみなす距離（km）。同じ名前のチェーンの別の店を、まとめないため */
const SAME_PLACE_KM = 1;

const nameKey = (name: string) => name.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
const isMapSource = (url: string) => /(^|\.)openstreetmap\.org$/.test(hostOf(url));

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
}

/** 出典のサイトの数。同じサイトのページがいくつあっても1つと数える */
export function distinctSourceSites(sources: readonly { url: string }[]): number {
  return new Set(sources.map((source) => hostOf(source.url))).size;
}

/**
 * 同じ店の報告を1つにまとめる。営業は安全なほうに寄せる（どれかが休みと言えば休み）。
 * 位置は地図のデータを、そのほかの分からない値は、先の報告を優先して埋める
 */
function combineReports(a: ResearchedSpotReport, b: ResearchedSpotReport): ResearchedSpotReport {
  const sources = [...a.sources];
  for (const source of b.sources) {
    if (!sources.some((known) => known.url === source.url)) sources.push(source);
  }
  const openOnDate =
    a.openOnDate === "closed" || b.openOnDate === "closed"
      ? "closed"
      : a.openOnDate === "open" || b.openOnDate === "open"
        ? "open"
        : "unconfirmed";
  const closedDays =
    a.closedDays === null
      ? b.closedDays
      : b.closedDays === null
        ? a.closedDays
        : [...new Set([...a.closedDays, ...b.closedDays])];
  const fromMap = (report: ResearchedSpotReport) =>
    report.sources.some((source) => isMapSource(source.url));
  return {
    ...a,
    location: fromMap(b) && !fromMap(a) ? b.location : a.location,
    foods: [...new Set([...a.foods, ...b.foods])],
    dietaryOk: [...new Set([...a.dietaryOk, ...b.dietaryOk])],
    adultsOnly: a.adultsOnly || b.adultsOnly,
    pricePerPersonYen: a.pricePerPersonYen ?? b.pricePerPersonYen,
    price: a.price ?? b.price,
    hours: a.hours ?? b.hours,
    closedDays,
    openOnDate,
    sources,
    ...((a.website ?? b.website) ? { website: a.website ?? b.website } : {}),
  };
}

/**
 * いくつかの調べの結果を、店ごとに突き合わせてまとめる。
 * 名前（空白と全角半角の違いを除く）が同じで近くにある報告を、同じ店として1つにする
 */
export function mergeResearchedReports(
  ...rounds: readonly (readonly ResearchedSpotReport[])[]
): ResearchedSpotReport[] {
  const merged: ResearchedSpotReport[] = [];
  for (const report of rounds.flat()) {
    const index = merged.findIndex(
      (known) =>
        nameKey(known.name) === nameKey(report.name) &&
        distanceKm(known.location, report.location) <= SAME_PLACE_KM,
    );
    const known = merged[index];
    if (known === undefined) merged.push(report);
    else merged[index] = combineReports(known, report);
  }
  return merged;
}
