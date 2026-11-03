import { FESTIVAL_CATEGORIES, type Festival, UNKNOWN } from "@matsuri-ikoka/schema";
import type { AppData, QuizQuestion, WaitingTalk } from "./types";

// 待ち時間に出す豆知識とクイズ。どちらも祭りのデータの項目だけから作り、その場で文章を作らない。

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

/** 1つの祭りの話。小話・見どころ・作法を、種類が続かないよう交互に並べる */
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
  const etiquette: WaitingTalk[] = [];
  const { etiquette: e } = festival;
  const etiquetteSource = e.sources[0];
  if (etiquetteSource !== undefined) {
    const add = (item: NonNullable<WaitingTalk["item"]>, text: string, code?: string) =>
      etiquette.push({
        ...base,
        kind: "etiquette",
        item,
        text,
        ...(code === undefined ? {} : { code }),
        source: etiquetteSource,
      });
    if (e.participation !== UNKNOWN) add("participation", "", e.participation);
    if (e.howToJoin !== null && e.howToJoin !== UNKNOWN) add("howToJoin", e.howToJoin);
    if (e.rules !== UNKNOWN) for (const rule of e.rules) add("rules", rule);
    if (e.dress !== UNKNOWN) add("dress", e.dress.join("、"));
    if (e.bring !== UNKNOWN) add("bring", e.bring.join("、"));
    if (e.photo !== UNKNOWN) add("photo", e.photo.note ?? "", e.photo.policy);
    if (e.risk !== UNKNOWN) add("risk", e.risk.reason, e.risk.level);
  }
  const lists = [trivia, highlights, etiquette];
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
 * 待ち時間の豆知識。祭りのデータの小話・見どころ・作法だけから作り、出典を添える。
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

/** クイズで問う祭り。旅程の主役、候補の先頭、読み込んである祭りの順に選ぶ */
export function quizFocusId(state: Pick<AppData, "itinerary" | "candidates">): string | null {
  return state.itinerary.current?.mainFestivalId ?? state.candidates[0]?.festivalId ?? null;
}

type Random = () => number;

function pick<T>(list: readonly T[], random: Random): T | undefined {
  return list[Math.min(list.length - 1, Math.floor(random() * list.length))];
}

/** 正解とはずれを、ランダムな順に並べる */
function arrange(
  base: Omit<QuizQuestion, "choices" | "correct">,
  right: string,
  wrong: string,
  random: Random,
): QuizQuestion {
  return random() < 0.5
    ? { ...base, choices: [right, wrong], correct: 0 }
    : { ...base, choices: [wrong, right], correct: 1 };
}

/**
 * 2択のクイズを1問作る。はずれの選択肢は、ほかの祭りのデータから取る。
 * 見どころ・地元の味は、ほかの祭りと重ならないものだけを使う。作れなければ null。
 */
export function buildQuiz(
  festivals: Readonly<Record<string, Festival>>,
  focusId: string | null,
  random: Random = Math.random,
): QuizQuestion | null {
  const all = Object.values(festivals);
  const focus = (focusId === null ? undefined : festivals[focusId]) ?? all[0];
  if (focus === undefined) {
    return null;
  }
  const others = all.filter((festival) => festival.id !== focus.id);
  const base = { festivalId: focus.id, festivalName: focus.name.ja };
  const builders: (() => QuizQuestion | null)[] = [];

  const otherHighlights = others.flatMap((festival) => festival.highlights);
  const ownHighlights = focus.highlights.filter((text) => !otherHighlights.includes(text));
  const wrongHighlight = pick(otherHighlights, random);
  const rightHighlight = pick(ownHighlights, random);
  const festivalSource = focus.sources[0];
  if (wrongHighlight !== undefined && rightHighlight !== undefined && festivalSource) {
    builders.push(() =>
      arrange(
        { ...base, kind: "highlight", source: festivalSource },
        rightHighlight,
        wrongHighlight,
        random,
      ),
    );
  }

  const otherFoods = others.flatMap((festival) => festival.food.local.map((food) => food.name));
  const ownFood = pick(
    focus.food.local.filter((food) => !otherFoods.includes(food.name)),
    random,
  );
  const wrongFood = pick(otherFoods, random);
  if (ownFood !== undefined && wrongFood !== undefined && ownFood.sources[0]) {
    const source = ownFood.sources[0];
    builders.push(() =>
      arrange({ ...base, kind: "local_food", source }, ownFood.name, wrongFood, random),
    );
  }

  const wrongCategory = pick(
    FESTIVAL_CATEGORIES.filter((category) => category !== focus.category && category !== "other"),
    random,
  );
  if (focus.category !== "other" && wrongCategory !== undefined && festivalSource) {
    builders.push(() =>
      arrange(
        { ...base, kind: "category", source: festivalSource },
        focus.category,
        wrongCategory,
        random,
      ),
    );
  }

  return pick(builders, random)?.() ?? null;
}
