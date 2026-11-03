import { MAX_MESSAGE_LENGTH } from "@matsuri-ikoka/schema";

// 選んで進める相談（聞き取り）。文章を書かなくても、選択肢を選ぶだけで旅の好みを伝えられる。
// 選んだ内容は1つの発言にまとめ、いつもの発言と同じ口（POST /api/chat）で送る。
// 日付の範囲（今週末・来月など）は、ここでコードで計算して、具体的な日付を添える。

/** 聞き取りの段階（画面の上のタブ）。最後の confirm で、まとめて送る */
export const CONSULT_STEPS = [
  "party",
  "when",
  "place",
  "stay",
  "activities",
  "food",
  "style",
  "confirm",
] as const;
export type ConsultStep = (typeof CONSULT_STEPS)[number];

/** 聞く項目と、その選択肢。どの項目も「おまかせ」（auto）と「その他」（other。自由記述）を選べる */
export const CONSULT_OPTIONS = {
  party: ["solo", "family", "friends", "partner"],
  when: ["thisWeekend", "nextWeekend", "thisMonth", "nextMonth", "date"],
  origin: [],
  area: ["near", "far"],
  stay: ["dayTrip", "oneNight", "twoNights", "longer"],
  activities: ["onsen", "sightseeing", "photo", "experience", "nature", "history", "shopping"],
  food: ["seafood", "localDish", "sweets", "stalls", "sake"],
  pace: ["relaxed", "normal", "packed"],
  budget: ["thrifty", "standard", "treat"],
} as const;
export type ConsultQuestion = keyof typeof CONSULT_OPTIONS;

/** いくつでも選べる項目。ほかは1つだけ選ぶ */
export const MULTI_QUESTIONS: readonly ConsultQuestion[] = ["activities", "food"];

/** 段階ごとに聞く項目 */
export const STEP_QUESTIONS: Record<ConsultStep, readonly ConsultQuestion[]> = {
  party: ["party"],
  when: ["when"],
  place: ["origin", "area"],
  stay: ["stay"],
  activities: ["activities"],
  food: ["food"],
  style: ["pace", "budget"],
  confirm: [],
};

export const AUTO = "auto";
export const OTHER = "other";

/**
 * 1つの項目の答え。picks は選んだ選択肢（auto・other を含む）。
 * text は「その他」の自由記述、when で「日付を選ぶ」のときは日付（YYYY-MM-DD）、origin では出発の駅
 */
export interface ConsultAnswer {
  picks: string[];
  text: string;
}

export type ConsultAnswers = Partial<Record<ConsultQuestion, ConsultAnswer>>;

export interface ConsultState {
  /** 選んで進める聞き取りを出しているか。まとめて送ったら閉じ、「選び直す」でまた開く */
  active: boolean;
  step: ConsultStep;
  answers: ConsultAnswers;
}

export const INITIAL_CONSULT: ConsultState = Object.freeze({
  active: true,
  step: "party",
  answers: {},
}) as ConsultState;

const EMPTY: ConsultAnswer = { picks: [], text: "" };

/**
 * 選択肢を選ぶ。1つだけの項目は入れ替え、いくつでも選べる項目は付け外しする。
 * 「おまかせ」は、ほかの選択肢と同時には選ばない（選ぶとほかを外し、ほかを選ぶと外す）
 */
export function pickAnswer(
  answers: ConsultAnswers,
  question: ConsultQuestion,
  pick: string,
): ConsultAnswers {
  const current = answers[question] ?? EMPTY;
  let picks: string[];
  if (!MULTI_QUESTIONS.includes(question)) {
    picks = current.picks.includes(pick) ? [] : [pick];
  } else if (current.picks.includes(pick)) {
    picks = current.picks.filter((value) => value !== pick);
  } else if (pick === AUTO) {
    picks = [AUTO];
  } else {
    picks = [...current.picks.filter((value) => value !== AUTO), pick];
  }
  return { ...answers, [question]: { ...current, picks } };
}

export function setAnswerText(
  answers: ConsultAnswers,
  question: ConsultQuestion,
  text: string,
): ConsultAnswers {
  const current = answers[question] ?? EMPTY;
  return { ...answers, [question]: { ...current, text } };
}

/** 答えたことになるか。「その他」と「日付を選ぶ」は、文字が入ってはじめて答えになる */
export function isAnswered(answer: ConsultAnswer | undefined, question: ConsultQuestion): boolean {
  if (answer === undefined) return false;
  if (question === "origin") return answer.text.trim().length > 0;
  return answer.picks.some(
    (pick) => (pick !== OTHER && pick !== "date") || answer.text.trim().length > 0,
  );
}

/** 何か1つでも答えたか（まとめて送れるか） */
export function hasAnyAnswer(answers: ConsultAnswers): boolean {
  return (Object.keys(answers) as ConsultQuestion[]).some((question) =>
    isAnswered(answers[question], question),
  );
}

export function nextStep(step: ConsultStep): ConsultStep {
  const index = CONSULT_STEPS.indexOf(step);
  return CONSULT_STEPS[Math.min(index + 1, CONSULT_STEPS.length - 1)] ?? "confirm";
}

export function previousStep(step: ConsultStep): ConsultStep {
  const index = CONSULT_STEPS.indexOf(step);
  return CONSULT_STEPS[Math.max(index - 1, 0)] ?? "party";
}

// ---------------------------------------------------------------------------
// 日付の範囲

const DAY_MS = 86_400_000;

function parse(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function format(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  return format(new Date(parse(iso).getTime() + days * DAY_MS));
}

/** 日本の今日（YYYY-MM-DD）。祭りの日付は現地の日付で数える */
export function todayInJapan(now: Date = new Date()): string {
  return format(new Date(now.getTime() + 9 * 3_600_000));
}

export interface DateRange {
  from: string;
  to: string;
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

// ---------------------------------------------------------------------------
// まとめて送る一文

/** まとめの一文に使う言葉。画面の辞書（i18n の consult）から渡す */
export interface ConsultWording {
  intro: string;
  outro: string;
  auto: string;
  separator: string;
  questions: Record<ConsultQuestion, string>;
  options: { [Q in ConsultQuestion]: Record<(typeof CONSULT_OPTIONS)[Q][number], string> };
  range: (from: string, to: string) => string;
  /** 1項目の行（例：「・誰と：家族で」） */
  line: (label: string, text: string) => string;
}

/** 1つの項目の答えを言葉にする。答えていなければ null */
export function answerText(
  question: ConsultQuestion,
  answer: ConsultAnswer | undefined,
  wording: ConsultWording,
  today: string,
): string | null {
  if (!isAnswered(answer, question) || answer === undefined) return null;
  if (question === "origin") return answer.text.trim();
  const options = wording.options[question] as Record<string, string>;
  const parts = answer.picks.flatMap((pick) => {
    if (pick === AUTO) return [wording.auto];
    if (pick === OTHER) return answer.text.trim() === "" ? [] : [answer.text.trim()];
    if (pick === "date") return answer.text.trim() === "" ? [] : [answer.text.trim()];
    const label = options[pick] ?? pick;
    const range = question === "when" ? resolveWhen(pick, today) : null;
    return [range === null ? label : `${label}（${wording.range(range.from, range.to)}）`];
  });
  return parts.length === 0 ? null : parts.join(wording.separator);
}

/**
 * 選んだ内容を1つの発言にまとめる。答えていない項目は書かない（推測で埋めない）。
 * 何も答えていなければ null。長すぎるときは、発言の上限に収まるよう切る
 */
export function composeConsultMessage(
  answers: ConsultAnswers,
  wording: ConsultWording,
  today: string,
): string | null {
  const lines: string[] = [];
  for (const question of Object.keys(CONSULT_OPTIONS) as ConsultQuestion[]) {
    const text = answerText(question, answers[question], wording, today);
    if (text !== null) lines.push(wording.line(wording.questions[question], text));
  }
  if (lines.length === 0) return null;
  const message = [wording.intro, ...lines, wording.outro].join("\n");
  return message.length > MAX_MESSAGE_LENGTH ? message.slice(0, MAX_MESSAGE_LENGTH) : message;
}
