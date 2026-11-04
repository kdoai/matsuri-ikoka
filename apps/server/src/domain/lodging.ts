import {
  budgetPayers,
  type IsoDate,
  type Itinerary,
  type LatLng,
  type LodgingBudget,
  type LodgingSearch,
  type Party,
  type TripBudget,
  tripBudgetAmounts,
} from "@matsuri-ikoka/schema";
import { daysBetween } from "./calendar";
import type { ItineraryDraft } from "./itinerary";

// 宿の予算と距離の計算。宿の名前と料金は宿の空きを調べたツールの結果だけを使い、
// 合計・1人あたり・上限を超えるかは、ここで計算する（モデルに計算させない）。

/** 宿の人数の内訳。幼児は料金のかからない人数として分ける */
export interface LodgingHeadcount {
  /** 中学生以上（シニアを含む） */
  adults: number;
  /** 小学生 */
  elementary: number;
  /** 未就学の子ども */
  infants: number;
  /** 予算を割る人数（幼児を除く） */
  payers: number;
}

export function lodgingHeadcount(party: Party): LodgingHeadcount {
  const infants = party.infants ?? 0;
  const elementary = party.children - infants;
  return { adults: party.adults, elementary, infants, payers: budgetPayers(party) };
}

/** チェックインからチェックアウトまでの泊数 */
export function stayNights(checkIn: IsoDate, checkOut: IsoDate): number {
  return daysBetween(checkIn, checkOut);
}

export interface LodgingBudgetCheck {
  nights: number;
  /** 泊まり全体の合計（全員分・円） */
  totalYen: number;
  /** 泊まり全体の1人あたり（円、切り上げ） */
  perPersonYen: number;
  /** 1泊の1人あたり（円、切り上げ） */
  perPersonPerNightYen: number;
  /** 予算の上限から出した、泊まり全体の1人あたりの上限。予算がなければ null */
  limitPerPersonYen: number | null;
  /** 上限を超えるか。予算がなければ null */
  overBudget: boolean | null;
  /** 上限を超える額（1人あたり・泊まり全体）。超えなければ 0、予算がなければ null */
  overByPerPersonYen: number | null;
  /** 旅全体の予算の1人あたり（合計で受けたときは人数で割った額）。旅の予算がなければ null */
  tripBudgetPerPersonYen: number | null;
  /** 宿だけで旅全体の予算（1人あたり）を超えるか。旅の予算がなければ null */
  overTripBudget: boolean | null;
}

/**
 * 1泊の料金（全員分）から、泊まり全体の合計と1人あたりを出し、宿の予算の上限と比べる。
 * 旅全体の予算があれば、宿だけでその1人あたりを超えるかも出す
 */
export function checkLodgingBudget(
  nightlyTotalYen: number,
  options: {
    party: Party;
    nights: number;
    budget?: LodgingBudget | undefined;
    tripBudget?: TripBudget | undefined;
  },
): LodgingBudgetCheck {
  const { nights, budget } = options;
  const payers = Math.max(1, lodgingHeadcount(options.party).payers);
  const totalYen = nightlyTotalYen * nights;
  const perPersonYen = Math.ceil(totalYen / payers);
  const perPersonPerNightYen = Math.ceil(nightlyTotalYen / payers);
  const tripBudgetPerPersonYen =
    options.tripBudget === undefined
      ? null
      : tripBudgetAmounts(options.tripBudget, options.party).perPersonYen;
  const trip = {
    tripBudgetPerPersonYen,
    overTripBudget: tripBudgetPerPersonYen === null ? null : perPersonYen > tripBudgetPerPersonYen,
  };
  if (budget === undefined) {
    return {
      nights,
      totalYen,
      perPersonYen,
      perPersonPerNightYen,
      limitPerPersonYen: null,
      overBudget: null,
      overByPerPersonYen: null,
      ...trip,
    };
  }
  const limitPerPersonYen =
    budget.per === "night" ? budget.perPersonYen * nights : budget.perPersonYen;
  const overBy = Math.max(0, perPersonYen - limitPerPersonYen);
  return {
    nights,
    totalYen,
    perPersonYen,
    perPersonPerNightYen,
    limitPerPersonYen,
    overBudget: overBy > 0,
    overByPerPersonYen: overBy,
    ...trip,
  };
}

const EARTH_RADIUS_KM = 6371;

/** 2点の間の直線の距離（km、小数1桁）。道のりではないので、目安として扱う */
export function distanceKm(a: LatLng, b: LatLng): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  const km = 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
  return Math.round(km * 10) / 10;
}

/**
 * 旅程の下書きの泊まりに、調べた宿の候補を付ける。旅程係は宿の名前を書けないので、
 * この相談で調べた結果（チェックインの日ごと）を先に、なければ前の版の同じ日の候補を付ける
 */
export function attachLodging(
  draft: ItineraryDraft,
  options: { searches: ReadonlyMap<IsoDate, LodgingSearch>; previous: Itinerary | null },
): ItineraryDraft {
  const previousByDate = new Map(
    (options.previous?.days ?? []).flatMap((day) =>
      day.stay?.lodging === undefined ? [] : [[day.date, day.stay.lodging] as const],
    ),
  );
  return {
    ...draft,
    days: draft.days.map((day) => {
      if (day.stay === null) return day;
      const lodging = options.searches.get(day.date) ?? previousByDate.get(day.date);
      const { lodging: _written, ...plan } = day.stay;
      return { ...day, stay: lodging === undefined ? plan : { ...plan, lodging } };
    }),
  };
}
