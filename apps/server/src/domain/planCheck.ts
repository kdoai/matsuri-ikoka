import type {
  Festival,
  IsoDate,
  ItineraryItem,
  NearbySpot,
  Occurrence,
  Preferences,
} from "@matsuri-ikoka/schema";
import { arrivalBufferMinutes } from "./arrivalBuffer";
import { formatMonthDay, fromMinutes, toMinutes } from "./calendar";
import { isClosedOn } from "./nearby";
import { preferenceEffects } from "./preferences";

// 旅程の検証。予定の重なり、移動の時間、営業時間の外、休業日、祭りの時間とのぶつかり、到着の余裕を確かめる。
// errors があれば旅程を保存しない。warnings は保存するが、旅程係に直すよう伝える。

export type PlanIssueCode =
  | "out_of_order"
  | "overlap"
  | "not_enough_move_time"
  | "unknown_spot"
  | "closed_day"
  | "outside_hours"
  | "after_last_entry"
  | "unknown_festival"
  | "festival_not_on_date"
  | "festival_time_conflict"
  | "arrival_buffer"
  | "rest_interval"
  | "local_meal_missing"
  | "shop_meal_unwanted"
  | "long_walk";

export interface PlanIssue {
  code: PlanIssueCode;
  /** 問題のある予定。旅程全体の問題なら null */
  itemId: string | null;
  message: string;
}

export interface PlanCheckResult {
  errors: PlanIssue[];
  warnings: PlanIssue[];
}

export type PlanItem = Pick<
  ItineraryItem,
  "id" | "start" | "end" | "type" | "name" | "move" | "festivalId" | "spotId"
>;

export interface PlanToCheck {
  date: IsoDate;
  mainFestivalId: string;
  preferences: Preferences;
  items: readonly PlanItem[];
}

/** 深夜の予定（日をまたいだとみなす）の境目 */
const LATE_NIGHT_FROM = 18 * 60;
const EARLY_MORNING_UNTIL = 6 * 60;

interface TimedItem {
  item: PlanItem;
  /** 旅の日の0時からの分。日をまたぐと 1440 を超える */
  start: number;
  end: number;
}

/** 予定を時刻順に並べ、日をまたぐ予定を翌日の時刻として扱う */
function toTimeline(items: readonly PlanItem[], errors: PlanIssue[]): TimedItem[] {
  const timeline: TimedItem[] = [];
  let dayOffset = 0;
  for (const item of items) {
    const clock = toMinutes(item.start);
    let start = clock + dayOffset;
    const previous = timeline.at(-1);
    if (previous !== undefined && start < previous.start) {
      if (previous.start % 1440 >= LATE_NIGHT_FROM && clock < EARLY_MORNING_UNTIL) {
        dayOffset += 1440;
        start += 1440;
      } else {
        errors.push({
          code: "out_of_order",
          itemId: item.id,
          message: `「${item.name}」が前の予定より早い時刻になっています。予定は時刻の順に並べてください`,
        });
      }
    }
    let end = toMinutes(item.end) + dayOffset;
    if (end < start) end += 1440;
    timeline.push({ item, start, end });
  }
  return timeline;
}

/** その日にかかる開催回 */
export function occurrenceOn(festival: Festival, date: IsoDate): Occurrence | null {
  return (
    festival.occurrences.find(
      (o) => o.status !== "cancelled" && o.date <= date && date <= (o.endDate ?? o.date),
    ) ?? null
  );
}

function clockRange(start: string, end: string): [number, number] {
  const from = toMinutes(start);
  let to = toMinutes(end);
  if (to < from) to += 1440;
  return [from, to];
}

function checkSpot(item: PlanItem, spot: NearbySpot, date: IsoDate, errors: PlanIssue[]) {
  if (isClosedOn(spot, date)) {
    errors.push({
      code: "closed_day",
      itemId: item.id,
      message: `「${spot.name}」は${formatMonthDay(date)}が定休日です`,
    });
    return;
  }
  if (spot.hours === null) return;
  const [open, close] = clockRange(spot.hours.open, spot.hours.close);
  const [start, end] = clockRange(item.start, item.end);
  if (start < open || end > close) {
    errors.push({
      code: "outside_hours",
      itemId: item.id,
      message: `「${spot.name}」の営業時間（${spot.hours.open}〜${spot.hours.close}）の外に予定が入っています`,
    });
  } else if (spot.hours.lastEntry !== undefined && start > toMinutes(spot.hours.lastEntry)) {
    errors.push({
      code: "after_last_entry",
      itemId: item.id,
      message: `「${spot.name}」の最終入場（${spot.hours.lastEntry}）より後に着く予定です`,
    });
  }
}

/**
 * 旅程を検証する。findFestival は祭りのデータから祭りを引く関数（掲載停止の祭りは返さない）。
 */
export function checkPlan(
  plan: PlanToCheck,
  findFestival: (id: string) => Festival | undefined,
): PlanCheckResult {
  const errors: PlanIssue[] = [];
  const warnings: PlanIssue[] = [];
  const timeline = toTimeline(plan.items, errors);

  // 重なりと移動の時間
  timeline.forEach((current, index) => {
    const { item } = current;
    if (
      item.type === "move" &&
      item.move !== null &&
      current.end - current.start < item.move.minutes[0]
    ) {
      errors.push({
        code: "not_enough_move_time",
        itemId: item.id,
        message: `「${item.name}」の時間が、移動の目安（${item.move.minutes[0]}分〜）より短くなっています`,
      });
    }
    const previous = timeline[index - 1];
    if (previous === undefined) return;
    if (current.start < previous.end) {
      errors.push({
        code: "overlap",
        itemId: item.id,
        message: `「${item.name}」が前の予定「${previous.item.name}」と重なっています`,
      });
    } else if (
      item.type !== "move" &&
      item.move !== null &&
      previous.end + item.move.minutes[0] > current.start
    ) {
      errors.push({
        code: "not_enough_move_time",
        itemId: item.id,
        message: `「${previous.item.name}」から「${item.name}」への移動（${item.move.minutes[0]}分〜）が間に合いません`,
      });
    }
  });

  // 主役の祭り
  const main = findFestival(plan.mainFestivalId);
  const festivals = new Map<string, Festival>();
  if (main === undefined) {
    errors.push({
      code: "unknown_festival",
      itemId: null,
      message: `祭り「${plan.mainFestivalId}」は祭りのデータにありません`,
    });
  } else {
    festivals.set(main.id, main);
  }
  for (const { festivalId } of plan.items) {
    if (festivalId === undefined || festivals.has(festivalId)) continue;
    const festival = findFestival(festivalId);
    if (festival === undefined) {
      errors.push({
        code: "unknown_festival",
        itemId: null,
        message: `祭り「${festivalId}」は祭りのデータにありません`,
      });
    } else {
      festivals.set(festival.id, festival);
    }
  }

  // 周辺の場所：定休日と営業時間
  const spots = new Map<string, NearbySpot>();
  for (const festival of festivals.values()) {
    for (const spot of festival.nearby) spots.set(spot.id, spot);
  }
  for (const item of plan.items) {
    if (item.spotId === undefined) continue;
    const spot = spots.get(item.spotId);
    if (spot === undefined) {
      errors.push({
        code: "unknown_spot",
        itemId: item.id,
        message: `「${item.name}」（${item.spotId}）は、祭りの周辺の場所のデータにありません`,
      });
    } else {
      checkSpot(item, spot, plan.date, errors);
    }
  }

  // 祭りの時間：開催日、開催時間とのぶつかり、到着の余裕
  if (main !== undefined) {
    const occurrence = occurrenceOn(main, plan.date);
    if (occurrence === null) {
      errors.push({
        code: "festival_not_on_date",
        itemId: null,
        message: `「${main.name.ja}」は${formatMonthDay(plan.date)}に開かれません`,
      });
    } else {
      checkFestivalTime(main, occurrence, timeline, errors);
    }
  }

  warnings.push(...preferenceWarnings(plan, timeline, spots));
  return { errors, warnings };
}

function checkFestivalTime(
  festival: Festival,
  occurrence: Occurrence,
  timeline: readonly TimedItem[],
  errors: PlanIssue[],
) {
  const index = timeline.findIndex(
    ({ item }) => item.type === "festival" && item.festivalId === festival.id,
  );
  const entry = timeline[index];
  if (entry === undefined) return;

  if (occurrence.start !== null && occurrence.end !== null) {
    const [open, close] = clockRange(occurrence.start, occurrence.end);
    const [start, end] = clockRange(entry.item.start, entry.item.end);
    if (start < open || end > close) {
      errors.push({
        code: "festival_time_conflict",
        itemId: entry.item.id,
        message: `祭りの予定は、開催時間（${occurrence.start}〜${occurrence.end}）の中に入れてください`,
      });
    }
  }

  // 準備（到着の余裕・場所取り・申し込み）を除いた、祭りの前の最後の予定から会場へ着く時刻
  let previousIndex = index - 1;
  while (previousIndex >= 0 && timeline[previousIndex]?.item.type === "festival_prep") {
    previousIndex -= 1;
  }
  const previous = timeline[previousIndex];
  if (previous === undefined) return;
  const walkToVenue = timeline[previousIndex + 1]?.item.move?.minutes[1] ?? 0;
  const arrival = previous.end + walkToVenue;
  const buffer = arrivalBufferMinutes(festival);
  const festivalStart =
    occurrence.start === null
      ? entry.start
      : toMinutes(occurrence.start) + (entry.start - (entry.start % 1440));
  if (arrival > festivalStart - buffer) {
    errors.push({
      code: "arrival_buffer",
      itemId: entry.item.id,
      message: `この祭りは開始の${buffer}分前（${fromMinutes(festivalStart - buffer)}）までに会場へ着く組み方にしてください。いまは${fromMinutes(arrival)}ごろの到着です`,
    });
  }
}

function preferenceWarnings(
  plan: PlanToCheck,
  timeline: readonly TimedItem[],
  spots: ReadonlyMap<string, NearbySpot>,
): PlanIssue[] {
  const warnings: PlanIssue[] = [];
  const effects = preferenceEffects(plan.preferences);
  const spotOf = (item: PlanItem) =>
    item.spotId === undefined ? undefined : spots.get(item.spotId);

  if (effects.restIntervalMinutes !== null) {
    const festivalIndex = timeline.findIndex(({ item }) => item.type === "festival");
    const beforeFestival = festivalIndex < 0 ? timeline : timeline.slice(0, festivalIndex);
    let lastBreak = beforeFestival[0]?.start ?? 0;
    for (const { item, end } of beforeFestival) {
      if (item.type === "rest" || item.type === "meal") {
        lastBreak = end;
      } else if (end - lastBreak > effects.restIntervalMinutes) {
        warnings.push({
          code: "rest_interval",
          itemId: item.id,
          message: `子連れなので、${effects.restIntervalMinutes / 60}時間ごとに休憩か食事をはさんでください（「${item.name}」まで休憩がありません）`,
        });
        lastBreak = end;
      }
    }
  }

  const shopMeals = plan.items.filter(
    (item) => item.type === "meal" && spotOf(item)?.kind === "food",
  );
  if (effects.requireLocalMeal) {
    const hasLocalMeal = plan.items.some((item) => {
      const spot = spotOf(item);
      return item.type === "meal" && (spot?.kind === "food" || spot?.tags.includes("local_food"));
    });
    if (!hasLocalMeal) {
      warnings.push({
        code: "local_meal_missing",
        itemId: null,
        message: "「地元の店も楽しむ」なので、地元の店での食事を予定に入れてください",
      });
    }
  } else {
    for (const item of shopMeals) {
      warnings.push({
        code: "shop_meal_unwanted",
        itemId: item.id,
        message: `「屋台で十分」なので、店の予定（「${item.name}」）は入れず、屋台を食事の時間にしてください`,
      });
    }
  }

  if (effects.maxWalkMinutes !== null) {
    for (const item of plan.items) {
      if (item.move?.means === "walk" && item.move.minutes[1] > effects.maxWalkMinutes) {
        warnings.push({
          code: "long_walk",
          itemId: item.id,
          message: `シニアと一緒なので、1回に歩く時間を${effects.maxWalkMinutes}分ほどまでにしてください（「${item.name}」へは最長${item.move.minutes[1]}分）`,
        });
      }
    }
  }

  return warnings;
}
