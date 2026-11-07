import {
  type Confidence,
  type Festival,
  type ItineraryItem,
  type LodgingOffer,
  type LodgingProvider,
  type LodgingSearch,
  type Source,
  tripBudgetAmounts,
  UNKNOWN,
  type Weather,
} from "@matsuri-ikoka/schema";
import { formatMonthDay, formatMonthDayWithWeekday } from "../domain/calendar";
import { placeLabel } from "../domain/dateWindow";
import { occurrenceOn } from "../domain/planCheck";
import { hasOfficialSource } from "../domain/verification";
import { chooseDesign, type PageKind, pagePlan, type ShioriDesign } from "./design";
import { type RouteView, routeOf } from "./route";
import type { ShioriTrip, TripDay, TripInterest, TripPace } from "./trip";

// しおりの見た目のためのデータ（view-model）。テンプレートに出す文字は、すべてここで決める。
// 祭りや店の名前・時刻・行き方は、旅程と祭りのデータにあるものだけを使い、分からない項目は「分からない」と出す。
// 持ち物の「いつもの持ち物」や季節の持ち物は、祭りの事実ではない一般の目安として、コードの決まった文で出す。

export const UNKNOWN_JA = "分からない";

/** 予定の種類と移動の手段ごとのアイコン（assets/shiori/svg/icon-*.svg） */
export type IconName =
  | "train"
  | "bus"
  | "walk"
  | "car"
  | "taxi"
  | "meal"
  | "sightseeing"
  | "rest"
  | "prep"
  | "festival"
  | "stay"
  | "sun"
  | "cloud"
  | "rain"
  | "umbrella"
  | "clock"
  | "pin"
  | "yen"
  | "camera"
  | "info"
  | "home"
  | "bag"
  | "warn"
  | "people"
  | "shirt"
  | "calendar";

export interface WeatherView {
  icon: IconName;
  text: string;
}

export interface TimelineRow {
  time: string;
  icon: IconName;
  kind: string;
  name: string;
  reason: string;
  /** 移動・営業時間・費用（ないものは出さない） */
  details: string[];
  festival: boolean;
}

/** 日の種類。祭りの日とそうでない日で、ページの見た目を変える */
export type DayKind = "festival" | "explore" | "travel" | "relax";

export interface DayView {
  number: number;
  kind: DayKind;
  /** 日の種類の見出し（祭りの日・めぐる日・移動の日・のんびりの日） */
  kindLabel: string;
  heading: string;
  dateLabel: string;
  weather: WeatherView;
  /** 出発（1日目）か、前の夜に泊まった地域 */
  startLabel: string;
  rows: TimelineRow[];
  stay: StayView | null;
  /** 最後の日の帰り */
  returnLabel: string | null;
  /** 主役の祭りの日には、雨の日・中止のときの案を出す */
  rainPlan: string[];
  /** 泊まりの旅で、この日のメモ欄の行数（予定が多くて紙面が残らない日は 0） */
  memoLines: number;
}

/** 提案する宿の1件 */
export interface LodgingOfferView {
  name: string;
  url: string;
  /** 会場からの距離と移動の目安・料金の目安（どれも分かるものだけ） */
  details: string[];
  summary: string | null;
}

/** その夜に泊まるところ。宿の候補がなければ、地域と注意だけ */
export interface StayView {
  area: string;
  note: string | null;
  offers: LodgingOfferView[];
  /** 宿の候補に添える注意（調べた日・空きと料金の注意・クレジット） */
  lodgingNotes: string[];
}

export interface FestivalView {
  id: string;
  nameJa: string;
  nameEn: string | null;
  categoryLabel: string;
  place: string;
  venue: string;
  scaleLabel: string;
  /** 旅程で行く日の開催（日付と時刻） */
  when: string[];
  highlights: string[];
  trivia: string[];
  food: { stalls: string; local: string[] };
  access: string[];
  /** 祭りのデータがない（名前は旅程から） */
  missing: boolean;
}

export interface ChecklistGroup {
  /** まとまりの見出しの印 */
  icon: IconName;
  title: string;
  note: string | null;
  items: string[];
}

export interface StampSlot {
  label: string;
  sub: string | null;
}

export interface SourceView {
  /** 出典の題名（なければ null で、URL だけを出す） */
  title: string | null;
  url: string;
  checkedAt: string;
  confidence: string;
}

export interface CoverView {
  brand: string;
  title: string;
  /** 長い題名は表紙で文字を小さくする */
  longTitle: boolean;
  lengthLabel: string;
  dateLabel: string;
  partyLabel: string;
  /** 旅の予算（例：1人あたり 30,000円まで（全員で 60,000円））。聞き取っていなければ null */
  budgetLabel: string | null;
  routeLabel: string;
  festivalName: string;
  festivalNameEn: string | null;
  place: string | null;
  weather: WeatherView;
  verifiedLabel: string | null;
  /** 要事前確認（公式以外の情報源で確かめた）のしおりの注意。公式で確かめていれば null */
  needsCheckLabel: string | null;
  greeting: string;
}

export interface OverviewRow {
  number: number;
  dateLabel: string;
  icon: IconName;
  summary: string;
  stay: string;
}

export interface ShioriView {
  id: string;
  version: number;
  docTitle: string;
  design: ShioriDesign;
  pages: PageKind[];
  cover: CoverView;
  overview: OverviewRow[];
  /** 旅のかたちの図（日帰りでは null） */
  route: RouteView | null;
  /** 旅のペースと楽しみたいこと（聞いていなければ空） */
  styleNotes: string[];
  festivals: FestivalView[];
  days: DayView[];
  checklist: ChecklistGroup[];
  stamps: StampSlot[];
  /** スタンプ帳のページの下に出すメモの見出し（泊まりの旅は日ごとのページにメモを置く） */
  memoPrompts: string[];
  sources: SourceView[];
  closing: string[];
}

export type FestivalLookup = (id: string) => Festival | undefined;

// ---------------------------------------------------------------------------
// 文言

const MOVE_LABELS = {
  walk: "徒歩",
  train: "電車",
  bus: "バス",
  car: "車",
  taxi: "タクシー",
} as const;
const ITEM_KIND_LABELS: Record<string, string> = {
  free: "自由な時間",
  move: "移動",
  sightseeing: "観光",
  meal: "食事",
  rest: "休憩",
  festival_prep: "祭りの前の準備",
  festival: "祭り",
};
const ITEM_ICONS: Record<string, IconName> = {
  free: "sun",
  sightseeing: "sightseeing",
  meal: "meal",
  rest: "rest",
  festival_prep: "prep",
  festival: "festival",
};
const CATEGORY_LABELS: Record<Festival["category"], string> = {
  fireworks: "花火",
  float: "山車・曳山",
  mikoshi: "神輿・行列",
  dance: "踊り",
  fire: "火祭り",
  lantern: "灯籠・提灯",
  performing_arts: "神楽・獅子舞などの芸能",
  ritual: "神事",
  market: "市・縁日",
  other: "祭り",
};
const SCALE_LABELS: Record<Festival["scaleTier"], string> = {
  XS: "ごく小さな祭り",
  S: "小さめの祭り",
  M: "中くらいの祭り",
  L: "大きな祭り",
};
const PARKING_LABELS = { available: "あり", limited: "少ない", none: "なし" } as const;
const STALL_LABELS = { yes: "屋台が出る", no: "屋台は出ない" } as const;
const ALTERNATIVE_LABELS = { rain: "雨の日", cancelled: "中止のとき", other: "そのほか" } as const;
const DAY_KIND_LABELS: Record<DayKind, string> = {
  festival: "祭りの日",
  explore: "めぐる日",
  travel: "移動の日",
  relax: "のんびりの日",
};
const PACE_LABELS: Record<TripPace, string> = {
  relaxed: "ゆっくり",
  normal: "ふつう",
  packed: "たっぷり",
};
const INTEREST_LABELS: Record<TripInterest, string> = {
  onsen: "温泉",
  food: "食",
  nature: "自然",
  town_walk: "街歩き",
  history: "歴史",
  shopping: "買い物",
};
const CONFIDENCE_LABELS: Record<Confidence, string> = {
  official: "公式",
  corroborated: "複数の情報源で一致",
  single: "1つの情報源",
  inferred: "推定",
};

const BASIC_ITEMS = [
  "飲み物",
  "ハンカチ・ティッシュ",
  "小銭（屋台やお賽銭に）",
  "ごみ袋（ごみは持ち帰る）",
];
const TRAIN_ITEMS = ["交通系 IC カード", "スマートフォンの充電（モバイルバッテリー）"];
const CAR_ITEMS = [
  "駐車場の場所（祭りの紹介の「アクセス」も見てください）",
  "スマートフォンの充電",
];
const SEASON_ITEMS: Record<ShioriDesign["season"], string[]> = {
  spring: ["羽織るもの（朝晩は冷える）"],
  summer: ["帽子", "汗ふきタオル", "虫よけ"],
  autumn: ["羽織るもの（日が暮れると冷える）"],
  winter: ["手袋・マフラー", "使い捨てカイロ"],
};
const KIDS_ITEMS = [
  "迷子のときの連絡先を書いたカード",
  "着替え",
  "おやつ",
  "はぐれたときの集合場所を決めておく",
];
const STAY_ITEMS = ["着替え", "歯ブラシなどの洗面用具", "充電器", "常備薬"];
const NIGHT_HINT = "懐中電灯（夜は足もとが暗いことがある）";

// ---------------------------------------------------------------------------

function joinRange([min, max]: readonly [number, number], unit: string): string {
  return min === max ? `${min}${unit}` : `${min}〜${max}${unit}`;
}

function moveDetail(item: ItineraryItem): string | null {
  if (item.move === null) return null;
  return `${MOVE_LABELS[item.move.means]} ${joinRange(item.move.minutes, "分")}（目安）${
    item.move.note ? `・${item.move.note}` : ""
  }`;
}

function rowFor(item: ItineraryItem): TimelineRow {
  const details = [
    moveDetail(item),
    item.hours
      ? `営業 ${item.hours.open}〜${item.hours.close}${item.hours.lastEntry ? `（最終入場 ${item.hours.lastEntry}）` : ""}`
      : null,
    item.cost ? `費用 ${item.cost}` : null,
  ].filter((v): v is string => v !== null);
  return {
    time: `${item.start}〜${item.end}`,
    icon: item.type === "move" ? (item.move?.means ?? "walk") : (ITEM_ICONS[item.type] ?? "pin"),
    kind: ITEM_KIND_LABELS[item.type] ?? "予定",
    name: item.name,
    reason: item.reason,
    details,
    festival: item.type === "festival",
  };
}

export function weatherView(weather: Weather): WeatherView {
  if (weather.status === "not_yet") {
    return { icon: "calendar", text: "まだ予報が出ていません。前の日に天気予報を確かめてください" };
  }
  if (weather.status === "unavailable") {
    return {
      icon: "calendar",
      text: "予報を取得できませんでした。前の日に天気予報を確かめてください",
    };
  }
  const parts = [
    weather.summary,
    weather.precipitationPercent === null ? null : `降水確率 ${weather.precipitationPercent}%`,
    weather.highC === null ? null : `最高 ${weather.highC}℃`,
    weather.lowC === null ? null : `最低 ${weather.lowC}℃`,
  ].filter((v): v is string => v !== null);
  const rainy = (weather.precipitationPercent ?? 0) >= 50 || /雨|雪/.test(weather.summary);
  const sunny = /晴/.test(weather.summary);
  return { icon: rainy ? "rain" : sunny ? "sun" : "cloud", text: parts.join("・") };
}

function rainyDay(day: TripDay): boolean {
  const w = day.weather;
  return w.status === "forecast" && ((w.precipitationPercent ?? 0) >= 50 || /雨/.test(w.summary));
}

function partyLabel(trip: ShioriTrip): string {
  const { adults, children } = trip.party;
  return `大人${adults}人${children > 0 ? `・子ども${children}人` : ""}`;
}

/** 旅の予算を、言われた数え方と、コードで換算したもう一方で書く */
export function budgetLabel(trip: ShioriTrip): string | null {
  if (trip.budget === undefined) return null;
  const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;
  const amounts = tripBudgetAmounts(trip.budget, trip.party);
  if (trip.budget.basis === "perPerson") {
    const total = amounts.totalYen === null ? "" : `（全員で ${yen(amounts.totalYen)}）`;
    return `1人あたり ${yen(trip.budget.yen)}まで${total}`;
  }
  const each = amounts.perPersonYen === null ? "" : `（1人あたり ${yen(amounts.perPersonYen)}）`;
  return `全員で ${yen(trip.budget.yen)}まで${each}`;
}

function lengthLabel(design: ShioriDesign, days: number): string {
  if (design.length === "outing") return "半日のお出かけ";
  if (design.length === "day_trip") return "日帰りのお出かけ";
  return `${days - 1}泊${days}日の旅`;
}

function dateRangeLabel(days: readonly TripDay[]): string {
  const first = days[0];
  const last = days[days.length - 1];
  if (first === undefined || last === undefined) return "";
  return first === last
    ? formatMonthDayWithWeekday(first.date)
    : `${formatMonthDayWithWeekday(first.date)}〜${formatMonthDayWithWeekday(last.date)}`;
}

/** 旅程に出てくる祭り（主役が先、あとは出てくる順） */
function festivalIdsOf(trip: ShioriTrip): string[] {
  const ids = [trip.mainFestivalId];
  for (const day of trip.days) {
    for (const item of day.items) {
      if (item.type === "festival" && item.festivalId && !ids.includes(item.festivalId)) {
        ids.push(item.festivalId);
      }
    }
  }
  return ids;
}

function festivalDays(trip: ShioriTrip, festivalId: string): TripDay[] {
  return trip.days.filter((day) =>
    day.items.some((item) => item.type === "festival" && item.festivalId === festivalId),
  );
}

function itemName(trip: ShioriTrip, festivalId: string): string {
  for (const day of trip.days) {
    const item = day.items.find((i) => i.type === "festival" && i.festivalId === festivalId);
    if (item) return item.name;
  }
  return festivalId;
}

function festivalView(trip: ShioriTrip, id: string, festival: Festival | undefined): FestivalView {
  const days = festivalDays(trip, id);
  if (festival === undefined) {
    return {
      id,
      nameJa: itemName(trip, id),
      nameEn: null,
      categoryLabel: "祭り",
      place: UNKNOWN_JA,
      venue: UNKNOWN_JA,
      scaleLabel: UNKNOWN_JA,
      when: days.map((d) => formatMonthDayWithWeekday(d.date)),
      highlights: [],
      trivia: [],
      food: { stalls: UNKNOWN_JA, local: [] },
      access: [],
      missing: true,
    };
  }
  const when = days.map((day) => {
    const occurrence = occurrenceOn(festival, day.date);
    const time =
      occurrence?.start != null
        ? `${occurrence.start}〜${occurrence.end ?? ""}`
        : `時刻は${UNKNOWN_JA}`;
    return `${formatMonthDayWithWeekday(day.date)} ${time}`;
  });
  const { access } = festival;
  return {
    id,
    nameJa: festival.name.ja,
    nameEn: festival.name.en ?? null,
    categoryLabel: CATEGORY_LABELS[festival.category],
    place: placeLabel(festival),
    venue: festival.venue.name,
    scaleLabel: SCALE_LABELS[festival.scaleTier],
    when,
    highlights: festival.highlights.slice(0, 3),
    trivia: festival.trivia.slice(0, 2).map((t) => t.text),
    food: {
      stalls:
        festival.food.stalls === UNKNOWN
          ? `屋台は${UNKNOWN_JA}`
          : STALL_LABELS[festival.food.stalls],
      local: festival.food.local.map((f) => (f.note ? `${f.name}：${f.note}` : f.name)),
    },
    access: [
      ...access.stations.map(
        (s) =>
          `${s.name}から徒歩 ${joinRange(s.walkMinutes, "分")}（目安）${s.note ? `・${s.note}` : ""}`,
      ),
      ...access.fromHubs.map(
        (h) => `${h.hub}から ${joinRange(h.minutes, "分")}（目安）${h.route ? `・${h.route}` : ""}`,
      ),
      `駐車場：${access.parking === UNKNOWN ? UNKNOWN_JA : PARKING_LABELS[access.parking]}`,
      ...access.trafficRestrictions.map((t) => `交通規制：${t}`),
    ],
    missing: false,
  };
}

function rainPlan(trip: ShioriTrip, mainFestival: Festival | undefined, day: TripDay): string[] {
  const policy = mainFestival ? occurrenceOn(mainFestival, day.date)?.rainPolicy : null;
  return [
    ...(policy ? [`雨天の扱い：${policy}`] : []),
    ...trip.alternatives.map((a) => `${ALTERNATIVE_LABELS[a.kind]}：${a.summary}`),
  ];
}

/** 祭りがあれば祭りの日。なければ、観光があればめぐる日、移動だけなら移動の日、ほかはのんびりの日 */
export function dayKindOf(day: Pick<TripDay, "items">): DayKind {
  const types = new Set<string>(day.items.map((i) => i.type));
  if (types.has("festival")) return "festival";
  if (types.has("sightseeing")) return "explore";
  if ([...types].every((t) => t === "move" || t === "meal")) return "travel";
  return "relax";
}

function styleNotes(trip: ShioriTrip): string[] {
  const { pace, interests } = trip.style;
  return [
    ...(pace ? [`ペース：${PACE_LABELS[pace]}`] : []),
    ...(interests && interests.length > 0
      ? [`祭りのほかの楽しみ：${interests.map((i) => INTEREST_LABELS[i]).join("・")}`]
      : []),
  ];
}

/** 会場から宿までの目安の文（直線の距離からの計算なので「目安」と書く） */
export function fromVenueLabel(offer: Pick<LodgingOffer, "fromVenue">): string | null {
  const from = offer.fromVenue;
  if (from === undefined) return null;
  const [min, max] = from.minutes;
  const minutes = min === max ? `${min}分` : `${min}〜${max}分`;
  return from.mode === "walk"
    ? `会場から約${from.distanceKm}km・徒歩${minutes}（目安）`
    : `会場から約${from.distanceKm}km・バスやタクシーで${minutes}（目安）`;
}

const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;

/** 料金の目安の文。空室検索の1泊の合計、ページの1泊1人の幅、ページの料金の文の順に使う。分からなければ null */
export function lodgingPriceLabel(
  offer: Pick<LodgingOffer, "nightlyTotalYen" | "perPersonNightYen" | "priceNote">,
): string | null {
  if (offer.nightlyTotalYen !== null) return `1泊 全員で${yen(offer.nightlyTotalYen)}から`;
  if (offer.perPersonNightYen !== undefined) {
    const [min, max] = offer.perPersonNightYen;
    return `1泊1人 ${min === max ? yen(min) : `${yen(min)}〜${yen(max)}`}（宿のページの目安）`;
  }
  return offer.priceNote ?? null;
}

const LODGING_PROVIDER_NOTES: Record<LodgingProvider, string> = {
  rakuten: "空きと料金は、調べた時点のものです。予約の時点で変わることがあります。",
  web: "宿のページで調べた候補です。空きは調べていないので、空きと料金は予約のページで確かめてください。",
  fictional: "（架空）と付いた宿は、見本です。本物の宿ではありません。",
};

function lodgingNotes(search: LodgingSearch): string[] {
  const provider = search.provider ?? "rakuten";
  return [
    `${formatMonthDay(search.searchedAt.slice(0, 10))}に調べた宿の候補です。${LODGING_PROVIDER_NOTES[provider]}`,
    // クレジットは、楽天の結果と分かるときだけ出す（調べた方法を持たない古い版には出さない）
    ...(search.provider === "rakuten" ? ["Supported by Rakuten Developers"] : []),
  ];
}

function stayView(stay: NonNullable<TripDay["stay"]>): StayView {
  const offers = (stay.lodging?.offers ?? []).slice(0, 3).map(
    (offer): LodgingOfferView => ({
      name: offer.name,
      url: offer.bookingUrl,
      details: [fromVenueLabel(offer), lodgingPriceLabel(offer)].filter(
        (d): d is string => d !== null,
      ),
      summary: offer.summary ?? null,
    }),
  );
  return {
    area: stay.area,
    note: stay.note ?? null,
    offers,
    lodgingNotes: stay.lodging !== undefined && offers.length > 0 ? lodgingNotes(stay.lodging) : [],
  };
}

function dayViews(trip: ShioriTrip, mainFestival: Festival | undefined): DayView[] {
  const lastIndex = trip.days.length - 1;
  return trip.days.map((day, index) => {
    const previous = trip.days[index - 1];
    const isMain = day.items.some(
      (i) => i.type === "festival" && i.festivalId === trip.mainFestivalId,
    );
    const kind = dayKindOf(day);
    const plan = isMain ? rainPlan(trip, mainFestival, day) : [];
    return {
      number: index + 1,
      kind,
      kindLabel: DAY_KIND_LABELS[kind],
      heading: trip.days.length === 1 ? "当日の流れ" : `${index + 1}日目`,
      dateLabel: formatMonthDayWithWeekday(day.date),
      weather: weatherView(day.weather),
      startLabel:
        index === 0
          ? `${trip.origin}から出発`
          : previous?.stay
            ? `${previous.stay.area}から出発`
            : "前の日の宿から出発",
      rows: day.items.map(rowFor),
      stay: day.stay ? stayView(day.stay) : null,
      returnLabel: index === lastIndex ? `${trip.returnTo}に帰る` : null,
      rainPlan: plan,
      memoLines:
        trip.days.length > 1
          ? Math.max(
              0,
              Math.min(4, 4 - Math.max(0, day.items.length - 3) - (plan.length > 0 ? 2 : 0)),
            )
          : 0,
    };
  });
}

function overviewRows(trip: ShioriTrip): OverviewRow[] {
  return trip.days.map((day, index) => {
    const festival = day.items.find((i) => i.type === "festival");
    const highlight = festival ?? day.items.find((i) => i.type !== "move") ?? day.items[0];
    return {
      number: index + 1,
      dateLabel: formatMonthDayWithWeekday(day.date),
      icon: festival ? "festival" : (rowFor(highlight as ItineraryItem).icon as IconName),
      summary: highlight ? highlight.name : "",
      stay: day.stay ? day.stay.area : `${trip.returnTo}に帰る`,
    };
  });
}

function checklist(trip: ShioriTrip, design: ShioriDesign): ChecklistGroup[] {
  const groups: ChecklistGroup[] = [];
  if (trip.notes.length > 0) {
    groups.push({ icon: "info", title: "旅程係のメモ", note: null, items: [...trip.notes] });
  }
  const anyRain = trip.days.some(rainyDay);
  const night = trip.days.some((d) =>
    d.items.some((i) => i.type === "festival" && Number(i.end.slice(0, 2)) >= 18),
  );
  const everyday = [
    ...(anyRain ? ["雨具（降水確率が高い日があります）"] : ["折りたたみ傘"]),
    ...BASIC_ITEMS,
    ...(trip.preferences.move === "car" ? CAR_ITEMS : TRAIN_ITEMS),
    ...(night ? [NIGHT_HINT] : []),
    ...SEASON_ITEMS[design.season],
  ];
  groups.push({ icon: "bag", title: "いつもの持ち物", note: "一般的な目安です", items: everyday });
  if (trip.days.length > 1) {
    const nights = trip.days.length - 1;
    groups.push({
      icon: "stay",
      title: `泊まりの分（${nights}泊）`,
      note: null,
      items: STAY_ITEMS.map((item) => (item === "着替え" ? `着替え（${nights}泊分）` : item)),
    });
  }
  if (design.kids)
    groups.push({ icon: "people", title: "子どもと一緒", note: null, items: KIDS_ITEMS });
  return groups;
}

function stampSlots(trip: ShioriTrip, festivals: readonly FestivalView[]): StampSlot[] {
  const slots: StampSlot[] = [];
  if (trip.days.length > 1) {
    trip.days.forEach((day, index) => {
      slots.push({ label: `${index + 1}日目`, sub: formatMonthDay(day.date) });
    });
  }
  for (const f of festivals) slots.push({ label: f.nameJa, sub: "祭りの記念" });
  for (const label of ["見つけたもの", "おいしかったもの", "おみやげ"]) {
    if (slots.length >= 9) break;
    slots.push({ label, sub: null });
  }
  return slots.slice(0, 9);
}

function confidenceLabel(c: Confidence): string {
  return CONFIDENCE_LABELS[c];
}

function collectSources(trip: ShioriTrip, festivals: readonly (Festival | undefined)[]): Source[] {
  const all: Source[] = [
    ...trip.days.flatMap((d) => d.items.flatMap((i) => i.sources)),
    ...trip.days.flatMap((d) => (d.weather.status === "forecast" ? [d.weather.source] : [])),
    ...(trip.verification.status === "pending" ? [] : trip.verification.sources),
  ];
  for (const f of festivals) {
    if (f === undefined) continue;
    const occurrences = trip.days
      .map((d) => occurrenceOn(f, d.date))
      .filter((o): o is NonNullable<typeof o> => o !== null);
    all.push(
      ...f.sources,
      ...occurrences.flatMap((o) => o.sources),
      ...f.access.sources,
      ...f.food.local.flatMap((l) => l.sources),
      ...f.trivia.slice(0, 2).map((t) => t.source),
    );
  }
  const byUrl = new Map<string, Source>();
  for (const s of all) if (!byUrl.has(s.url)) byUrl.set(s.url, s);
  return [...byUrl.values()];
}

function verifiedLabel(trip: ShioriTrip): string | null {
  const v = trip.verification;
  if (v.status !== "as_planned" || !hasOfficialSource(v.sources)) return null;
  const [date, time] = v.checkedAt.split("T") as [string, string];
  return `公式情報で開催予定を確認済み（${formatMonthDay(date)} ${time.slice(0, 5)}）`;
}

/** 要事前確認のしおりに必ず出す注意 */
export const NEEDS_CHECK_LABEL =
  "要事前確認：開催は公式以外の情報源などで確かめています。出発の前に、主催者の案内で開催を確かめてください";

function needsCheckLabel(trip: ShioriTrip): string | null {
  return trip.verification.status === "needs_check" ? NEEDS_CHECK_LABEL : null;
}

/** しおりの view-model を作る */
export function buildShioriView(trip: ShioriTrip, lookup: FestivalLookup): ShioriView {
  const festivalIds = festivalIdsOf(trip);
  const festivalData = festivalIds.map((id) => lookup(id));
  const main = festivalData[0];
  const mainDay =
    trip.days.find((d) =>
      d.items.some((i) => i.type === "festival" && i.festivalId === trip.mainFestivalId),
    ) ?? (trip.days[0] as TripDay);
  const design = chooseDesign(trip, main, mainDay.date);
  const festivals = festivalIds.map((id, i) => festivalView(trip, id, festivalData[i]));
  const pages = pagePlan(design, trip.days.length, festivals.length);
  const mainView = festivals[0] as FestivalView;

  return {
    id: trip.id,
    version: trip.version,
    docTitle: `${trip.title}｜旅のしおり`,
    design,
    pages,
    cover: {
      brand: "MATSURI IKOKA 旅のしおり",
      title: trip.title,
      longTitle: [...trip.title].length > 14,
      lengthLabel: lengthLabel(design, trip.days.length),
      dateLabel: dateRangeLabel(trip.days),
      partyLabel: partyLabel(trip),
      budgetLabel: budgetLabel(trip),
      routeLabel:
        trip.origin === trip.returnTo
          ? `${trip.origin}から`
          : `${trip.origin}から ${trip.returnTo}まで`,
      festivalName: mainView.nameJa,
      festivalNameEn: mainView.nameEn,
      place: mainView.missing ? null : `${mainView.place}・${mainView.venue}`,
      weather: weatherView(mainDay.weather),
      verifiedLabel: verifiedLabel(trip),
      needsCheckLabel: needsCheckLabel(trip),
      greeting:
        design.length === "overnight"
          ? "いってらっしゃい！ 旅のあいだ、このしおりがお供します"
          : "いってらっしゃい！ 気をつけて楽しんできてください",
    },
    overview: overviewRows(trip),
    route: routeOf(trip),
    styleNotes: styleNotes(trip),
    festivals,
    days: dayViews(trip, main),
    checklist: checklist(trip, design),
    stamps: stampSlots(trip, festivals),
    memoPrompts:
      design.length === "day_trip" ? ["いちばん心に残ったこと", "次に行ってみたい祭り"] : [],
    sources: collectSources(trip, festivalData).map((s) => ({
      title: s.title ?? null,
      url: s.url,
      checkedAt: s.checkedAt,
      confidence: confidenceLabel(s.confidence),
    })),
    closing: [
      "移動の時間はすべて目安です。",
      "出かける前と当日の朝に、公式の情報で開催を確かめてください。",
    ],
  };
}
