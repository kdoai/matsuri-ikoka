import type { QuizKind } from "../state/types";

// 祭りクイズの札の見た目を決める計算。部品から切り離して、テストで確かめる。

/** スタンプの点を並べる上限。これより多く集めても、点はこの数まで */
export const MAX_STAMP_DOTS = 5;

export type QuizDot = "stamp" | "current" | "empty";

/**
 * 札の下に並べる点。集めたスタンプの数だけ塗り、答える前は今の問いの点を1つ足す。
 * 何も集めていなくても、今の問いの点は出す。
 */
export function quizDots(stamps: number, answered: boolean): QuizDot[] {
  const filled = Math.min(Math.max(0, Math.floor(stamps)), MAX_STAMP_DOTS);
  const dots: QuizDot[] = Array.from({ length: filled }, () => "stamp");
  if (!answered && filled < MAX_STAMP_DOTS) dots.push("current");
  if (dots.length === 0) dots.push("empty");
  return dots;
}

/** 選択肢に添える絵の種類。祭りの種類は種類ごとの紋章、見どころと地元の味は決まった絵 */
export type ChoiceIcon = { type: "category"; category: string } | { type: "highlight" | "food" };

export function choiceIcon(kind: QuizKind, choice: string): ChoiceIcon {
  if (kind === "category") return { type: "category", category: choice };
  return { type: kind === "local_food" ? "food" : "highlight" };
}
