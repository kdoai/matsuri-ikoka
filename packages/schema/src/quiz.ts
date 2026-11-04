import { z } from "zod";
import { SourceSchema } from "./common";

// 待ち時間の窓に、豆知識のあいだに挟んで出す選択式のクイズ（data/quiz/）。
// 問いと答えは、出典（URL・確認した日・確度）を書ける情報だけで作る。

/** 選択肢の数。2〜4択 */
export const QUIZ_MIN_CHOICES = 2;
export const QUIZ_MAX_CHOICES = 4;

export const FestivalQuizSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    /** 話の元になった祭り（祭りのデータの ID）。祭りに結びつかない問いは省く */
    festivalId: z.string().min(1).optional(),
    question: z.string().min(1),
    choices: z.array(z.string().min(1)).min(QUIZ_MIN_CHOICES).max(QUIZ_MAX_CHOICES),
    /** 正解の選択肢の位置（0 から） */
    answer: z.number().int().nonnegative(),
    /** 答えたあとに出す短い解説 */
    explanation: z.string().min(1),
    source: SourceSchema,
  })
  .refine((quiz) => quiz.answer < quiz.choices.length, {
    message: "answer は choices の中を指す",
    path: ["answer"],
  })
  .refine((quiz) => new Set(quiz.choices).size === quiz.choices.length, {
    message: "同じ選択肢を2つ置かない",
    path: ["choices"],
  })
  .refine((quiz) => quiz.source.confidence !== "inferred", {
    message: "推定の情報では問いを作らない",
    path: ["source", "confidence"],
  });

export const QuizBankSchema = z
  .strictObject({ quizzes: z.array(FestivalQuizSchema).min(1) })
  .refine((bank) => new Set(bank.quizzes.map((quiz) => quiz.id)).size === bank.quizzes.length, {
    message: "id は重ねない",
    path: ["quizzes"],
  });

export type FestivalQuiz = z.infer<typeof FestivalQuizSchema>;
export type QuizBank = z.infer<typeof QuizBankSchema>;
