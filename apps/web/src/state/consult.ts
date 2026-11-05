import {
  type AnchorPlan,
  BUDGET_BASES,
  type BudgetBasis,
  DAY_TRIP_TRAVEL_LIMITS,
  DIETARY_NEEDS,
  type DietaryNeed,
  FOOD_WISHES,
  MAX_MESSAGE_LENGTH,
  TRANSPORT_MODES,
  type TransportMode,
  type TripAnchor,
} from "@matsuri-ikoka/schema";
import type { ClientError } from "./types";

// 選んで進める相談（聞き取り）。文章を書かなくても、選択肢を選ぶだけで旅の好みを伝えられる。
// 段階は上から順に答える一本道で、答えると次の段階へ進む。選んだ内容は1つの発言にまとめ、
// いつもの発言と同じ口（POST /api/chat）で送る。
// 日付の範囲（今週末・来月など）と泊数・人数の合計は、ここでコードで計算して添える。

/** 聞き取りの段階。1つの段階で1つの項目を聞く。最後の confirm で、まとめて送る */
export const CONSULT_STEPS = [
  "party",
  "schedule",
  "origin",
  "destination",
  "activities",
  "food",
  "pace",
  "budget",
  "note",
  "confirm",
] as const;
export type ConsultStep = (typeof CONSULT_STEPS)[number];
export type ConsultQuestion = Exclude<ConsultStep, "confirm">;

export const CONSULT_QUESTIONS = CONSULT_STEPS.filter(
  (step): step is ConsultQuestion => step !== "confirm",
);

/** 地方と、その中の都道府県（全国地方公共団体コードの上2桁） */
export const REGIONS = {
  hokkaido: ["01"],
  tohoku: ["02", "03", "04", "05", "06", "07"],
  kanto: ["08", "09", "10", "11", "12", "13", "14"],
  chubu: ["15", "16", "17", "18", "19", "20", "21", "22", "23"],
  kinki: ["24", "25", "26", "27", "28", "29", "30"],
  chugoku: ["31", "32", "33", "34", "35"],
  shikoku: ["36", "37", "38", "39"],
  kyushu: ["40", "41", "42", "43", "44", "45", "46", "47"],
} as const;
export type Region = keyof typeof REGIONS;
export type Prefecture = (typeof REGIONS)[Region][number];

/** 都道府県の選択肢の値（地方の値と区別するため、前に p を付ける） */
export function prefecturePick(code: Prefecture): string {
  return `p${code}`;
}

/** 選ぶ項目と、その選択肢 */
export const CONSULT_OPTIONS = {
  party: ["solo", "family", "friends", "partner"],
  schedule: ["thisWeekend", "nextWeekend", "thisMonth", "nextMonth", "dates", "undecided"],
  destination: Object.keys(REGIONS) as Region[],
  activities: ["onsen", "sightseeing", "photo", "experience", "nature", "history", "shopping"],
  food: FOOD_WISHES,
  pace: ["relaxed", "normal", "packed"],
  budget: ["under10k", "under30k", "under50k", "more"],
} as const;
export type ChoiceQuestion = keyof typeof CONSULT_OPTIONS;

/** 日帰りのとき、行き先の段階で選べる、出発の駅からの片道の所要時間の上限（分） */
export const TRAVEL_LIMITS = DAY_TRIP_TRAVEL_LIMITS;
export type TravelLimit = (typeof TRAVEL_LIMITS)[number];

/** 食べたいものの段階で、あわせて選べる食事で気をつけたいこと（いくつでも） */
export const DIETARY_OPTIONS = DIETARY_NEEDS;

/** 出発の駅の段階で、あわせて選べる想定している交通手段（いくつでも） */
export const TRANSPORT_OPTIONS = TRANSPORT_MODES;

/** 日程で、期間の決まった範囲（今週末など）や未定を選んだあとに聞く、日帰り・泊まり */
export const STAY_OPTIONS = ["dayTrip", "oneNight", "twoNights", "longer"] as const;
export type StayOption = (typeof STAY_OPTIONS)[number];

/** いくつでも選べる項目。ほかは1つだけ選ぶ */
export const MULTI_QUESTIONS: readonly ConsultQuestion[] = ["destination", "activities", "food"];

/** 「おまかせ」と「その他」（自由記述）を選べる項目 */
export const AUTO_QUESTIONS: readonly ConsultQuestion[] = [
  "party",
  "destination",
  "activities",
  "food",
  "pace",
  "budget",
];
export const OTHER_QUESTIONS: readonly ConsultQuestion[] = [
  "party",
  "destination",
  "activities",
  "food",
  "pace",
];

export const AUTO = "auto";
export const OTHER = "other";

/** 一緒に行く人の内訳。家族は大人・子ども（小学生）・幼児・シニア、友人は人数だけ */
export const FAMILY_MEMBERS = ["adults", "children", "infants", "seniors"] as const;
export type PartyMember = (typeof FAMILY_MEMBERS)[number] | "friends";
export type PartyCounts = Record<PartyMember, number>;

export const DEFAULT_COUNTS: PartyCounts = Object.freeze({
  adults: 2,
  children: 0,
  infants: 0,
  seniors: 0,
  friends: 2,
}) as PartyCounts;

/** 人数の ＋/− の下限と上限。友人は自分を入れて2人から */
export const COUNT_LIMITS: Record<PartyMember, { min: number; max: number }> = {
  adults: { min: 0, max: 9 },
  children: { min: 0, max: 9 },
  infants: { min: 0, max: 9 },
  seniors: { min: 0, max: 9 },
  friends: { min: 2, max: 20 },
};

/** 日付を指定するときの、泊数の上限（旅程は6泊まで組める） */
export const MAX_NIGHTS = 6;

/** 予算の数え方：1人あたり / 全員の合計。選ばなければ1人あたり */
export { BUDGET_BASES };
export const DEFAULT_BUDGET_BASIS: BudgetBasis = "perPerson";

/** 予算に直接入れられる金額の上限（円） */
export const MAX_AMOUNT = 10_000_000;

export interface DateRange {
  from: string;
  to: string;
}

/**
 * 1つの項目の答え。picks は選んだ選択肢（auto・other を含む）。
 * text は「その他」の自由記述、origin では出発の駅、note ではひとこと。
 * counts は人数（party）、range は指定した期間と stay は日帰り・泊まり（schedule）、amount は予算の金額、
 * travel は日帰りの片道の所要時間の上限（destination。分）、dietary は食事で気をつけたいこと（food）、
 * transport は想定している交通手段（origin）、basis は予算の数え方（budget）
 */
export interface ConsultAnswer {
  picks: string[];
  text: string;
  counts?: PartyCounts;
  range?: DateRange;
  stay?: StayOption;
  /** 祭りを固定した聞き取りで、カレンダーで期間を選んだか（初日を変えないようにサーバーへ伝える） */
  fixedStart?: boolean;
  amount?: number;
  travel?: TravelLimit;
  dietary?: DietaryNeed[];
  transport?: TransportMode[];
  basis?: BudgetBasis;
}

export type ConsultAnswers = Partial<Record<ConsultQuestion, ConsultAnswer>>;

/** 相談の入口：祭りから探す / 旅行計画から探す */
export const CONSULT_ENTRIES = ["festival", "trip"] as const;
export type ConsultEntry = (typeof CONSULT_ENTRIES)[number];

/** 祭りを固定した聞き取りの確認（POST /api/festival-trips/preview）の結果。key は要求の印 */
export interface AnchorPreview {
  status: "idle" | "loading" | "ready" | "failed";
  key: string | null;
  plan: AnchorPlan | null;
  error: ClientError | null;
}

export const INITIAL_ANCHOR_PREVIEW: AnchorPreview = Object.freeze({
  status: "idle",
  key: null,
  plan: null,
  error: null,
}) as AnchorPreview;

export interface ConsultState {
  /** 選んで進める聞き取りを出しているか。まとめて送ったら閉じ、「選び直す」でまた開く */
  active: boolean;
  /** 選んだ入口。null はまだ選んでいない（入口の2択を出す） */
  entry: ConsultEntry | null;
  /** 祭りから探して決めた祭りと行く日。旅行計画の聞き取りに進むときに残す */
  anchor: TripAnchor | null;
  /** 決めた祭りが、旅程を組む前の確かめで中止と分かったか */
  anchorCancelled: boolean;
  /** 祭りを固定した聞き取りの確認の結果 */
  preview: AnchorPreview;
  step: ConsultStep;
  /** 確認の画面から直しに来たか。答えたら、確認の画面へ戻る */
  editing: boolean;
  answers: ConsultAnswers;
}

export const INITIAL_CONSULT: ConsultState = Object.freeze({
  active: true,
  entry: null,
  anchor: null,
  anchorCancelled: false,
  preview: INITIAL_ANCHOR_PREVIEW,
  step: "party",
  editing: false,
  answers: {},
}) as ConsultState;

const EMPTY: ConsultAnswer = { picks: [], text: "" };

function regionOf(prefecture: string): Region | undefined {
  return (Object.keys(REGIONS) as Region[]).find((region) =>
    REGIONS[region].some((code) => prefecturePick(code) === prefecture),
  );
}

/**
 * いくつでも選べる項目の付け外し。「おまかせ」は、ほかの選択肢と同時には選ばない
 * （選ぶとほかを外し、ほかを選ぶと外す）。地方を外すと、その中の都道府県も外す
 */
export function togglePick(picks: readonly string[], pick: string): string[] {
  if (picks.includes(pick)) {
    const region = pick in REGIONS ? (pick as Region) : undefined;
    return picks.filter(
      (value) => value !== pick && (region === undefined || regionOf(value) !== region),
    );
  }
  if (pick === AUTO) return [AUTO];
  return [...picks.filter((value) => value !== AUTO), pick];
}

/** 選択肢を選ぶ。1つだけの項目は入れ替え、いくつでも選べる項目は付け外しする */
export function pickAnswer(
  answers: ConsultAnswers,
  question: ConsultQuestion,
  pick: string,
): ConsultAnswers {
  const current = answers[question] ?? EMPTY;
  const picks = MULTI_QUESTIONS.includes(question)
    ? togglePick(current.picks, pick)
    : current.picks.includes(pick)
      ? []
      : [pick];
  const next: ConsultAnswer = { ...current, picks };
  // 予算は、選択肢と金額のどちらか一方
  if (question === "budget" && picks.length > 0) delete next.amount;
  return { ...answers, [question]: next };
}

/** 入口を選ぶ。旅行計画なら聞き取りの最初の段階から始める */
export function chooseEntry(state: ConsultState, entry: ConsultEntry): ConsultState {
  return { ...state, entry, step: "party", editing: false };
}

/** 聞き取りの最初の段階から戻る。決めた祭りがあれば祭りの結果の側へ、なければ入口へ */
export function leaveHearing(state: ConsultState): ConsultState {
  return state.anchor === null
    ? { ...state, entry: null, step: "party", editing: false }
    : {
        ...state,
        entry: "festival",
        anchor: null,
        anchorCancelled: false,
        preview: INITIAL_ANCHOR_PREVIEW,
        step: "party",
        editing: false,
      };
}

export function setAnswerText(
  answers: ConsultAnswers,
  question: ConsultQuestion,
  text: string,
): ConsultAnswers {
  const current = answers[question] ?? EMPTY;
  return { ...answers, [question]: { ...current, text } };
}

/** いまの人数（まだ ＋/− を押していなければ、初めの値） */
export function partyCounts(answer: ConsultAnswer | undefined): PartyCounts {
  return answer?.counts ?? DEFAULT_COUNTS;
}

/** 人数を1つ増やす・減らす。下限と上限で止め、家族は大人かシニアを1人は残す */
export function stepCount(
  answers: ConsultAnswers,
  member: PartyMember,
  delta: 1 | -1,
): ConsultAnswers {
  const current = answers.party ?? EMPTY;
  const counts = partyCounts(current);
  const { min, max } = COUNT_LIMITS[member];
  const value = Math.min(max, Math.max(min, counts[member] + delta));
  const next = { ...counts, [member]: value };
  if ((member === "adults" || member === "seniors") && next.adults + next.seniors === 0) {
    return answers;
  }
  return { ...answers, party: { ...current, counts: next } };
}

/**
 * 家族の人数を、条件の形（大人・子どもと、その内数のシニア・幼児）にする。
 * 画面では大人（シニア以外）・子ども（小学生）・幼児・シニアを別々に数え、ここで足し合わせる
 */
export function familyParty(counts: PartyCounts): {
  adults: number;
  children: number;
  seniors: number;
  infants: number;
} {
  return {
    adults: counts.adults + counts.seniors,
    children: counts.children + counts.infants,
    seniors: counts.seniors,
    infants: counts.infants,
  };
}

/** 人数の合計。ひとりは1人、恋人は2人、家族と友人は入れた人数。人数の分からない答えは null */
export function partySize(answer: ConsultAnswer | undefined): number | null {
  const pick = answer?.picks[0];
  const counts = partyCounts(answer);
  switch (pick) {
    case "solo":
      return 1;
    case "partner":
      return 2;
    case "family":
      return FAMILY_MEMBERS.reduce((sum, member) => sum + counts[member], 0);
    case "friends":
      return counts.friends;
    default:
      return null;
  }
}

/** 日程の期間を決める。逆の順に選んでも、早い日を行きにする */
export function setRange(answers: ConsultAnswers, a: string, b: string): ConsultAnswers {
  const current = answers.schedule ?? EMPTY;
  const range = a <= b ? { from: a, to: b } : { from: b, to: a };
  return { ...answers, schedule: { ...current, picks: ["dates"], range } };
}

export function setStay(answers: ConsultAnswers, stay: StayOption): ConsultAnswers {
  const current = answers.schedule ?? EMPTY;
  return { ...answers, schedule: { ...current, stay } };
}

/** 日程の答えが日帰りか（日帰りを選んだか、行きと帰りが同じ日） */
export function isDayTrip(answers: ConsultAnswers): boolean {
  const schedule = answers.schedule;
  if (schedule === undefined) return false;
  if (schedule.picks[0] === "dates") {
    return schedule.range !== undefined && schedule.range.from === schedule.range.to;
  }
  return schedule.stay === "dayTrip";
}

/** 日帰りの片道の所要時間の上限を選ぶ。選んである上限を押し直すと外す */
export function setTravel(answers: ConsultAnswers, travel: TravelLimit): ConsultAnswers {
  const current = answers.destination ?? EMPTY;
  if (current.travel === travel) {
    const { travel: _removed, ...rest } = current;
    return { ...answers, destination: rest };
  }
  return { ...answers, destination: { ...current, travel } };
}

/** 食事で気をつけたいことを付け外しする。すべて外したら項目ごと消す */
export function toggleDietary(answers: ConsultAnswers, need: DietaryNeed): ConsultAnswers {
  const current = answers.food ?? EMPTY;
  const selected = current.dietary ?? [];
  const dietary = selected.includes(need)
    ? selected.filter((value) => value !== need)
    : DIETARY_OPTIONS.filter((value) => value === need || selected.includes(value));
  if (dietary.length === 0) {
    const { dietary: _removed, ...rest } = current;
    return { ...answers, food: rest };
  }
  return { ...answers, food: { ...current, dietary } };
}

/** 想定している交通手段を付け外しする。すべて外したら項目ごと消す（おまかせ） */
export function toggleTransport(answers: ConsultAnswers, mode: TransportMode): ConsultAnswers {
  const current = answers.origin ?? EMPTY;
  const selected = current.transport ?? [];
  const transport = selected.includes(mode)
    ? selected.filter((value) => value !== mode)
    : TRANSPORT_OPTIONS.filter((value) => value === mode || selected.includes(value));
  if (transport.length === 0) {
    const { transport: _removed, ...rest } = current;
    return { ...answers, origin: rest };
  }
  return { ...answers, origin: { ...current, transport } };
}

/**
 * 送る・確かめるときの答え。日帰りでなくなったら、所要時間の上限は使わない
 * （泊まりの旅は遠くても行けるので、所要時間で絞らない）
 */
export function effectiveAnswers(answers: ConsultAnswers): ConsultAnswers {
  const destination = answers.destination;
  if (destination?.travel === undefined || isDayTrip(answers)) return answers;
  const { travel: _removed, ...rest } = destination;
  return { ...answers, destination: rest };
}

/** 予算の数え方（1人あたり / 全員で）。選択肢と金額はそのまま残す */
export function setBudgetBasis(answers: ConsultAnswers, basis: BudgetBasis): ConsultAnswers {
  const current = answers.budget ?? EMPTY;
  return { ...answers, budget: { ...current, basis } };
}

/** 予算の数え方。選んでいなければ1人あたり */
export function budgetBasis(answer: ConsultAnswer | undefined): BudgetBasis {
  return answer?.basis ?? DEFAULT_BUDGET_BASIS;
}

/** 予算の金額（円。数え方は basis）。入れると選択肢を外し、空にすると金額を消す */
export function setAmount(answers: ConsultAnswers, amount: number | null): ConsultAnswers {
  const current = answers.budget ?? EMPTY;
  if (amount === null || !Number.isFinite(amount) || amount <= 0) {
    const { amount: _removed, ...rest } = current;
    return { ...answers, budget: rest };
  }
  const value = Math.min(MAX_AMOUNT, Math.round(amount));
  return { ...answers, budget: { ...current, picks: [], amount: value } };
}

/**
 * 答えたことになるか。「その他」は文字が入って、「日付を指定」は期間を選んで、はじめて答えになる。
 * 今週末などの範囲や「日にちは未定」は、日帰りか泊まりかまで選んで答えになる（泊数を伝えるため）
 */
export function isAnswered(answer: ConsultAnswer | undefined, question: ConsultQuestion): boolean {
  if (answer === undefined) return false;
  switch (question) {
    case "origin":
      return answer.text.trim().length > 0 || (answer.transport?.length ?? 0) > 0;
    case "note":
      return answer.text.trim().length > 0;
    case "schedule":
      if (answer.picks[0] === undefined) return false;
      return answer.picks[0] === "dates" ? answer.range !== undefined : answer.stay !== undefined;
    case "budget":
      return answer.picks.length > 0 || (answer.amount ?? 0) > 0;
    case "food":
      return (
        (answer.dietary?.length ?? 0) > 0 ||
        answer.picks.some((pick) => pick !== OTHER || answer.text.trim().length > 0)
      );
    case "destination":
      return (
        answer.travel !== undefined ||
        answer.picks.some((pick) => pick !== OTHER || answer.text.trim().length > 0)
      );
    default:
      return answer.picks.some((pick) => pick !== OTHER || answer.text.trim().length > 0);
  }
}

/** 何か1つでも答えたか（まとめて送れるか） */
export function hasAnyAnswer(answers: ConsultAnswers): boolean {
  return CONSULT_QUESTIONS.some((question) => isAnswered(answers[question], question));
}

/** 段階の並びを決める答え。祭りを固定していなければ anchor は null */
export type HearingFlow = Pick<ConsultState, "answers" | "anchor">;

const OPEN_FLOW: HearingFlow = { answers: {}, anchor: null };

/** いま聞く段階の並び。祭りを固定した日帰りでは、行き先を聞かない */
export function hearingSteps(flow: HearingFlow = OPEN_FLOW): readonly ConsultStep[] {
  return flow.anchor !== null && isDayTrip(flow.answers)
    ? CONSULT_STEPS.filter((step) => step !== "destination")
    : CONSULT_STEPS;
}

/** その段階を終えたか。「ひとこと」は書かなくても先へ進める */
function stepDone(step: ConsultStep, { answers, anchor }: HearingFlow): boolean {
  if (step === "confirm") return false;
  if (step === "note") return true;
  // 祭りを固定しているとき、行き先は決まっている（寄りたい場所は選ばなくてもよい）。
  // 日程は、行く日を含む期間を選んではじめて答えになる
  if (anchor !== null && step === "destination") return true;
  if (anchor !== null && step === "schedule") {
    const range = answers.schedule?.range;
    return range !== undefined && range.from <= anchor.date && anchor.date <= range.to;
  }
  // 交通手段だけでは進めない。祭りを探すのに出発の駅が要る
  if (step === "origin") return (answers.origin?.text.trim().length ?? 0) > 0;
  return isAnswered(answers[step], step);
}

/** 進める段階の終わり（最初のまだ答えていない段階）。そこまでは ＜＞ で行き来できる */
export function furthestStep(
  answers: ConsultAnswers,
  anchor: TripAnchor | null = null,
): ConsultStep {
  const flow = { answers, anchor };
  return hearingSteps(flow).find((step) => !stepDone(step, flow)) ?? "confirm";
}

export function canReach(
  step: ConsultStep,
  answers: ConsultAnswers,
  anchor: TripAnchor | null = null,
): boolean {
  const steps = hearingSteps({ answers, anchor });
  return steps.indexOf(step) <= steps.indexOf(furthestStep(answers, anchor));
}

export function nextStep(step: ConsultStep, flow: HearingFlow = OPEN_FLOW): ConsultStep {
  const steps = hearingSteps(flow);
  return (
    CONSULT_STEPS.slice(CONSULT_STEPS.indexOf(step) + 1).find((id) => steps.includes(id)) ??
    "confirm"
  );
}

export function previousStep(step: ConsultStep, flow: HearingFlow = OPEN_FLOW): ConsultStep {
  const steps = hearingSteps(flow);
  return (
    CONSULT_STEPS.slice(0, CONSULT_STEPS.indexOf(step)).findLast((id) => steps.includes(id)) ??
    "party"
  );
}

/** 答えたあとに移る段階。確認の画面から直しに来たときは確認へ戻る */
export function stepAfterAnswer(
  state: Pick<ConsultState, "step" | "editing">,
  flow: HearingFlow = OPEN_FLOW,
): ConsultStep {
  return state.editing ? "confirm" : nextStep(state.step, flow);
}

// ---------------------------------------------------------------------------
// 日付

const DAY_MS = 86_400_000;

function parse(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function format(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return format(new Date(parse(iso).getTime() + days * DAY_MS));
}

/** 2つの日の間の泊数（同じ日なら0泊の日帰り） */
export function nightsBetween(from: string, to: string): number {
  return Math.round((parse(to).getTime() - parse(from).getTime()) / DAY_MS);
}

/** 日本の今日（YYYY-MM-DD）。祭りの日付は現地の日付で数える */
export function todayInJapan(now: Date = new Date()): string {
  return format(new Date(now.getTime() + 9 * 3_600_000));
}

/**
 * 「今週末」などを具体的な日付にする。週末は土曜と日曜。
 * 今日が日曜なら、今週末は今日だけ。今月は今日から月末まで
 */
export function resolveWhen(pick: string, today: string): DateRange | null {
  const weekday = parse(today).getUTCDay();
  const thisSaturday = weekday === 0 ? addDays(today, -1) : addDays(today, 6 - weekday);
  switch (pick) {
    case "thisWeekend":
      return weekday === 0
        ? { from: today, to: today }
        : { from: thisSaturday, to: addDays(thisSaturday, 1) };
    case "nextWeekend": {
      const saturday = addDays(thisSaturday, 7);
      return { from: saturday, to: addDays(saturday, 1) };
    }
    case "thisMonth": {
      const date = parse(today);
      const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
      return { from: today, to: format(last) };
    }
    case "nextMonth": {
      const date = parse(today);
      const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
      const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 2, 0));
      return { from: format(first), to: format(last) };
    }
    default:
      return null;
  }
}

export interface CalendarDay {
  date: string;
  /** その月の日か（前後の月の日は、週をそろえるために空けておく） */
  inMonth: boolean;
}

/** カレンダーの1か月分の週（日曜はじまり）。month は YYYY-MM */
export function monthWeeks(month: string): CalendarDay[][] {
  const first = parse(`${month}-01`);
  const start = addDays(format(first), -first.getUTCDay());
  const weeks: CalendarDay[][] = [];
  for (let week = 0; week < 6; week += 1) {
    const days = Array.from({ length: 7 }, (_, day) => {
      const date = addDays(start, week * 7 + day);
      return { date, inMonth: date.startsWith(month) };
    });
    if (week > 0 && !days.some((day) => day.inMonth)) break;
    weeks.push(days);
  }
  return weeks;
}

/** 月を前後に動かす（YYYY-MM） */
export function shiftMonth(month: string, delta: number): string {
  const date = parse(`${month}-01`);
  return format(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + delta, 1))).slice(
    0,
    7,
  );
}

/**
 * カレンダーで選べる日か。今日より前は選べない。行きを選んだあとは、行きから
 * 泊数の上限までの日だけを帰りにできる（行きより前を押すと、行きの選び直しになる）
 */
export function selectableDay(date: string, today: string, start: string | null): boolean {
  if (date < today) return false;
  if (start === null || date < start) return true;
  return nightsBetween(start, date) <= MAX_NIGHTS;
}

// ---------------------------------------------------------------------------
// まとめて送る一文

/** まとめの一文に使う言葉。画面の辞書（i18n の consult）から渡す */
export interface ConsultWording {
  intro: string;
  outro: string;
  auto: string;
  separator: string;
  questions: Record<ConsultQuestion, string>;
  options: { [Q in ChoiceQuestion]: Record<(typeof CONSULT_OPTIONS)[Q][number], string> };
  stay: Record<StayOption, string>;
  prefectures: Record<Prefecture, string>;
  /** 大人と子どもの人数（例：「大人3人（うちシニア1人）」「子ども2人（うち幼児1人）」） */
  adults: (count: number, seniors: number) => string;
  children: (count: number, infants: number) => string;
  total: (count: number) => string;
  range: (from: string, to: string) => string;
  /** 補いを添える（例：「家族で（計3人）」） */
  paren: (main: string, note: string) => string;
  /** 指定した期間の泊数（例：「2泊3日」「日帰り」） */
  nights: (nights: number) => string;
  amount: (yen: number) => string;
  /** 予算の数え方（例：「1人あたり」「全員で」） */
  budgetBasis: Record<BudgetBasis, string>;
  /** 日帰りの片道の所要時間の上限（例：「出発の駅から片道1時間以内」） */
  travel: (minutes: number) => string;
  /** 食事で気をつけたいこと（例：「気をつけたいこと：ベジタリアン・食物アレルギー」） */
  dietary: (needs: string[]) => string;
  dietaryOptions: Record<DietaryNeed, string>;
  /** 想定している交通手段（例：「交通手段：新幹線・在来線」） */
  transport: (modes: string[]) => string;
  transportOptions: Record<TransportMode, string>;
  /** 1項目の行（例：「・だれと：家族で」） */
  line: (label: string, text: string) => string;
  /** 祭りを決めて旅程を組むときの言葉 */
  anchored: {
    intro: (name: string, date: string) => string;
    outro: string;
    mustGo: (place: string) => string;
    wishes: (places: string) => string;
  };
}

function partyText(answer: ConsultAnswer, wording: ConsultWording): string[] {
  const pick = answer.picks[0];
  if (pick === undefined) return [];
  if (pick === AUTO) return [wording.auto];
  if (pick === OTHER) return [answer.text.trim()];
  const label = wording.options.party[pick as keyof ConsultWording["options"]["party"]] ?? pick;
  const size = partySize(answer) ?? 0;
  if (pick === "family") {
    const party = familyParty(partyCounts(answer));
    const parts = [
      ...(party.adults > 0 ? [wording.adults(party.adults, party.seniors)] : []),
      ...(party.children > 0 ? [wording.children(party.children, party.infants)] : []),
      wording.total(size),
    ];
    return [wording.paren(label, parts.join(wording.separator))];
  }
  return [wording.paren(label, wording.total(size))];
}

function scheduleText(answer: ConsultAnswer, wording: ConsultWording, today: string): string[] {
  const pick = answer.picks[0];
  if (pick === undefined) return [];
  if (pick === "dates") {
    if (answer.range === undefined) return [];
    const { from, to } = answer.range;
    return [wording.paren(wording.range(from, to), wording.nights(nightsBetween(from, to)))];
  }
  const label = wording.options.schedule[pick as keyof ConsultWording["options"]["schedule"]];
  const range = resolveWhen(pick, today);
  const when = range === null ? label : wording.paren(label, wording.range(range.from, range.to));
  return [when, ...(answer.stay === undefined ? [] : [wording.stay[answer.stay]])];
}

function destinationText(answer: ConsultAnswer, wording: ConsultWording): string[] {
  const travel = answer.travel === undefined ? [] : [wording.travel(answer.travel)];
  const places = answer.picks.flatMap((pick) => {
    if (pick === AUTO) return [wording.auto];
    if (pick === OTHER) return [answer.text.trim()];
    if (!(pick in REGIONS)) return [];
    const region = pick as Region;
    const prefectures = REGIONS[region]
      .filter((code) => answer.picks.includes(prefecturePick(code)))
      .map((code) => wording.prefectures[code]);
    const label = wording.options.destination[region];
    return [prefectures.length === 0 ? label : wording.paren(label, prefectures.join("・"))];
  });
  return [...travel, ...places];
}

/** 祭りを固定した相談で、送る・確かめる答え。日帰りでは行き先を聞かないので、残っていても使わない */
export function anchoredAnswers(answers: ConsultAnswers): ConsultAnswers {
  if (!isDayTrip(answers)) return answers;
  const { destination: _removed, ...rest } = answers;
  return rest;
}

/** 祭りを固定した相談の行き先：必ず行く場所と、寄りたい場所 */
export function anchoredDestinationText(
  answer: ConsultAnswer | undefined,
  wording: ConsultWording,
  place: string,
): string {
  const wishes = answer === undefined ? [] : destinationText(answer, wording);
  const parts = [
    ...(place === "" ? [] : [wording.anchored.mustGo(place)]),
    ...(wishes.length === 0 ? [] : [wording.anchored.wishes(wishes.join("・"))]),
  ];
  return parts.join(wording.separator);
}

/** 1つの項目の答えを言葉にする。答えていなければ null */
export function answerText(
  question: ConsultQuestion,
  answer: ConsultAnswer | undefined,
  wording: ConsultWording,
  today: string,
): string | null {
  if (answer === undefined || !isAnswered(answer, question)) return null;
  let parts: string[];
  switch (question) {
    case "origin": {
      const transport = answer.transport ?? [];
      parts = [
        answer.text.trim(),
        ...(transport.length > 0
          ? [wording.transport(transport.map((mode) => wording.transportOptions[mode]))]
          : []),
      ];
      break;
    }
    case "note":
      parts = [answer.text.trim()];
      break;
    case "party":
      parts = partyText(answer, wording);
      break;
    case "schedule":
      parts = scheduleText(answer, wording, today);
      break;
    case "destination":
      parts = destinationText(answer, wording);
      break;
    case "budget": {
      // 金額には、1人あたりか全員でかを必ず添える（おまかせには添えない）
      const basis = wording.budgetBasis[budgetBasis(answer)];
      if (answer.amount !== undefined && answer.picks.length === 0) {
        parts = [wording.paren(wording.amount(answer.amount), basis)];
        break;
      }
      parts = answer.picks.map((pick) =>
        pick === AUTO
          ? wording.auto
          : wording.paren(
              wording.options.budget[pick as keyof ConsultWording["options"]["budget"]] ?? pick,
              basis,
            ),
      );
      break;
    }
    default: {
      const options = wording.options[question] as Record<string, string>;
      parts = answer.picks.flatMap((pick) => {
        if (pick === AUTO) return [wording.auto];
        if (pick === OTHER) return answer.text.trim() === "" ? [] : [answer.text.trim()];
        return [options[pick] ?? pick];
      });
      const dietary = question === "food" ? (answer.dietary ?? []) : [];
      if (dietary.length > 0) {
        parts.push(wording.dietary(dietary.map((need) => wording.dietaryOptions[need])));
      }
    }
  }
  const filtered = parts.filter((part) => part.length > 0);
  return filtered.length === 0 ? null : filtered.join(wording.separator);
}

/** 祭りを固定した相談で、まとめて送る一文に入れること。plan は確かめられた組み立て（なければ null） */
export interface AnchorMessage {
  name: string;
  date: string;
  place: string;
  plan: Pick<AnchorPlan, "startDate" | "endDate"> | null;
}

/** 組み立ての日付があれば、日程の答えをその日付にする（旅程はこの日付の中で組む） */
export function withPlanDates(
  answers: ConsultAnswers,
  plan: AnchorMessage["plan"],
): ConsultAnswers {
  const { schedule } = answers;
  if (plan === null || schedule === undefined) return answers;
  const range = { from: plan.startDate, to: plan.endDate };
  return { ...answers, schedule: { ...schedule, range } };
}

/**
 * 選んだ内容を1つの発言にまとめる。答えていない項目は書かない（推測で埋めない）。
 * 何も答えていなければ null。長すぎるときは、発言の上限に収まるよう切る。
 * anchored があれば、決めた祭りで旅程を組む発言にする（祭りを探し直さない）
 */
export function composeConsultMessage(
  answers: ConsultAnswers,
  wording: ConsultWording,
  today: string,
  anchored: AnchorMessage | null = null,
): string | null {
  const lines: string[] = [];
  const effective =
    anchored === null
      ? effectiveAnswers(answers)
      : withPlanDates(anchoredAnswers(effectiveAnswers(answers)), anchored.plan);
  for (const question of CONSULT_QUESTIONS) {
    const text =
      anchored !== null && question === "destination"
        ? anchoredDestinationText(effective.destination, wording, anchored.place)
        : answerText(question, effective[question], wording, today);
    if (text !== null && text !== "") lines.push(wording.line(wording.questions[question], text));
  }
  if (lines.length === 0) return null;
  const message = [
    anchored === null ? wording.intro : wording.anchored.intro(anchored.name, anchored.date),
    ...lines,
    anchored === null ? wording.outro : wording.anchored.outro,
  ].join("\n");
  return message.length > MAX_MESSAGE_LENGTH ? message.slice(0, MAX_MESSAGE_LENGTH) : message;
}
