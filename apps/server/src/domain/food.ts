import type { DietaryNeed, FoodWish, PartialTripConditions } from "@matsuri-ikoka/schema";

// 聞き取りで分かった「食べたいもの」と「食事で気をつけたいこと」が、周辺の場所の選び方に与える効果。
// 店がどの料理を出すか、食事の制限に対応しているかは祭りのデータにないので、
// 合う店があると決めつけず、データにあることだけで選ぶよう決まりを渡す。

export const FOOD_WISH_LABELS: Record<FoodWish, string> = {
  seafood: "海鮮",
  meat: "肉料理",
  vegetables: "野菜中心",
  noodles: "麺類",
  local_dish: "郷土料理",
  local_gourmet: "ご当地・B級グルメ",
  washoku: "和食",
  sweets: "甘味・カフェ",
  stalls: "屋台",
  local_drinks: "地酒・地ビール",
};

export const DIETARY_LABELS: Record<DietaryNeed, string> = {
  vegetarian: "ベジタリアン",
  vegan: "ヴィーガン",
  halal: "ハラール",
  allergy: "食物アレルギー",
  no_raw: "生ものが苦手",
};

export interface FoodEffects {
  /** 店での食事も探す（屋台のほかに食べたいものがある） */
  wantsShopMeals: boolean;
  /** 周辺係と旅程係に伝える、食事の決まり */
  rules: string[];
}

/** 食べたいもの・食事で気をつけたいことから、周辺の場所の選び方の決まりを作る */
export function foodEffects(
  conditions: Pick<PartialTripConditions, "foodWishes" | "dietary">,
): FoodEffects {
  const wishes = conditions.foodWishes ?? [];
  const dietary = conditions.dietary ?? [];
  const rules: string[] = [];

  if (wishes.length > 0) {
    rules.push(
      `食べたいもの（${wishes.map((w) => FOOD_WISH_LABELS[w]).join("・")}）に合う店と地元の味を先に挙げる。` +
        "合うかは場所の説明と地元の味から判断し、データにない料理を出すとは書かない。合う場所がなければそう伝え、昼・夜の食事は近くのほかの店で案を出す",
    );
  }
  if (dietary.length > 0) {
    rules.push(
      `食事で気をつけたいこと（${dietary.map((d) => DIETARY_LABELS[d]).join("・")}）がある。` +
        "店や屋台が対応しているかはデータにないので、対応しているとは書かず、行く前に店へ確かめるよう伝える",
    );
  }

  return { wantsShopMeals: wishes.some((wish) => wish !== "stalls"), rules };
}
