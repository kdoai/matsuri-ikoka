import { type FestivalQuiz, QuizBankSchema } from "@matsuri-ikoka/schema";
import bankJson from "../../../../data/quiz/festival-quiz.json";

// 待ち時間の窓に出すクイズ（data/quiz/）。形が崩れていたら、クイズを出さずに豆知識だけにする。

const parsed = QuizBankSchema.safeParse(bankJson);

export const QUIZ_BANK: readonly FestivalQuiz[] = parsed.success ? parsed.data.quizzes : [];

const byId = new Map(QUIZ_BANK.map((quiz) => [quiz.id, quiz]));

export function quizById(id: string): FestivalQuiz | undefined {
  return byId.get(id);
}
