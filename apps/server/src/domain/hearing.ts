import type { PartialTripConditions } from "@matsuri-ikoka/schema";

// 聞き取りの深さ。泊数に応じて、聞く項目と順番をコードで決める（モデルに決めさせない）。
// - 0〜2泊：日付・出発地・泊数だけで探し始める
// - 3〜6泊：旅のかたち（と回る地域）を聞いてから探す
// 祭りを選んだあとは何も聞かず、宿・食事・ペースまで決めた旅程の案を先に出す。
// 気に入らないところは、案を見た利用者が変更を頼む（先に言われた希望は条件として守る）。
// 言われたことは聞き直さない。「おまかせ」と言われた項目と、「あとはおまかせ」のあとは聞かない。
// 祭りを固定した旅程では、祭りと日は決まっているので、日付と旅のかたちを聞かず、祭りも探さない。

export type HearingField = "when" | "origin" | "nights" | "route";

/** 1回の返事で聞く項目の数の上限 */
export const MAX_QUESTIONS_PER_TURN = 2;

/** 旅のかたちを聞いてから探し始める泊数 */
export const LONG_TRIP_NIGHTS = 3;

export interface HearingSituation {
  /** 利用者が祭りを選んだ */
  festivalChosen?: boolean;
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
  if (field !== "route") return conditions[field] !== undefined;
  // 巡る・途中で寄るときは、どこを回るかまで分かって答えたことにする
  return (
    conditions.route !== undefined &&
    (conditions.route.shape === "stay" ||
      conditions.route.shape === "auto" ||
      conditions.route.areas.length > 0)
  );
}

/** 探し始める前に要る、泊数ごとの項目 */
function beforeSearch(nights: number): HearingField[] {
  return nights >= LONG_TRIP_NIGHTS ? ["route"] : [];
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
  return {
    missing: searchMissing,
    ask: searchMissing.slice(0, MAX_QUESTIONS_PER_TURN),
    readyToSearch: !anchored && searchMissing.length === 0,
    readyToPlan: situation.festivalChosen === true && searchMissing.length === 0,
  };
}

const FIELD_LABELS: Record<HearingField, string> = {
  when: "日付（または期間）",
  origin: "出発地（駅名まで）",
  nights: "日帰りか、何泊か（最大6泊）",
  route:
    "旅のかたち（ずっと一か所・いくつかの地域を巡る・目的地へ向かう途中で寄る）と、回りたい地域",
};

export function hearingFieldLabel(field: HearingField): string {
  return FIELD_LABELS[field];
}
