import type { NEARBY_TAGS, Popularity, Preferences } from "@matsuri-ikoka/schema";

type NearbyTag = (typeof NEARBY_TAGS)[number];

/** 子連れのときに休憩を入れる間隔（分） */
export const KIDS_REST_INTERVAL_MINUTES = 120;
/** シニアと一緒のときの、1回に歩く時間の目安の上限（分） */
export const SENIORS_MAX_WALK_MINUTES = 15;

/** こだわり4項目が旅程に与える効果。旅程係への指示と、旅程の検証の両方に使う */
export interface PreferenceEffects {
  /** 休憩を入れる間隔（分）。決まりがなければ null */
  restIntervalMinutes: number | null;
  /** 1回に歩く時間の上限（分）。決まりがなければ null */
  maxWalkMinutes: number | null;
  /** 周辺の場所で優先するタグ */
  preferTags: NearbyTag[];
  /** 屋台が使える時間帯でも、店での食事の予定を入れるか（屋台で十分なら入れない） */
  includeShopMeals: boolean;
  /** 地元の店での食事を予定に入れる */
  requireLocalMeal: boolean;
  /** 駐車場と交通規制を先に確かめる */
  checkParkingFirst: boolean;
  /** 旅程係に伝える、組み方の決まり */
  rules: string[];
}

export function preferenceEffects(preferences: Preferences): PreferenceEffects {
  const rules: string[] = [];
  const preferTags: NearbyTag[] = [];
  let restIntervalMinutes: number | null = null;
  let maxWalkMinutes: number | null = null;

  if (preferences.party === "kids") {
    restIntervalMinutes = KIDS_REST_INTERVAL_MINUTES;
    preferTags.push("kid_friendly", "indoor");
    rules.push(
      "2時間ごとに休憩を入れる",
      "トイレとベビーカーの情報を出す",
      "夜は冷え込みと帰りの混雑を避ける組み方にする",
    );
  } else if (preferences.party === "seniors") {
    maxWalkMinutes = SENIORS_MAX_WALK_MINUTES;
    preferTags.push("seating", "senior_friendly");
    rules.push("歩く距離を短くし、座れる場所を優先する");
  }

  if (preferences.spot === "classic") {
    rules.push("周辺の主な観光地と人気の店を優先する");
  } else if (preferences.spot === "hidden") {
    rules.push("大手の観光サイトに載っていない場所を優先する");
  } else {
    rules.push("定番と穴場を半分ずつ混ぜる");
  }

  const requireLocalMeal = preferences.food === "local";
  if (requireLocalMeal) {
    preferTags.push("local_food");
    rules.push("祭りの前後に、郷土料理や地元の店での食事を予定として入れる");
  } else {
    rules.push(
      "祭りの開催中の食事は屋台を食事の時間として扱う。祭りの前の昼など、屋台で食べられない時間帯の食事は店の予定を入れる",
    );
  }

  const checkParkingFirst = preferences.move === "car";
  if (checkParkingFirst) {
    rules.push("駐車場と交通規制を先に確かめる。駐車場のない祭りでは、電車をすすめる注意を出す");
  }

  return {
    restIntervalMinutes,
    maxWalkMinutes,
    preferTags,
    includeShopMeals: requireLocalMeal,
    requireLocalMeal,
    checkParkingFirst,
    rules,
  };
}

const POPULARITY_ORDER: Record<Preferences["spot"], readonly Popularity[] | null> = {
  classic: ["major", "regional", "local"],
  hidden: ["local", "regional", "major"],
  // おまかせは定番と穴場を混ぜるので、知名度で順位を付けない
  auto: null,
};

/** どんな場所（spot）のこだわりに対する、知名度の順位。小さいほど先に出す */
export function popularityRank(popularity: Popularity, spot: Preferences["spot"]): number {
  const order = POPULARITY_ORDER[spot];
  return order === null ? 0 : order.indexOf(popularity);
}
