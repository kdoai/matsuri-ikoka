import { FestivalSchema, QuizBankSchema } from "@matsuri-ikoka/schema";
import { describe, expect, it } from "vitest";
import bankJson from "../../../../data/quiz/festival-quiz.json";
import { QUIZ_BANK, quizById } from "./quizBank";

// 待ち時間のクイズのデータ（data/quiz/）が、出典のある祭りのデータと食い違っていないかを確かめる

const festivalFiles = import.meta.glob<unknown>("../../../../data/festivals/*.json", {
  eager: true,
  import: "default",
});

function festivalOf(id: string) {
  return FestivalSchema.parse(festivalFiles[`../../../../data/festivals/${id}.json`]);
}

describe("クイズのデータ", () => {
  it("スキーマどおりで、30問以上ある", () => {
    expect(QuizBankSchema.safeParse(bankJson).success).toBe(true);
    expect(QUIZ_BANK.length).toBeGreaterThanOrEqual(30);
  });

  it("元になった祭りは掲載中で、問いの出典はその祭りのデータにある出典と同じ", () => {
    for (const quiz of QUIZ_BANK) {
      if (quiz.festivalId === undefined) continue;
      const festival = festivalOf(quiz.festivalId);
      expect(festival.optOut, quiz.id).toBe(false);
      const sources = [
        ...festival.sources,
        ...festival.trivia.map((item) => item.source),
        ...festival.etiquette.sources,
      ];
      expect(sources, quiz.id).toContainEqual(quiz.source);
    }
  });

  it("ID で引ける", () => {
    const first = QUIZ_BANK[0]!;
    expect(quizById(first.id)).toBe(first);
    expect(quizById("no-such-quiz")).toBeUndefined();
  });
});
