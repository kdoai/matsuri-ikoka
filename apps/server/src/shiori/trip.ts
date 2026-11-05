import type {
  Alternative,
  IsoDate,
  Itinerary,
  ItineraryItem,
  LodgingSearch,
  Party,
  Preferences,
  TripBudget,
  Verification,
  Weather,
} from "@matsuri-ikoka/schema";

// しおりが読む旅程の形。旅程の型（ItinerarySchema）に直接たよるのは、このファイルの toShioriTrip だけにする。
// 日ごとの予定（days）と、その夜に泊まる地域と宿の候補（stay）を持つ。

/** 旅の日数の上限（6泊7日） */
export const MAX_TRIP_DAYS = 7;

/** その夜に泊まる地域と、調べた宿の候補（宿の名前は候補の中だけに持つ） */
export interface TripStay {
  area: string;
  note?: string;
  lodging?: LodgingSearch;
}

export interface TripDay {
  date: IsoDate;
  weather: Weather;
  items: ItineraryItem[];
  /** null はその日のうちに帰る（最後の日は必ず null） */
  stay: TripStay | null;
}

/** 旅のかたち：ずっと一か所 / 地域を巡る / 目的地へ向かう途中で祭りに寄る */
export type RouteShape = "stay" | "loop" | "via";
/** 旅のペース */
export type TripPace = "relaxed" | "normal" | "packed";
/** 祭りのほかに楽しみたいこと */
export type TripInterest = "onsen" | "food" | "nature" | "town_walk" | "history" | "shopping";

/**
 * 相談で聞いた旅の好み（どれも任意）。旅のかたちがなければ、泊まる地域と終わりの場所から決める。
 * 「おまかせ」は持たない（ないのと同じに扱う）
 */
export interface TripStyle {
  shape?: RouteShape;
  pace?: TripPace;
  interests?: TripInterest[];
}

export interface ShioriTrip {
  id: string;
  version: number;
  title: string;
  origin: string;
  returnTo: string;
  party: Party;
  preferences: Preferences;
  /** 旅の予算。聞き取っていなければない */
  budget?: TripBudget;
  mainFestivalId: string;
  verification: Verification;
  days: TripDay[];
  notes: string[];
  alternatives: Alternative[];
  style: TripStyle;
}

/** 旅程を、しおりが読む形にする */
export function toShioriTrip(itinerary: Itinerary, style: TripStyle = {}): ShioriTrip {
  return {
    id: itinerary.id,
    version: itinerary.version,
    title: itinerary.title,
    origin: itinerary.origin,
    returnTo: itinerary.returnTo,
    party: itinerary.party,
    preferences: itinerary.preferences,
    ...(itinerary.budget === undefined ? {} : { budget: itinerary.budget }),
    mainFestivalId: itinerary.mainFestivalId,
    verification: itinerary.verification,
    days: itinerary.days,
    notes: itinerary.notes,
    alternatives: itinerary.alternatives,
    style,
  };
}
