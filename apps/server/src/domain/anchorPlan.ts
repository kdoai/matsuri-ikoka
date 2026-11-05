import {
  type AnchorPlan,
  type AnchorVisit,
  type Festival,
  type IsoDate,
  type LatLng,
  MAX_NIGHTS,
  MAX_ROUTE_AREAS,
  type MinuteRange,
  type Occurrence,
  type PACES,
  type PartialTripConditions,
  type Prefecture,
  type TripAnchor,
} from "@matsuri-ikoka/schema";
import { addDays, daysBetween, toMinutes } from "./calendar";
import { placeLabel, travelMinutesFrom } from "./dateWindow";
import { resolveDestination, shortPrefectureName } from "./destination";
import { distanceKm } from "./lodging";
import { nearestPrefecture, PREFECTURE_POINTS } from "./prefecturePoints";
import { estimateTravel, railMinutes, type StationPointIndex } from "./travelEstimate";

// 選んだ祭りを必ず行く場所にして、旅を組み立てる（docs/spec/festival-search.md の「祭りを固定した旅程」）。
// 祭りは必ず入れ、寄りたい場所は時間と距離で判断する。判断はすべてコードで行い、モデルに決めさせない。
// 例：A県の祭りを選んだ人が遠いB県・C県にも行きたいと言ったら、A県は必ず入れ、B県・C県は入るぶんだけ入れる。
// - 移動の時間は見積もりの幅の真ん中で比べる（下限は急ぎすぎ、上限は余裕を見すぎのため）
// - 出発の駅の位置が分からないと寄り道の長さを比べられないので、判断できない場所は maybe にして旅程係に渡す

type Pace = (typeof PACES)[number];

/** 1日に動ける時間（時間）。おまかせはふつうと同じ */
const DAY_HOURS: Readonly<Record<Pace, number>> = { relaxed: 8, normal: 10, packed: 12, auto: 10 };
/** 祭りに終わりの時刻がないときの、祭りの滞在の時間（分） */
const DEFAULT_FESTIVAL_STAY_MINUTES = 180;
/** 寄る場所の1か所の滞在の時間（分）。ゆっくりは4時間 */
const stopStayMinutes = (pace: Pace) => (pace === "relaxed" ? 240 : 180);
/** 祭りの日に出発できるいちばん早い時刻（祭りの開始までに使える時間を出す） */
const EARLIEST_DEPARTURE = "07:00";
/** 祭りのあとに、その日のうちに帰り着く時刻の上限（地方は終電が早いので、23時までに見ておく） */
const LATEST_HOME_MINUTES = 23 * 60;

export type AnchorRefusal = { status: 400 | 404; message: string };

/** アンカーの日を含む開催回。中止と延期の回は使わない。データにない日は null */
export function anchorOccurrence(festival: Festival, date: IsoDate): Occurrence | null {
  return (
    festival.occurrences.find(
      (o) =>
        o.status !== "cancelled" &&
        o.status !== "postponed" &&
        o.date <= date &&
        date <= (o.endDate ?? o.date),
    ) ?? null
  );
}

/**
 * アンカーを受けてよいかを確かめる。祭りがない・掲載停止は 404、データにない日や過ぎた日は 400。
 * today が null なら過ぎた日を断らない（記録の再生は、日付が記録のまま動かないため）
 */
export function refuseAnchor(
  festival: Festival | undefined,
  date: IsoDate,
  today: IsoDate | null,
): AnchorRefusal | null {
  if (festival === undefined || festival.optOut) {
    return { status: 404, message: "祭りが見つかりません。" };
  }
  if (anchorOccurrence(festival, date) === null) {
    return { status: 400, message: "その日は、この祭りの開催日としてデータにありません。" };
  }
  if (today !== null && date < today) {
    return { status: 400, message: "その日はすでに過ぎています。" };
  }
  return null;
}

/** 祭りの開催回の時間帯（旅の日の0時からの分）と滞在の長さ */
function festivalWindow(occurrence: Occurrence) {
  if (occurrence.start === null) {
    return { start: null, end: null, stay: DEFAULT_FESTIVAL_STAY_MINUTES };
  }
  const start = toMinutes(occurrence.start);
  if (occurrence.end === null) {
    return {
      start,
      end: start + DEFAULT_FESTIVAL_STAY_MINUTES,
      stay: DEFAULT_FESTIVAL_STAY_MINUTES,
    };
  }
  const raw = toMinutes(occurrence.end);
  const end = raw < start ? raw + 24 * 60 : raw;
  return { start, end, stay: end - start };
}

const middle = (range: MinuteRange) => Math.round((range[0] + range[1]) / 2);
const railBetween = (a: LatLng, b: LatLng) => middle(railMinutes(distanceKm(a, b)));

/** 時間を0.5時間きざみで切り上げた言い方 */
const hoursLabel = (minutes: number) => `約${Math.ceil(minutes / 30) / 2}時間`;
const nightsLabel = (nights: number) => (nights === 0 ? "日帰り" : `${nights}泊`);

interface Stop {
  prefecture: Prefecture;
  point: LatLng;
}

/** 計算で使う日の枠 */
interface DayFrame {
  dayMinutes: number;
  stay: number;
  /** 祭りの日のうち、祭りの前に使える時間（分） */
  roomBefore: number;
  /** 祭りの日のうち、祭りのあとに使える時間（分） */
  roomAfter: number;
}

function dayFrame(occurrence: Occurrence, dayMinutes: number): DayFrame {
  const { start, end, stay } = festivalWindow(occurrence);
  if (start === null || end === null) {
    const room = Math.max(0, Math.floor((dayMinutes - stay) / 2));
    return { dayMinutes, stay, roomBefore: room, roomAfter: room };
  }
  return {
    dayMinutes,
    stay,
    roomBefore: Math.max(0, start - toMinutes(EARLIEST_DEPARTURE)),
    roomAfter: Math.max(0, LATEST_HOME_MINUTES - end),
  };
}

/** 祭りの日に収まらないぶんに要る、前後の日の数 */
const extraDays = (minutes: number, room: number, dayMinutes: number) =>
  minutes <= room ? 0 : Math.ceil((minutes - room) / dayMinutes);

interface Route {
  before: Stop[];
  after: Stop[];
  /** 移動と滞在の合計（分） */
  minutes: number;
  /** 出発から祭りに着くまで（分） */
  beforeMinutes: number;
  /** 祭りの日のほかに要る日の数 */
  extra: number;
}

function* permutations<T>(items: readonly T[]): Generator<T[]> {
  if (items.length <= 1) {
    yield [...items];
    return;
  }
  for (const [index, item] of items.entries()) {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) yield [item, ...tail];
  }
}

interface RouteContext {
  frame: DayFrame;
  stopStay: number;
  originPoint: LatLng;
  venue: LatLng;
  /** 出発の駅と会場の間の移動（分） */
  originToVenue: number;
  /** 祭りの前に寄る場所を置けるか（祭りの日が今日なら、前の日へはずらせない） */
  festivalFirst: boolean;
}

/**
 * 寄る場所の組み合わせごとに、いちばん短い回り方を総当たりで探す（寄りたい場所は最大5件）。
 * 長さが同じなら、祭りの時刻に合う回り方（前後の日が少ない）、祭りの前に寄る場所が少ない回り方の順に選ぶ
 */
function bestRoute(stops: readonly Stop[], route: RouteContext): Route {
  const { frame, stopStay, originPoint, venue, originToVenue, festivalFirst } = route;
  let best: Route | null = null;
  for (const order of permutations<Stop | null>([null, ...stops])) {
    const at = order.indexOf(null);
    if (festivalFirst && at !== 0) continue;
    const before = order.slice(0, at) as Stop[];
    const after = order.slice(at + 1) as Stop[];
    const walk = (from: LatLng, places: readonly Stop[], to: LatLng) => {
      let total = 0;
      let here = from;
      for (const stop of places) {
        total += railBetween(here, stop.point) + stopStay;
        here = stop.point;
      }
      return total + railBetween(here, to);
    };
    const beforeMinutes = before.length === 0 ? originToVenue : walk(originPoint, before, venue);
    const afterMinutes = after.length === 0 ? originToVenue : walk(venue, after, originPoint);
    const candidate: Route = {
      before,
      after,
      minutes: beforeMinutes + frame.stay + afterMinutes,
      beforeMinutes,
      extra:
        extraDays(beforeMinutes, frame.roomBefore, frame.dayMinutes) +
        extraDays(afterMinutes, frame.roomAfter, frame.dayMinutes),
    };
    if (
      best === null ||
      candidate.minutes < best.minutes ||
      (candidate.minutes === best.minutes &&
        (candidate.extra < best.extra ||
          (candidate.extra === best.extra && before.length < best.before.length)))
    ) {
      best = candidate;
    }
  }
  return best as Route;
}

/** 祭りに無理なく行くのに要る泊数（寄り道を入れない往復で） */
function minNightsFor(originToVenue: number, frame: DayFrame): number {
  const windows =
    extraDays(originToVenue, frame.roomBefore, frame.dayMinutes) +
    extraDays(originToVenue, frame.roomAfter, frame.dayMinutes);
  const capacity = Math.ceil((originToVenue * 2 + frame.stay) / frame.dayMinutes) - 1;
  return Math.min(MAX_NIGHTS, Math.max(windows, capacity, 0));
}

/** 寄りたい場所の名前を都道府県に当てる。地方の名前は祭りにいちばん近い県に。当たらなければ null */
function resolveWish(
  wish: string,
  venue: LatLng,
  must: readonly Prefecture[],
): { prefecture: Prefecture; fromRegion: boolean } | null {
  const { prefectures, unknown } = resolveDestination([wish]);
  if (unknown.length > 0 || prefectures.length === 0) return null;
  const [only] = prefectures;
  if (prefectures.length === 1 && only !== undefined) {
    return { prefecture: only, fromRegion: false };
  }
  const own = prefectures.find((p) => must.includes(p));
  const prefecture = own ?? nearestPrefecture(venue, prefectures);
  return prefecture === null ? null : { prefecture, fromRegion: true };
}

export interface AnchorPlanInput {
  festival: Festival;
  anchor: TripAnchor;
  origin: string;
  nights: number;
  wishes: readonly string[];
  pace?: Pace | undefined;
  /** 旅の終わりの場所。回る順の最後に出す（移動の見積もりは出発の駅に戻るものとして比べる） */
  returnTo?: string | undefined;
  today: IsoDate;
}

/** 出発の駅と会場の間の移動（分の幅）。駅の位置があれば見積もり、なければデータの主要駅からの所要時間だけ */
function originEstimate(
  festival: Festival,
  origin: string,
  stations: StationPointIndex | undefined,
): MinuteRange | null {
  if (stations === undefined) return travelMinutesFrom(festival.access, origin);
  const estimate = estimateTravel(
    { access: festival.access, venue: festival.venue, origin },
    stations,
  );
  return estimate?.minutes ?? null;
}

/** 出発の駅の位置。同じ名前の駅がほかの土地にもあるときは、会場にいちばん近いものにする */
function originPointOf(
  origin: string,
  venue: LatLng,
  stations: StationPointIndex | undefined,
): LatLng | null {
  let best: LatLng | null = null;
  for (const point of stations?.find(origin) ?? []) {
    if (best === null || distanceKm(point, venue) < distanceKm(best, venue)) best = point;
  }
  return best;
}

/** 選んだ祭りを軸に、旅を組み立てる。アンカーは refuseAnchor で確かめてから渡す */
export function computeAnchorPlan(
  input: AnchorPlanInput,
  stations?: StationPointIndex,
): AnchorPlan {
  const { festival, anchor, origin, nights, wishes, today } = input;
  const occurrence = anchorOccurrence(festival, anchor.date);
  if (occurrence === null) {
    throw new Error(`祭り ${festival.id} に ${anchor.date} の開催回がありません`);
  }
  const pace = input.pace ?? "auto";
  const venue = { lat: festival.venue.lat, lng: festival.venue.lng };
  const must = [...new Set(festival.municipalities.map((m) => m.prefecture))];
  const frame = dayFrame(occurrence, DAY_HOURS[pace] * 60);
  const capacity = (nights + 1) * frame.dayMinutes;

  // 1. 名前を都道府県に当てる
  const resolved = wishes.map((name) => ({ name, match: resolveWish(name, venue, must) }));

  const estimate = originEstimate(festival, origin, stations);
  const originPoint = originPointOf(origin, venue, stations);
  const originToVenue = estimate === null ? null : middle(estimate);

  const decisions = new Map<Prefecture, { status: AnchorVisit["status"]; reason: string | null }>();
  let route: Route | null = null;
  const stops: Stop[] = [];
  for (const { match } of resolved) {
    // 2. 祭りと同じ県は判断するまでもなく入れる
    if (match === null || must.includes(match.prefecture)) continue;
    if (stops.some((s) => s.prefecture === match.prefecture)) continue;
    stops.push({ prefecture: match.prefecture, point: PREFECTURE_POINTS[match.prefecture] });
  }

  if (originPoint !== null && originToVenue !== null) {
    const context: RouteContext = {
      frame,
      stopStay: stopStayMinutes(pace),
      originPoint,
      venue,
      originToVenue,
      festivalFirst: daysBetween(today, anchor.date) <= 0,
    };
    const fits = (r: Route) => r.minutes <= capacity && r.extra <= nights;
    // 3〜5. 寄り道の増える時間が少ない場所から足していく
    let chosen: Stop[] = [];
    let rest = [...stops];
    route = bestRoute(chosen, context);
    let crossing: { stop: Stop; route: Route } | null = null;
    while (rest.length > 0) {
      let next: { stop: Stop; route: Route } | null = null;
      for (const stop of rest) {
        const tried = bestRoute([...chosen, stop], context);
        if (next === null || tried.minutes < next.route.minutes) next = { stop, route: tried };
      }
      if (next === null) break;
      if (!fits(next.route)) {
        crossing = next;
        break;
      }
      const taken = next.stop;
      chosen = [...chosen, taken];
      rest = rest.filter((s) => s !== taken);
      route = next.route;
      decisions.set(taken.prefecture, { status: "included", reason: null });
    }
    const settled = route;
    if (crossing !== null) {
      const over = crossing.route.minutes - capacity;
      decisions.set(crossing.stop.prefecture, {
        status: "maybe",
        reason:
          over > 0
            ? `入れると使える時間を${hoursLabel(over)}超えるので、時間に余裕があれば入れます`
            : "祭りの時刻に合わせると日程に収まりにくいので、時間に余裕があれば入れます",
      });
      const left = rest.filter((s) => s !== crossing?.stop);
      for (const stop of left) {
        const added = bestRoute([...chosen, stop], context).minutes - settled.minutes;
        decisions.set(stop.prefecture, {
          status: "dropped",
          reason: `寄ると移動と滞在が${hoursLabel(added)}増え、${nightsLabel(nights)}では収まらないので、今回は外します`,
        });
      }
    }
  }

  const visits: AnchorVisit[] = resolved.map(({ name, match }) => {
    if (match === null) {
      return {
        name,
        prefecture: null,
        status: "maybe",
        reason: "都道府県に当たらない地名なので、時間を見て旅程係が判断します",
      };
    }
    const { prefecture, fromRegion } = match;
    const region = fromRegion ? `${name}の中で祭りにいちばん近い${prefecture}に当てました。` : "";
    if (must.includes(prefecture)) {
      return { name, prefecture, status: "included", reason: fromRegion ? region : null };
    }
    const decision = decisions.get(prefecture);
    if (decision === undefined) {
      return {
        name,
        prefecture,
        status: "maybe",
        reason: `${region}出発の駅の位置が分からず移動の時間を見積もれないので、時間を見て旅程係が判断します`,
      };
    }
    const reason = `${region}${decision.reason ?? ""}`;
    return { name, prefecture, status: decision.status, reason: reason === "" ? null : reason };
  });

  // 6. 旅の日付。祭りの前に要る日のぶんだけ初日を前にずらす（今日より前にはしない）
  const needBefore =
    route === null ? 0 : extraDays(route.beforeMinutes, frame.roomBefore, frame.dayMinutes);
  const daysBefore = Math.min(nights, needBefore, Math.max(0, daysBetween(today, anchor.date)));
  const startDate = addDays(anchor.date, -daysBefore);

  // 7. 選んだ泊数で祭りに無理なく行けるか
  const minNights = originToVenue === null ? null : minNightsFor(originToVenue, frame);
  const warnings: string[] = [];
  if (originToVenue === null) {
    warnings.push(
      "出発の駅の位置が分からないので、移動の時間を見積もれませんでした。行き方を確かめてから組みます",
    );
  }
  if (minNights !== null && nights < minNights) {
    warnings.push(
      `${nightsLabel(nights)}では、この祭りに無理なく行けません（片道の目安は${hoursLabel(originToVenue ?? 0)}）。${minNights}泊あると安心です`,
    );
  }

  return {
    anchor,
    festivalName: festival.name.ja,
    mustPrefectures: must,
    visits,
    order: [
      origin,
      ...(route?.before ?? []).map((s) => s.prefecture),
      placeLabel(festival),
      ...(route?.after ?? []).map((s) => s.prefecture),
      input.returnTo ?? origin,
    ],
    startDate,
    endDate: addDays(startDate, nights),
    minNights,
    warnings,
  };
}

/** 相談の中の、寄りたい場所。回りたい地域と行き先を合わせる */
export function anchorWishes(conditions: PartialTripConditions): string[] {
  const names = [...(conditions.route?.areas ?? []), ...(conditions.destinations ?? [])];
  return [...new Set(names)].slice(0, MAX_ROUTE_AREAS);
}

/** 相談の状態のうち、アンカーに関わるところ */
export interface AnchoredState {
  anchor: TripAnchor | null;
  anchorPlan: AnchorPlan | null;
  conditions: PartialTripConditions;
}

/**
 * 相談の条件から AnchorPlan を計算し直し、希望日を旅の日付に合わせる。
 * 出発地か泊数がまだ分からなければ、組み立ては null のまま（聞き取りで分かったら、また呼ぶ）
 */
export function refreshAnchorPlan(
  state: AnchoredState,
  deps: {
    festival: Festival | undefined;
    stations?: StationPointIndex | undefined;
    today: IsoDate;
  },
): void {
  const { anchor, conditions } = state;
  if (anchor === null) {
    state.anchorPlan = null;
    return;
  }
  const { festival } = deps;
  const { origin, nights } = conditions;
  state.anchorPlan =
    festival !== undefined &&
    anchorOccurrence(festival, anchor.date) !== null &&
    origin !== undefined &&
    nights !== undefined
      ? computeAnchorPlan(
          {
            festival,
            anchor,
            origin,
            nights,
            wishes: anchorWishes(conditions),
            pace: conditions.pace,
            returnTo: conditions.returnTo,
            today: deps.today,
          },
          deps.stations,
        )
      : null;
  const plan = state.anchorPlan;
  state.conditions = {
    ...conditions,
    when:
      plan === null || plan.startDate === plan.endDate
        ? { kind: "date", date: anchor.date }
        : { kind: "range", from: plan.startDate, to: plan.endDate },
  };
}

/** update_itinerary で見る旅程の形 */
export interface AnchoredDraft {
  mainFestivalId: string;
  days: readonly {
    date: IsoDate;
    stay?: { area: string } | null | undefined;
    items: readonly {
      id: string;
      type: string;
      name: string;
      festivalId?: string | undefined;
      location?: LatLng | null | undefined;
    }[];
  }[];
}

export interface AnchorIssue {
  code:
    | "anchor_festival_changed"
    | "anchor_date_missing"
    | "anchor_outside_dates"
    | "anchor_visit_missing";
  itemId: string | null;
  message: string;
}

/** 旅程のどこかで、その都道府県に行くか（名前・泊まる地域・場所の位置・別の祭りの開催地で見る） */
function visitsPrefecture(
  draft: AnchoredDraft,
  prefecture: Prefecture,
  prefecturesOf: (festivalId: string) => readonly Prefecture[],
): boolean {
  const short = shortPrefectureName(prefecture);
  return draft.days.some(
    (day) =>
      day.stay?.area.includes(short) === true ||
      day.items.some(
        (item) =>
          item.name.includes(short) ||
          (item.festivalId !== undefined && prefecturesOf(item.festivalId).includes(prefecture)) ||
          (item.location != null && nearestPrefecture(item.location) === prefecture),
      ),
  );
}

/**
 * 旅程がアンカーを守っているかを確かめる。主役の祭り・祭りの日・旅の日付が違えば errors（保存しない）。
 * 入れるはずの場所がなければ warnings にとどめ、入らなかった理由を報告させる
 */
export function checkAnchoredItinerary(
  draft: AnchoredDraft,
  anchor: TripAnchor,
  plan: AnchorPlan | null,
  prefecturesOf: (festivalId: string) => readonly Prefecture[],
): { errors: AnchorIssue[]; warnings: AnchorIssue[] } {
  const errors: AnchorIssue[] = [];
  const warnings: AnchorIssue[] = [];
  if (draft.mainFestivalId !== anchor.festivalId) {
    errors.push({
      code: "anchor_festival_changed",
      itemId: null,
      message: `主役の祭りは ${anchor.festivalId} に固定されています（お客さまが選んだ祭りです）。mainFestivalId を変えないでください`,
    });
  }
  const onDate = draft.days.some(
    (day) =>
      day.date === anchor.date &&
      day.items.some((item) => item.type === "festival" && item.festivalId === anchor.festivalId),
  );
  if (!onDate) {
    errors.push({
      code: "anchor_date_missing",
      itemId: null,
      message: `主役の祭りの予定（type: "festival"、festivalId: ${anchor.festivalId}）を、お客さまが選んだ日（${anchor.date}）に入れてください`,
    });
  }
  if (plan !== null) {
    for (const day of draft.days) {
      if (day.date < plan.startDate || day.date > plan.endDate) {
        errors.push({
          code: "anchor_outside_dates",
          itemId: null,
          message: `旅の日付は ${plan.startDate}〜${plan.endDate} です。${day.date} は入れられません`,
        });
      }
    }
    for (const visit of plan.visits) {
      const { prefecture } = visit;
      if (
        visit.status === "included" &&
        prefecture !== null &&
        !plan.mustPrefectures.includes(prefecture) &&
        !visitsPrefecture(draft, prefecture, prefecturesOf)
      ) {
        warnings.push({
          code: "anchor_visit_missing",
          itemId: null,
          message: `入れる場所の「${visit.name}」（${prefecture}）が旅程にありません。入れるか、入らなかった理由を報告してください（まだ足す日があれば、足してから確かめます）`,
        });
      }
    }
  }
  return { errors, warnings };
}
