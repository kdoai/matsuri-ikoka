import {
  type AnchorPlan,
  type AnchorPlanRequest,
  type AnchorVisit,
  type Festival,
  type FestivalCandidate,
  MAX_ROUTE_AREAS,
  PACES,
  type TripAnchor,
} from "@matsuri-ikoka/schema";
import {
  type AnchorMessage,
  type AnchorPreview,
  addDays,
  anchoredAnswers,
  type ConsultAnswer,
  type ConsultAnswers,
  type ConsultState,
  chooseEntry,
  type DateRange,
  INITIAL_ANCHOR_PREVIEW,
  MAX_NIGHTS,
  nightsBetween,
  OTHER,
  prefecturePick,
  REGIONS,
  type Region,
  setRange,
} from "./consult";
import { prefectureName } from "./festivalSearch";
import type { ClientError } from "./types";

// 祭りを決めたあとの聞き取り（docs/spec/festival-search.md の「祭りを固定した旅程」）。
// 行く日の候補、選べる日の判定、寄りたい場所、確認の要求の組み立てを、ストアの値からの純粋な関数にする。
// 入れる場所と外す場所の判断はサーバーのコードが行い、ここでは要求を組み立てて結果を持つだけ。

// ---------------------------------------------------------------------------
// 行く日

export interface AnchorDay {
  date: string;
  start: string | null;
  end: string | null;
  /** 開催が例年の見込みか（画面に「要事前確認」と出す） */
  expected: boolean;
}

/**
 * 行く日の候補。今日以降の、中止と延期でない開催回の日。何日かにまたがる開催は1日ずつ選べる。
 * 祭りのデータがまだない・候補がないときは、探したときに決まった日（fallback）だけを出す
 */
export function anchorDays(
  festival: Pick<Festival, "occurrences"> | null | undefined,
  today: string,
  fallback: string,
): AnchorDay[] {
  const days = new Map<string, AnchorDay>();
  for (const occurrence of festival?.occurrences ?? []) {
    if (occurrence.status === "cancelled" || occurrence.status === "postponed") continue;
    const last = occurrence.endDate ?? occurrence.date;
    for (let date = occurrence.date; date <= last; date = addDays(date, 1)) {
      if (date < today || days.has(date)) continue;
      days.set(date, {
        date,
        start: occurrence.start,
        end: occurrence.end,
        expected: occurrence.status === "expected",
      });
    }
  }
  if (days.size === 0) return [{ date: fallback, start: null, end: null, expected: false }];
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** 祭りを固定した聞き取りを始める。祭りと矛盾しうる日程と行き先の答えは消す */
export function beginAnchoredHearing(state: ConsultState, anchor: TripAnchor): ConsultState {
  const { schedule: _schedule, destination: _destination, ...answers } = state.answers;
  return {
    ...chooseEntry(state, "trip"),
    anchor,
    anchorCancelled: false,
    answers,
    preview: INITIAL_ANCHOR_PREVIEW,
  };
}

/** 祭りの固定をやめて、祭りの結果の側へ戻る */
export function leaveAnchor(state: ConsultState): ConsultState {
  return {
    ...state,
    active: true,
    entry: "festival",
    anchor: null,
    anchorCancelled: false,
    step: "party",
    editing: false,
    preview: INITIAL_ANCHOR_PREVIEW,
  };
}

function includesDay(range: DateRange | undefined, date: string): boolean {
  return range !== undefined && range.from <= date && date <= range.to;
}

/**
 * 行く日を選ぶ。行く日を初日にしていた期間（泊数のボタン）は、泊数を保って新しい日へ動かす。
 * カレンダーで選んだ期間は、新しい日を含めば残し、含まなければ選び直してもらう
 */
export function chooseAnchorDay(state: ConsultState, date: string): ConsultState {
  if (state.anchor === null || state.anchor.date === date) return state;
  const { schedule } = state.answers;
  const range = schedule?.range;
  let answers: ConsultAnswers = state.answers;
  if (range !== undefined && range.from === state.anchor.date) {
    answers = setRange(answers, date, addDays(date, nightsBetween(range.from, range.to)));
  } else if (schedule !== undefined && !includesDay(range, date)) {
    answers = { ...answers, schedule: { picks: [], text: "" } };
  }
  return { ...state, anchor: { ...state.anchor, date }, answers };
}

/** 日帰りか泊数を選ぶ。行く日を初日にする（寄る場所があれば、確認のときにサーバーが初日を前へずらす） */
export function setAnchorNights(state: ConsultState, nights: number): ConsultState {
  if (state.anchor === null) return state;
  const { date } = state.anchor;
  const answers = setRange(state.answers, date, addDays(date, Math.min(nights, MAX_NIGHTS)));
  const { fixedStart: _chosenByCalendar, ...schedule } = answers.schedule as ConsultAnswer;
  return { ...state, answers: { ...answers, schedule } };
}

/** カレンダーで期間を選ぶ。行く日を含まない期間と、泊数の上限を超える期間は受けない */
export function setAnchorRange(state: ConsultState, a: string, b: string): ConsultState {
  if (state.anchor === null) return state;
  const [from, to] = a <= b ? [a, b] : [b, a];
  if (!includesDay({ from, to }, state.anchor.date) || nightsBetween(from, to) > MAX_NIGHTS) {
    return state;
  }
  const answers = setRange(state.answers, from, to);
  return {
    ...state,
    answers: { ...answers, schedule: { ...(answers.schedule as ConsultAnswer), fixedStart: true } },
  };
}

/** 送るアンカー。カレンダーで期間を選んでいたら、その初日を添える（サーバーが日程を変えないように） */
export function anchorToSend(state: Pick<ConsultState, "anchor" | "answers">): TripAnchor | null {
  const { anchor, answers } = state;
  if (anchor === null) return null;
  const { startDate: _previous, ...base } = anchor;
  const schedule = answers.schedule;
  return schedule?.fixedStart === true && schedule.range !== undefined
    ? { ...base, startDate: schedule.range.from }
    : base;
}

/**
 * カレンダーで選べる日か。行きを選ぶ間は、行く日まで（泊数の上限の範囲）の日。
 * 行きを選んだあとは、行く日から（泊数の上限の範囲）の日を帰りにできる。
 * 行きとその前の日は、行きの選び直しになる
 */
export function selectableAnchorDay(
  date: string,
  today: string,
  start: string | null,
  anchorDate: string,
): boolean {
  if (date < today) return false;
  if (start === null || date <= start) {
    return date <= anchorDate && nightsBetween(date, anchorDate) <= MAX_NIGHTS;
  }
  return date >= anchorDate && nightsBetween(start, date) <= MAX_NIGHTS;
}

/** 選んだ泊数。まだ選んでいなければ null */
export function selectedNights(answers: ConsultAnswers): number | null {
  const range = answers.schedule?.range;
  return range === undefined ? null : nightsBetween(range.from, range.to);
}

// ---------------------------------------------------------------------------
// 寄りたい場所

/** サーバーが地方として読む名前。画面の言語によらず、この名前で送る */
const REGION_WISH_NAMES: Record<Region, string> = {
  hokkaido: "北海道",
  tohoku: "東北",
  kanto: "関東",
  chubu: "中部",
  kinki: "近畿",
  chugoku: "中国",
  shikoku: "四国",
  kyushu: "九州沖縄",
};

/** 「その他」に書いた地名を、1か所ずつに分ける */
function freeWishes(text: string): string[] {
  return text
    .split(/[、,，\n]+/)
    .map((name) => name.trim().slice(0, 50))
    .filter((name) => name.length > 0);
}

function allWishes(answers: ConsultAnswers): string[] {
  const answer = anchoredAnswers(answers).destination;
  if (answer === undefined) return [];
  const names = answer.picks.flatMap((pick) => {
    if (pick === OTHER) return freeWishes(answer.text);
    if (!(pick in REGIONS)) return [];
    const region = pick as Region;
    const picked = REGIONS[region].filter((code) => answer.picks.includes(prefecturePick(code)));
    return picked.length === 0 ? [REGION_WISH_NAMES[region]] : picked.map(prefectureName);
  });
  return [...new Set<string>(names)];
}

/** 寄りたい場所の名前（確認の要求に入れる）。日帰りでは聞かないので空。上限を超える分は入れない */
export function anchorWishes(answers: ConsultAnswers): string[] {
  return allWishes(answers).slice(0, MAX_ROUTE_AREAS);
}

/** 寄りたい場所が、一度に確かめられる数を超えているか */
export function tooManyWishes(answers: ConsultAnswers): boolean {
  return allWishes(answers).length > MAX_ROUTE_AREAS;
}

// ---------------------------------------------------------------------------
// 確認

/** 確認の要求を組み立てる。出発地か泊数がまだなければ null */
export function anchorPlanRequest(
  state: Pick<ConsultState, "anchor" | "answers">,
  sessionId: string,
): AnchorPlanRequest | null {
  const { answers } = state;
  const anchor = anchorToSend(state);
  const origin = answers.origin?.text.trim().slice(0, 50) ?? "";
  const nights = selectedNights(answers);
  if (anchor === null || origin === "" || nights === null) return null;
  const pace = PACES.find((value) => value === answers.pace?.picks[0]);
  return {
    sessionId,
    anchor,
    origin,
    nights,
    wishes: anchorWishes(answers),
    ...(pace === undefined ? {} : { pace }),
  };
}

/** 確認の要求の同じさを比べる印。答えを変えたら、確認をやり直す */
export function anchorPreviewKey(
  state: Pick<ConsultState, "anchor" | "answers">,
  sessionId: string | null,
): string | null {
  if (sessionId === null) return null;
  const request = anchorPlanRequest(state, sessionId);
  return request === null ? null : JSON.stringify(request);
}

export function beginPreview(key: string): AnchorPreview {
  return { status: "loading", key, plan: null, error: null };
}

export function applyPreview(key: string, plan: AnchorPlan): AnchorPreview {
  return { status: "ready", key, plan, error: null };
}

export function failPreview(key: string, error: ClientError): AnchorPreview {
  return { status: "failed", key, plan: null, error };
}

/** いまの答えに対する確認の結果。答えを変えたあとの古い結果は見せない */
export function currentPreview(
  state: Pick<ConsultState, "anchor" | "answers" | "preview">,
  sessionId: string | null,
): AnchorPreview {
  const key = anchorPreviewKey(state, sessionId);
  return key !== null && state.preview.key === key ? state.preview : INITIAL_ANCHOR_PREVIEW;
}

/** 選んだ泊数が、祭りに無理なく行くのに要る泊数より少ないか */
export function underMinNights(plan: AnchorPlan): boolean {
  return plan.minNights !== null && nightsBetween(plan.startDate, plan.endDate) < plan.minNights;
}

/** 寄りたい場所を、入れる・余裕があれば入れる・今回は外す、に分ける */
export function visitsByStatus(plan: AnchorPlan): Record<AnchorVisit["status"], AnchorVisit[]> {
  const of = (status: AnchorVisit["status"]) =>
    plan.visits.filter((visit) => visit.status === status);
  return { included: of("included"), maybe: of("maybe"), dropped: of("dropped") };
}

/** 選んだ期間と、組み立ての旅の日付が違うか */
export function planDatesDiffer(answers: ConsultAnswers, plan: AnchorPlan): boolean {
  const range = answers.schedule?.range;
  return range !== undefined && (range.from !== plan.startDate || range.to !== plan.endDate);
}

// ---------------------------------------------------------------------------
// 送る一文

/** 決めた祭りの名前と場所（祭りの文字列は、文字としてだけ使う） */
export function anchorPlace(candidate: Pick<FestivalCandidate, "place" | "venueName">): string {
  return `${candidate.place}・${candidate.venueName}`;
}

/** まとめて送る一文に入れる、決めた祭りのこと。確かめられた組み立てがあれば、その日付で伝える */
export function anchorMessage(
  state: Pick<ConsultState, "anchor" | "answers" | "preview">,
  chosen: Pick<FestivalCandidate, "name" | "place" | "venueName"> | null,
  sessionId: string | null,
): AnchorMessage | null {
  const { anchor } = state;
  if (anchor === null) return null;
  return {
    name: chosen?.name ?? anchor.festivalId,
    date: anchor.date,
    place: chosen === null ? "" : anchorPlace(chosen),
    plan: currentPreview(state, sessionId).plan,
  };
}
