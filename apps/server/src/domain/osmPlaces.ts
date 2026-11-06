import {
  type FoodWish,
  googleMapsUrl,
  type IsoDate,
  type LatLng,
  type LodgingOffer,
  type OpeningHours,
  type Weekday,
} from "@matsuri-ikoka/schema";
import { fromMinutes, weekdayOf } from "./calendar";
import { FOOD_WISH_LABELS } from "./food";
import { distanceKm } from "./lodging";
import {
  lodgingFromVenue,
  MAX_PROPOSED_LODGINGS,
  researchedLodgingId,
  VENUE_LODGING_KM,
} from "./lodgingResearch";
import type { ResearchedSpotReport } from "./nearbyResearch";
import { FOOD_WISH_KEYWORDS } from "./nearbySearch";

// OpenStreetMap（ODbL）の店と宿（data/places/osm-places.json）を、調べた場所の報告と宿の候補の形にする。
// 地図のデータなので、店の種類と位置は分かるが、行く日の営業までは分からない。営業はいつも「確かめられなかった」にする。
// 使う人に見せる場所には、必ず帰属の表示と元のページへのリンクを付ける。

/** 帰属の表示（出典の題名に使う） */
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";

export type OsmPlaceKind = "food" | "lodging";

export interface OsmPlace {
  type: "node" | "way" | "relation";
  id: number;
  name: string;
  location: LatLng;
  tags: Readonly<Record<string, string>>;
}

/** 店と宿の一覧を、中心からの半径で引く口。ないとき（mock やテスト）は使わない */
export interface OsmPlaceIndex {
  /** 中心に近い順に返す */
  find(kind: OsmPlaceKind, center: LatLng, radiusKm: number): OsmPlace[];
}

export function createOsmPlaceIndex(places: readonly OsmPlace[]): OsmPlaceIndex {
  return {
    find(kind, center, radiusKm) {
      return places
        .filter(
          (place) => (kind === "food" ? place.tags.amenity : place.tags.tourism) !== undefined,
        )
        .map((place) => ({ place, km: distanceKm(center, place.location) }))
        .filter(({ km }) => km <= radiusKm)
        .sort((a, b) => a.km - b.km)
        .map(({ place }) => place);
    },
  };
}

/** OpenStreetMap の場所のページ。使う人が元のデータと権利の表示をたどれる */
export function osmPageUrl(place: Pick<OsmPlace, "type" | "id">): string {
  return `https://www.openstreetmap.org/${place.type}/${place.id}`;
}

const CUISINE_FOODS: Readonly<Record<string, FoodWish>> = {
  ramen: "noodles",
  noodle: "noodles",
  soba: "noodles",
  udon: "noodles",
  sushi: "seafood",
  seafood: "seafood",
  fish: "seafood",
  kaisendon: "seafood",
  yakiniku: "meat",
  steak_house: "meat",
  steak: "meat",
  barbecue: "meat",
  burger: "meat",
  tonkatsu: "meat",
  yakitori: "meat",
  meat: "meat",
  japanese: "washoku",
  tempura: "washoku",
  donburi: "washoku",
  kaiseki: "washoku",
  regional: "local_dish",
  okonomiyaki: "local_gourmet",
  takoyaki: "local_gourmet",
  vegetarian: "vegetables",
  vegan: "vegetables",
  salad: "vegetables",
  coffee_shop: "sweets",
  cake: "sweets",
  dessert: "sweets",
  ice_cream: "sweets",
  crepe: "sweets",
};

/** 出す料理。cuisine のタグと、店の名前にある料理の言葉から決める（書かれていないものは足さない） */
export function osmFoods(place: Pick<OsmPlace, "name" | "tags">): FoodWish[] {
  const foods = new Set<FoodWish>();
  for (const word of (place.tags.cuisine ?? "").split(";")) {
    const food = CUISINE_FOODS[word.trim().toLowerCase()];
    if (food !== undefined) foods.add(food);
  }
  if (place.tags.amenity === "cafe") foods.add("sweets");
  for (const [wish, words] of Object.entries(FOOD_WISH_KEYWORDS) as [FoodWish, string[]][]) {
    // 屋台は祭りの屋台で叶うので、店の名前からは決めない
    if (wish !== "stalls" && words.some((word) => place.name.includes(word))) foods.add(wish);
  }
  return [...foods];
}

const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const OSM_DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/** 「Mo-We,Fr」を曜日の番号にする。読めなければ null */
function parseDays(text: string): number[] | null {
  const days = new Set<number>();
  for (const part of text.split(",")) {
    const [from, to] = part.trim().split("-");
    const start = OSM_DAYS.indexOf(from ?? "");
    const end = to === undefined ? start : OSM_DAYS.indexOf(to);
    if (start < 0 || end < 0) return null;
    for (let day = start; ; day = (day + 1) % 7) {
      days.add(day);
      if (day === end) break;
    }
  }
  return [...days];
}

/** 「11:00-15:00,17:30-21:30」を分の幅にする。読めなければ null */
function parseRanges(text: string): [number, number][] | null {
  const ranges: [number, number][] = [];
  for (const part of text.split(",")) {
    const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(part.trim());
    if (match === null) return null;
    const [, h1, m1, h2, m2] = match;
    const start = Number(h1) * 60 + Number(m1);
    let end = Number(h2) * 60 + Number(m2);
    if (end <= start) end += 1440;
    ranges.push([start, end]);
  }
  return ranges;
}

export interface OsmOpening {
  hours: OpeningHours | null;
  closedDays: Weekday[] | null;
  openOnDate: "closed" | "unconfirmed";
}

const UNKNOWN_OPENING: OsmOpening = { hours: null, closedDays: null, openOnDate: "unconfirmed" };

/**
 * opening_hours のタグの、よくある書き方だけを読む（24/7、曜日と時刻の並び、off）。
 * 読めない書き方（祝日の決まりのない条件、月ごとの違いなど）が1つでもあれば、分からないとして扱う。
 * 午前と午後に分かれた店は、最初の開店から最後の閉店までを営業時間にする
 */
export function parseOpeningHours(value: string | undefined, date: IsoDate): OsmOpening {
  if (value === undefined) return UNKNOWN_OPENING;
  const text = value.trim();
  if (text === "24/7") return { hours: null, closedDays: [], openOnDate: "unconfirmed" };

  const byDay = new Map<number, [number, number][] | "off">();
  for (const raw of text.split(";")) {
    const rule = raw.trim();
    if (rule === "") continue;
    // 祝日だけの決まりは、行く日が祝日かを見ないので読み飛ばす
    if (/^PH\b/.test(rule)) continue;
    const match = /^(?:([A-Z][a-z](?:[-,][A-Z][a-z])*)\s+)?(.+)$/.exec(rule);
    if (match === null) return UNKNOWN_OPENING;
    const [, dayText, timeText = ""] = match;
    const days = dayText === undefined ? [0, 1, 2, 3, 4, 5, 6] : parseDays(dayText);
    if (days === null) return UNKNOWN_OPENING;
    if (timeText === "off" || timeText === "closed") {
      for (const day of days) byDay.set(day, "off");
      continue;
    }
    const ranges = parseRanges(timeText);
    if (ranges === null) return UNKNOWN_OPENING;
    for (const day of days) byDay.set(day, ranges);
  }
  if (byDay.size === 0) return UNKNOWN_OPENING;

  const closedDays = WEEKDAYS.filter((_, day) => {
    const entry = byDay.get(day);
    return entry === undefined || entry === "off";
  });
  const today = byDay.get(WEEKDAYS.indexOf(weekdayOf(date)));
  if (today === undefined || today === "off") {
    return { hours: null, closedDays, openOnDate: "closed" };
  }
  const open = Math.min(...today.map(([start]) => start));
  const close = Math.max(...today.map(([, end]) => end));
  return {
    hours: { open: fromMinutes(open), close: fromMinutes(close % 1440) },
    closedDays,
    openOnDate: "unconfirmed",
  };
}

const DIETARY_TAGS = [
  ["diet:vegetarian", "vegetarian"],
  ["diet:vegan", "vegan"],
  ["diet:halal", "halal"],
] as const;

/** 店を、周辺係の調べと同じ形の報告にする（要約はタグからコードで作る） */
export function osmSpotReport(place: OsmPlace, date: IsoDate): ResearchedSpotReport {
  const foods = osmFoods(place);
  const opening = parseOpeningHours(place.tags.opening_hours, date);
  const label =
    foods.length > 0 ? `${foods.map((food) => FOOD_WISH_LABELS[food]).join("・")}の店` : "飲食店";
  return {
    name: place.name.slice(0, 60),
    kind: "food",
    summary: `${label}（OpenStreetMap の登録情報）`,
    location: place.location,
    foods,
    dietaryOk: DIETARY_TAGS.flatMap(([tag, need]) =>
      place.tags[tag] === "yes" || place.tags[tag] === "only" ? [need] : [],
    ),
    adultsOnly: false,
    pricePerPersonYen: null,
    price: null,
    ...opening,
    sources: [{ url: osmPageUrl(place), title: OSM_ATTRIBUTION }],
    ...(webPage(place) === null ? {} : { website: webPage(place) as string }),
  };
}

/** 宿の種類の言葉。社員寮のような、泊まれない場所は名前で除く */
const LODGING_LABELS: Readonly<Record<string, string>> = {
  hotel: "ホテル",
  guest_house: "旅館・民宿",
  hostel: "ホステル",
  motel: "モーテル",
};
const NOT_LODGING = /寮|dormitory|社宅|保養所/i;

function webPage(place: OsmPlace): string | null {
  const value = place.tags.website ?? place.tags["contact:website"];
  if (value === undefined) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * 会場に近い順に、宿の候補にする。空きと料金は分からないので null のままにする。
 * 宿のページが分からなければ、Google マップの検索のリンクを案内先にする
 */
export function osmLodgingOffers(
  places: readonly OsmPlace[],
  options: { venue: LatLng; checkedAt: string; today: IsoDate },
): LodgingOffer[] {
  return places
    .filter(
      (place) =>
        place.tags.tourism !== undefined &&
        !NOT_LODGING.test(place.name) &&
        distanceKm(options.venue, place.location) <= VENUE_LODGING_KM,
    )
    .sort((a, b) => distanceKm(options.venue, a.location) - distanceKm(options.venue, b.location))
    .slice(0, MAX_PROPOSED_LODGINGS)
    .map(
      (place): LodgingOffer => ({
        id: researchedLodgingId(place.name),
        name: place.name.slice(0, 60),
        nightlyTotalYen: null,
        summary: `${LODGING_LABELS[place.tags.tourism ?? ""] ?? "宿"}（OpenStreetMap の登録情報）`,
        bookingUrl: webPage(place) ?? googleMapsUrl(place),
        location: place.location,
        fromVenue: lodgingFromVenue(options.venue, place.location),
        perspectives: ["venue"],
        checkedAt: options.checkedAt,
        source: {
          url: osmPageUrl(place),
          title: OSM_ATTRIBUTION,
          checkedAt: options.today,
          confidence: "single",
        },
      }),
    );
}
