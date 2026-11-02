import type {
  Alternative,
  IsoDate,
  Itinerary,
  ItineraryItem,
  Party,
  Preferences,
  Verification,
  Weather,
} from "@matsuri-ikoka/schema";

// しおりが読む旅程の形。旅程の型（ItinerarySchema）に直接たよるのは、このファイルの toShioriTrip だけにする。
// 日ごとの予定（days）と、その夜に泊まる地域（stay）を持つ。

/** 旅の日数の上限（6泊7日） */
export const MAX_TRIP_DAYS = 7;

/** その夜に泊まる地域。宿の名前は持たない */
export interface TripStay {
  area: string;
  note?: string;
}

export interface TripDay {
  date: IsoDate;
  weather: Weather;
  items: ItineraryItem[];
  /** null はその日のうちに帰る（最後の日は必ず null） */
  stay: TripStay | null;
}

export interface ShioriTrip {
  id: string;
  version: number;
  title: string;
  origin: string;
  returnTo: string;
  party: Party;
  preferences: Preferences;
  mainFestivalId: string;
  verification: Verification;
  days: TripDay[];
  notes: string[];
  alternatives: Alternative[];
}

/** 旅程を、しおりが読む形にする。いまの旅程は1日分なので、その日のうちに帰る1日にする */
export function toShioriTrip(itinerary: Itinerary): ShioriTrip {
  return {
    id: itinerary.id,
    version: itinerary.version,
    title: itinerary.title,
    origin: itinerary.origin,
    returnTo: itinerary.returnTo,
    party: itinerary.party,
    preferences: itinerary.preferences,
    mainFestivalId: itinerary.mainFestivalId,
    verification: itinerary.verification,
    days: [
      { date: itinerary.date, weather: itinerary.weather, items: itinerary.items, stay: null },
    ],
    notes: itinerary.notes,
    alternatives: itinerary.alternatives,
  };
}
