import type { Festival, IsoDate, PartialTripConditions } from "@matsuri-ikoka/schema";
import { addDays } from "./calendar";

// 聞き取りの深さ。泊数に応じて、聞く項目と順番をコードで決める（モデルに決めさせない）。
// - 0泊（日帰り・お出かけ）：日付・出発地・泊数だけで探し始め、それ以上は聞かない
// - 1〜2泊：泊まる場所の希望は祭りを選んでから、祭りに行く日の数は何日も開かれる祭りのときだけ聞く
// - 3〜6泊：旅のかたち（と回る地域）を聞いてから探し、組む前に終わりの場所・ペース・楽しみを聞く
// 言われたことは聞き直さない。「おまかせ」と言われた項目と、「あとはおまかせ」のあとは聞かない。
// 祭りを固定した旅程では、祭りと日は決まっているので、日付と旅のかたちを聞かず、祭りも探さない。

export type HearingField =
  | "when"
  | "origin"
  | "nights"
  | "route"
  | "stayNear"
  | "festivalDays"
  | "returnTo"
  | "pace"
  | "interests";

/** 1回の返事で聞く項目の数の上限 */
export const MAX_QUESTIONS_PER_TURN = 2;

/** 旅のかたちを聞いてから探し始める泊数 */
export const LONG_TRIP_NIGHTS = 3;

export interface HearingSituation {
  /** 利用者が祭りを選んだ */
  festivalChosen?: boolean;
  /** 選んだ（または候補の）祭りが、旅の間に何日も開かれる */
  multiDayFestival?: boolean;
  /** 選んだ祭りを必ず行く場所に固定している（行く日も決まっている） */
  anchored?: boolean;
}

export interface HearingPlan {
  /** まだ分からない項目（聞く順） */
  missing: HearingField[];
  /** 次の返事で聞く項目（MAX_QUESTIONS_PER_TURN まで） */
  ask: HearingField[];
  /** 祭りを探し始めてよい */
  readyToSearch: boolean;
  /** 旅程を組み始めてよい（祭りを選んだあと） */
  readyToPlan: boolean;
}

const BASE_FIELDS = ["when", "origin", "nights"] as const satisfies readonly HearingField[];

function answered(conditions: PartialTripConditions, field: HearingField): boolean {
  switch (field) {
    case "route":
      // 巡る・途中で寄るときは、どこを回るかまで分かって答えたことにする
      return (
        conditions.route !== undefined &&
        (conditions.route.shape === "stay" ||
          conditions.route.shape === "auto" ||
          conditions.route.areas.length > 0)
      );
    case "returnTo":
      return conditions.returnTo !== undefined;
    default:
      return conditions[field] !== undefined;
  }
}

/** 探し始める前に要る、泊数ごとの項目 */
function beforeSearch(nights: number): HearingField[] {
  return nights >= LONG_TRIP_NIGHTS ? ["route"] : [];
}

/** 組み始める前に要る、泊数ごとの項目 */
function beforePlan(nights: number, situation: HearingSituation): HearingField[] {
  if (nights === 0) return [];
  const fields: HearingField[] = [];
  if (situation.festivalChosen) {
    if (situation.multiDayFestival) fields.push("festivalDays");
    if (nights < LONG_TRIP_NIGHTS) fields.push("stayNear");
  }
  if (nights >= LONG_TRIP_NIGHTS) fields.push("returnTo", "pace", "interests");
  return fields;
}

/** 今の条件から、まだ分からない項目と、次に聞く項目を決める */
export function planHearing(
  conditions: PartialTripConditions,
  situation: HearingSituation = {},
): HearingPlan {
  const anchored = situation.anchored === true;
  const baseMissing = BASE_FIELDS.filter(
    (field) => !(anchored && field === "when") && !answered(conditions, field),
  );
  if (baseMissing.length > 0 || conditions.nights === undefined) {
    return {
      missing: baseMissing,
      ask: baseMissing.slice(0, MAX_QUESTIONS_PER_TURN),
      readyToSearch: false,
      readyToPlan: false,
    };
  }
  const { nights } = conditions;
  const leftToStaff = conditions.leaveToStaff === true;
  const pending = (fields: HearingField[]) =>
    leftToStaff ? [] : fields.filter((field) => !answered(conditions, field));
  const searchMissing = anchored ? [] : pending(beforeSearch(nights));
  const planMissing = pending(beforePlan(nights, situation));
  const missing = [...searchMissing, ...planMissing];
  return {
    missing,
    ask: missing.slice(0, MAX_QUESTIONS_PER_TURN),
    readyToSearch: !anchored && searchMissing.length === 0,
    readyToPlan: situation.festivalChosen === true && missing.length === 0,
  };
}

const FIELD_LABELS: Record<HearingField, string> = {
  when: "日付（または期間）",
  origin: "出発地（駅名まで）",
  nights: "日帰りか、何泊か（最大6泊）",
  route:
    "旅のかたち（ずっと一か所・いくつかの地域を巡る・目的地へ向かう途中で寄る）と、回りたい地域",
  stayNear: "泊まる場所の希望（祭りの近くか、街か）",
  festivalDays: "祭りに行く日の数（1日だけか、何日か）",
  returnTo: "旅の終わりの場所（出発地に戻るか、別の場所か）",
  pace: "旅のペース（ゆっくり・ふつう・たっぷり）",
  interests: "祭りのほかに楽しみたいこと（温泉・食・自然・街歩き・歴史・買い物）",
};

export function hearingFieldLabel(field: HearingField): string {
  return FIELD_LABELS[field];
}

/**
 * 祭りが、行く日の前後（泊数の日数ずつ）に開かれる日の数。2日以上なら、祭りに行く日の数を聞く。
 * 中止と延期の回は数えない
 */
export function festivalOpenDaysAround(festival: Festival, date: IsoDate, nights: number): number {
  const from = addDays(date, -nights);
  const to = addDays(date, nights);
  const days = new Set<IsoDate>();
  for (const o of festival.occurrences) {
    if (o.status === "cancelled" || o.status === "postponed") continue;
    for (let day = o.date; day <= (o.endDate ?? o.date); day = addDays(day, 1)) {
      if (day >= from && day <= to) days.add(day);
    }
  }
  return days.size;
}
