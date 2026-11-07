import type { Festival } from "@matsuri-ikoka/schema";
import type { AppData, WaitingTalk } from "./types";

// 待ち時間に出す豆知識とクイズ。豆知識は祭りのデータの項目だけから作り、その場で文章を作らない。
// クイズは出典つきの問い（data/quiz/）を、豆知識のあいだに挟んで出す。

/**
 * 豆知識で話す祭り。候補が出る前は読み込んである祭りのすべて、候補が出たあとは
 * 候補の祭りと旅程の主役の祭り（データが届いているものだけ。まだなら全体から）。
 */
export function waitingFestivals(
  state: Pick<AppData, "festivals" | "candidates" | "itinerary">,
): Festival[] {
  const all = Object.values(state.festivals).filter((festival) => !festival.optOut);
  const focusIds = new Set(state.candidates.map((candidate) => candidate.festivalId));
  const main = state.itinerary.current?.mainFestivalId;
  if (main !== undefined) focusIds.add(main);
  const focused = all.filter((festival) => focusIds.has(festival.id));
  // 主役の祭りを先頭にする
  focused.sort((a, b) => Number(b.id === main) - Number(a.id === main));
  return focused.length > 0 ? focused : all;
}

/** 1つの祭りの話。小話と見どころを、種類が続かないよう交互に並べる */
function talksOf(festival: Festival): WaitingTalk[] {
  const base = { festivalId: festival.id, festivalName: festival.name.ja };
  const festivalSource = festival.sources[0];
  const trivia: WaitingTalk[] = festival.trivia.map((item) => ({
    ...base,
    kind: "trivia",
    text: item.text,
    source: item.source,
  }));
  const highlights: WaitingTalk[] =
    festivalSource === undefined
      ? []
      : festival.highlights.map((text) => ({
          ...base,
          kind: "highlight",
          text,
          source: festivalSource,
        }));
  const lists = [trivia, highlights];
  const talks: WaitingTalk[] = [];
  for (let i = 0; lists.some((list) => i < list.length); i++) {
    for (const list of lists) {
      const talk = list[i];
      if (talk !== undefined) talks.push(talk);
    }
  }
  return talks;
}

/**
 * 待ち時間の豆知識。祭りのデータの小話と見どころだけから作り、出典を添える。
 * 祭りが続かないよう、祭りごとの話を1つずつ交互に並べる。
 */
export function waitingTalks(
  state: Pick<AppData, "festivals" | "candidates" | "itinerary">,
): WaitingTalk[] {
  const lists = waitingFestivals(state).map(talksOf);
  const talks: WaitingTalk[] = [];
  for (let i = 0; lists.some((list) => i < list.length); i++) {
    for (const list of lists) {
      const talk = list[i];
      if (talk !== undefined) talks.push(talk);
    }
  }
  return talks;
}

type Random = () => number;

/** 豆知識を何話話したら、クイズを1問挟むか */
export const TALKS_PER_QUIZ = 3;

/** 1枚を見せておく時間。クイズは考える時間を、答えたあとは解説を読む時間をとる */
export const TALK_MS = 7_000;
export const QUIZ_MS = 20_000;
export const QUIZ_RESULT_MS = 10_000;

/** 待ち時間の窓の1枚。豆知識の何話目か、どのクイズか */
export type WaitingSlide = { kind: "talk"; talkIndex: number } | { kind: "quiz"; quizId: string };

/** 次の1枚へ移るまでの時間 */
export function slideDelayMs(slide: WaitingSlide, answered: boolean): number {
  if (slide.kind === "talk") return TALK_MS;
  return answered ? QUIZ_RESULT_MS : QUIZ_MS;
}

/** クイズを出す順。同じ問いが2回入らないよう、ID を重ねずに混ぜる */
export function shuffleDeck(ids: readonly string[], random: Random = Math.random): string[] {
  const deck = [...new Set(ids)];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(random() * (i + 1)));
    [deck[i], deck[j]] = [deck[j] as string, deck[i] as string];
  }
  return deck;
}

type Slot = { kind: "talk"; talkIndex: number } | { kind: "quiz"; ordinal: number };

/**
 * 豆知識をひと回りするあいだの並び。TALKS_PER_QUIZ 話ごとにクイズを1問挟む。
 * 豆知識が少なくても、クイズがあればひと回りに1問は出す
 */
function cycleOf(talkCount: number, hasQuiz: boolean): Slot[] {
  const slots: Slot[] = [];
  let ordinal = 0;
  for (let talkIndex = 0; talkIndex < talkCount; talkIndex++) {
    slots.push({ kind: "talk", talkIndex });
    if (hasQuiz && (talkIndex + 1) % TALKS_PER_QUIZ === 0) {
      slots.push({ kind: "quiz", ordinal: ordinal++ });
    }
  }
  if (hasQuiz && ordinal === 0) slots.push({ kind: "quiz", ordinal: ordinal++ });
  return slots;
}

/** 負の数も、0 以上 size 未満に収める */
function wrap(value: number, size: number): number {
  return ((value % size) + size) % size;
}

/**
 * 何枚目（step。前へ戻ると負になる）に何を見せるか。豆知識はひと回りごとに頭から、
 * クイズはひと回りごとに deck の続きから出すので、問いは deck をひと巡りするまで重ならない。
 * 見せるものがなければ null
 */
export function waitingSlide(
  step: number,
  talkCount: number,
  deck: readonly string[],
): WaitingSlide | null {
  const cycle = cycleOf(talkCount, deck.length > 0);
  if (cycle.length === 0) return null;
  const round = Math.floor(step / cycle.length);
  const slot = cycle[wrap(step, cycle.length)] as Slot;
  if (slot.kind === "talk") return slot;
  const quizzesPerRound = cycle.filter((s) => s.kind === "quiz").length;
  const quizId = deck[wrap(round * quizzesPerRound + slot.ordinal, deck.length)] as string;
  return { kind: "quiz", quizId };
}

/** 窓の下の点の数と、いま何番目か（ひと回りの中の位置） */
export function slidePosition(
  step: number,
  talkCount: number,
  deck: readonly string[],
): { count: number; index: number } {
  const count = Math.max(1, cycleOf(talkCount, deck.length > 0).length);
  return { count, index: wrap(step, count) };
}
