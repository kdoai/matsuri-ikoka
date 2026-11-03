import { useEffect, useMemo, useState } from "react";
import { useActions, useApp, useT } from "../state/react";
import { triviaCards } from "../state/waiting";
import { focusComposer } from "./ChatPanel";
import { buttonQuiet, SourceLink } from "./common";
import { useReducedMotion } from "./hooks";

// 待ち時間を楽しめる時間にする部品：祭りの小話、クイズ、しおり完成の演出。

/** 小話を切り替える間隔 */
const TRIVIA_INTERVAL_MS = 6_000;

/** 「知ってた？」のカード。調べている間だけ、数秒ごとに切り替える */
export function TriviaCard() {
  const t = useT();
  const actions = useActions();
  const streaming = useApp((state) => state.session.streaming);
  const festivals = useApp((state) => state.festivals);
  const candidates = useApp((state) => state.candidates);
  const index = useApp((state) => state.trivia.index);
  const reducedMotion = useReducedMotion();
  const [paused, setPaused] = useState(false);
  const cards = useMemo(() => triviaCards({ festivals, candidates }), [festivals, candidates]);

  useEffect(() => {
    if (!streaming || paused || reducedMotion || cards.length < 2) {
      return;
    }
    const timer = setInterval(() => actions.nextTrivia(), TRIVIA_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [streaming, paused, reducedMotion, cards.length, actions]);

  const card = cards[index % Math.max(1, cards.length)];
  if (!streaming || card === undefined) {
    return null;
  }
  const isCandidate = candidates.some((c) => c.festivalId === card.festivalId);
  return (
    <aside
      aria-label={t.trivia.title}
      className="w-full max-w-[17rem] animate-pop rounded-xl border-2 border-ai-700 bg-white/95 px-3 py-2 text-sm shadow-lg sm:max-w-xs sm:text-base"
      data-testid="trivia-card"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <p className="font-bold text-ai-700 text-xs">{t.trivia.title}</p>
      <p key={`${card.festivalId}-${card.text}`} className="mt-1 animate-fade font-medium text-ink">
        {card.text}
      </p>
      <p className="mt-1 text-ink-soft text-xs">{card.festivalName}</p>
      <div className="mt-1">
        <SourceLink source={card.source} compact />
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {cards.length > 1 ? (
          <button type="button" className={buttonQuiet} onClick={() => actions.nextTrivia()}>
            {t.trivia.next}
          </button>
        ) : null}
        {isCandidate ? null : (
          <button
            type="button"
            className={buttonQuiet}
            onClick={() => {
              actions.setDraft(t.trivia.addMessage(card.festivalName));
              focusComposer();
            }}
          >
            {t.trivia.addCandidate}
          </button>
        )}
      </div>
    </aside>
  );
}

/** 2択のクイズ。答えなくても進み、返答が終わると閉じる */
export function QuizCard() {
  const t = useT();
  const actions = useActions();
  const quiz = useApp((state) => state.quiz);
  const question = quiz.question;
  if (question === null) {
    return null;
  }
  const label = (choice: string) =>
    question.kind === "category"
      ? (t.categories[choice as keyof typeof t.categories] ?? choice)
      : choice;
  const answered = quiz.answer !== null;
  const correct = quiz.answer === question.correct;
  return (
    <aside
      aria-labelledby="quiz-title"
      className="w-full max-w-[17rem] animate-pop rounded-xl border-2 border-shu-600 bg-white/95 px-3 py-2 shadow-lg sm:max-w-xs"
      data-testid="quiz-card"
    >
      <p id="quiz-title" className="font-bold text-shu-700 text-xs">
        {t.quiz.title}
      </p>
      <p className="mt-1 font-bold text-ink">
        {t.quiz.prompts[question.kind](question.festivalName)}
      </p>
      <div className="mt-1.5 grid grid-cols-2 gap-1">
        {question.choices.map((choice, index) => {
          const isRight = index === question.correct;
          const chosen = quiz.answer === index;
          return (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: 2択の位置そのものが答え
              key={index}
              type="button"
              disabled={answered}
              onClick={() => actions.answerQuiz(index as 0 | 1)}
              className={`min-h-10 rounded-lg border-2 px-2 py-1 text-left font-semibold text-xs leading-snug transition ${
                answered && isRight
                  ? "border-emerald-700 bg-emerald-50 text-emerald-900"
                  : chosen
                    ? "border-stone-500 bg-stone-100 text-stone-700"
                    : "border-ai-200 bg-white text-ink hover:border-ai-600"
              }`}
            >
              {label(choice)}
            </button>
          );
        })}
      </div>
      <p className="mt-1 text-xs" role="status">
        {answered ? (
          <span className="font-bold text-ink">
            {correct ? t.quiz.correct : t.quiz.wrong(label(question.choices[question.correct]))}
          </span>
        ) : (
          <span className="text-ink-soft">{t.quiz.note}</span>
        )}
      </p>
      {answered ? (
        <div className="mt-1">
          <SourceLink source={question.source} compact />
        </div>
      ) : null}
    </aside>
  );
}

/** 待ち時間のカード。クイズが出ているときはクイズ、ほかは小話 */
export function WaitingCard() {
  const hasQuiz = useApp((state) => state.quiz.question !== null);
  return hasQuiz ? <QuizCard /> : <TriviaCard />;
}

/** 「旅のしおり完成」の演出。表紙に祭りのスタンプを押す */
export function Celebration() {
  const t = useT();
  const celebrating = useApp((state) => state.ui.celebrating);
  const name = useApp((state) => {
    const id = state.itinerary.current?.mainFestivalId;
    return id === undefined ? null : (state.festivals[id]?.name.ja ?? null);
  });
  if (!celebrating) {
    return null;
  }
  return (
    <div
      className="pointer-events-none fixed inset-0 z-50 grid place-items-center bg-ink/20"
      data-testid="celebration"
    >
      <div className="animate-pop rounded-2xl border-4 border-wood-800 bg-kinari-50 px-8 py-6 text-center shadow-2xl">
        <FestivalStamp name={name} size="lg" />
        <p className="mt-3 font-bold text-2xl text-ink" role="status">
          {t.celebration.title}
        </p>
        <p className="mt-1 text-ink-soft">{t.celebration.sub}</p>
      </div>
    </div>
  );
}

/** 祭りのスタンプ（朱色の丸に、祭りの名前の頭の2字） */
export function FestivalStamp({ name, size = "md" }: { name: string | null; size?: "md" | "lg" }) {
  const letters = (name ?? "祭").replace(/\s/g, "").slice(0, 2);
  return (
    <span
      aria-hidden="true"
      className={`mx-auto grid animate-stamp place-items-center rounded-full border-4 border-shu-600 font-bold text-shu-600 ${
        size === "lg" ? "size-24 text-3xl" : "size-16 text-xl"
      }`}
      style={{ writingMode: "vertical-rl" }}
    >
      {letters}
    </span>
  );
}
