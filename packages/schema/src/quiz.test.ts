import { describe, expect, it } from "vitest";
import { type FestivalQuiz, FestivalQuizSchema, QuizBankSchema } from "./quiz";
import { fictionalSource } from "./testing";

function quiz(overrides: Partial<FestivalQuiz> = {}): FestivalQuiz {
  return {
    id: "suzunari-lanterns",
    festivalId: "suzunari-toro",
    question: "鈴鳴灯籠まつりで川に流す灯籠は、およそいくつ？",
    choices: ["約100個", "約1000個", "約1万個"],
    answer: 1,
    explanation: "約1000個の灯籠を川に流します。",
    source: fictionalSource("quiz"),
    ...overrides,
  };
}

describe("FestivalQuizSchema", () => {
  it("架空の祭りのクイズを受け付ける", () => {
    expect(FestivalQuizSchema.safeParse(quiz()).success).toBe(true);
  });

  it("正解の位置が選択肢の外なら不正", () => {
    expect(FestivalQuizSchema.safeParse(quiz({ answer: 3 })).success).toBe(false);
  });

  it("選択肢は2〜4つで、同じものを重ねない", () => {
    expect(FestivalQuizSchema.safeParse(quiz({ choices: ["約100個"], answer: 0 })).success).toBe(
      false,
    );
    expect(FestivalQuizSchema.safeParse(quiz({ choices: ["a", "b", "c", "d", "e"] })).success).toBe(
      false,
    );
    expect(FestivalQuizSchema.safeParse(quiz({ choices: ["a", "a"], answer: 0 })).success).toBe(
      false,
    );
  });

  it("出典のない問い・推定の出典の問いは不正", () => {
    const { source: _, ...withoutSource } = quiz();
    expect(FestivalQuizSchema.safeParse(withoutSource).success).toBe(false);
    expect(
      FestivalQuizSchema.safeParse(quiz({ source: fictionalSource("quiz", "inferred") })).success,
    ).toBe(false);
  });
});

describe("QuizBankSchema", () => {
  it("id が重なれば不正", () => {
    expect(QuizBankSchema.safeParse({ quizzes: [quiz(), quiz()] }).success).toBe(false);
    expect(QuizBankSchema.safeParse({ quizzes: [quiz(), quiz({ id: "other" })] }).success).toBe(
      true,
    );
  });
});
