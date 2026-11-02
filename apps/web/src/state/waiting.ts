import { FESTIVAL_CATEGORIES, type Festival } from "@matsuri-ikoka/schema";
import type { AppData, QuizQuestion, TriviaCard } from "./types";

// 待ち時間に出す小話とクイズ。どちらも祭りのデータの項目だけから作り、その場で文章を作らない。

/**
 * 小話のカード。候補が出たあとは候補の祭りの小話、それまでは読み込んである祭りの小話を出す。
 * 候補の祭りのデータがまだ届いていなければ、読み込んである祭りの小話で待つ。
 */
export function triviaCards(state: Pick<AppData, "festivals" | "candidates">): TriviaCard[] {
  const all = Object.values(state.festivals);
  const focusIds = new Set(state.candidates.map((candidate) => candidate.festivalId));
  const focused = all.filter((festival) => focusIds.has(festival.id));
  const pool = focused.some((festival) => festival.trivia.length > 0) ? focused : all;
  return pool.flatMap((festival) =>
    festival.trivia.map((trivia) => ({
      festivalId: festival.id,
      festivalName: festival.name.ja,
      text: trivia.text,
      source: trivia.source,
    })),
  );
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
