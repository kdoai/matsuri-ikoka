import type { FestivalQuiz } from "@matsuri-ikoka/schema";
import {
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Pause,
  Play,
} from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { quizById } from "../state/quizBank";
import { useActions, useApp, useT } from "../state/react";
import type { WaitingTalk } from "../state/types";
import {
  slideDelayMs,
  slidePosition,
  type WaitingSlide,
  waitingSlide,
  waitingTalks,
} from "../state/waiting";
import { focusComposer } from "./ChatPanel";
import { buttonQuiet, SourceLink } from "./common";
import { GameWindow } from "./GameWindow";
import { useReducedMotion } from "./hooks";
import { CATEGORY_ICON, CATEGORY_TONE, LanternIcon } from "./icons";
import { Portrait } from "./Portraits";

// 待ち時間を楽しめる時間にする部品：コンシェルジュの豆知識（祭りの小話・見どころ・作法）を
// 時間で送りながら話し、ときどき祭りクイズを挟む。どちらも同じ1つの窓に出す。しおり完成の演出もここに置く。

/** 窓の下に並べる点の上限 */
const MAX_DOTS = 5;

/** 豆知識の1話を、画面の言葉にする（決まった値は辞書で、データの文はそのまま） */
function useTalkText() {
  const t = useT();
  return (talk: WaitingTalk): { label: string; text: string } => {
    if (talk.kind !== "etiquette" || talk.item === undefined) {
      return { label: t.waiting.kinds[talk.kind], text: talk.text };
    }
    const label = `${t.waiting.kinds.etiquette}・${t.etiquette.labels[talk.item]}`;
    const code =
      talk.code === undefined
        ? null
        : talk.item === "participation"
          ? t.etiquette.participation[talk.code as keyof typeof t.etiquette.participation]
          : talk.item === "photo"
            ? t.etiquette.photo[talk.code as keyof typeof t.etiquette.photo]
            : talk.item === "risk"
              ? t.etiquette.risk[talk.code as keyof typeof t.etiquette.risk]
              : null;
    const text = [code, talk.text].filter((part) => part != null && part !== "").join("。");
    return { label, text };
  };
}

/** 待ち時間に話せる豆知識の一覧 */
function useTalks(): WaitingTalk[] {
  const festivals = useApp((state) => state.festivals);
  const candidates = useApp((state) => state.candidates);
  const itinerary = useApp((state) => state.itinerary);
  return useMemo(
    () => waitingTalks({ festivals, candidates, itinerary }),
    [festivals, candidates, itinerary],
  );
}

/** いま見せている1枚の中身（豆知識の1話か、クイズの1問） */
type CurrentSlide = { kind: "talk"; talk: WaitingTalk } | { kind: "quiz"; quiz: FestivalQuiz };

/** いま見せている1枚。並び（何枚目に何を出すか）は state/waiting.ts の関数で決める */
function useSlide(): {
  slide: WaitingSlide | null;
  current: CurrentSlide | null;
  talks: WaitingTalk[];
} {
  const index = useApp((state) => state.trivia.index);
  const deck = useApp((state) => state.quiz.deck);
  const talks = useTalks();
  const slide = waitingSlide(index, talks.length, deck);
  if (slide === null) return { slide, current: null, talks };
  if (slide.kind === "talk") {
    const talk = talks[slide.talkIndex];
    return { slide, current: talk === undefined ? null : { kind: "talk", talk }, talks };
  }
  const quiz = quizById(slide.quizId);
  return { slide, current: quiz === undefined ? null : { kind: "quiz", quiz }, talks };
}

/** 窓の下に並べる点。いまの位置を塗る（飾りなので読み上げない） */
function Dots({ count, active }: { count: number; active: number }) {
  return (
    <p aria-hidden="true" className="flex justify-center gap-1.5">
      {Array.from({ length: count }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: 点は並びの位置だけで見分ける
          key={i}
          className={`size-2.5 rounded-full border-2 ${
            i === active ? "border-yamabuki-700 bg-yamabuki-400" : "border-wood-300 bg-kinari-200"
          }`}
        />
      ))}
    </p>
  );
}

/** 祭りの種類の絵葉書（このアプリで描いた色と紋。祭りの写真は使わない）。飾りなので読み上げない */
function Postcard({ category }: { category: string }) {
  const Emblem = CATEGORY_ICON[category] ?? LanternIcon;
  const tone = CATEGORY_TONE[category] ?? CATEGORY_TONE.other;
  return (
    <span
      aria-hidden="true"
      className="grid size-16 shrink-0 rotate-3 place-items-center rounded-md border-4 border-white shadow-md sm:size-20"
    >
      <span
        className={`grid size-full place-items-center rounded-sm bg-gradient-to-br text-kinari-50 ${tone}`}
      >
        <Emblem className="size-8 sm:size-10" />
      </span>
    </span>
  );
}

/** 丸い送りのボタン */
const roundButton =
  "grid size-9 shrink-0 place-items-center rounded-full border-2 border-wood-300 bg-white text-ink shadow-sm transition hover:border-yamabuki-400 hover:bg-yamabuki-100";

/**
 * 豆知識の1話：コンシェルジュが祭りの小話・見どころ・作法を話す（中身は祭りのデータだけで、出典を添える）。
 * 「くわしく見る」で出典と候補に入れるボタンを開く
 */
function TalkSlide({
  talk,
  slideKey,
  open,
  detailsId,
}: {
  talk: WaitingTalk;
  slideKey: number;
  open: boolean;
  detailsId: string;
}) {
  const t = useT();
  const actions = useActions();
  const festivals = useApp((state) => state.festivals);
  const candidates = useApp((state) => state.candidates);
  const talkText = useTalkText();
  const line = talkText(talk);
  const isCandidate = candidates.some((c) => c.festivalId === talk.festivalId);
  const category = festivals[talk.festivalId]?.category ?? "other";
  return (
    <>
      <div className="flex items-center gap-2">
        <Portrait speaker="concierge" className="size-12 shrink-0 border-2 sm:size-14" />
        <div className="min-w-0 flex-1 rounded-xl bg-white px-2.5 py-2 shadow-sm ring-1 ring-wood-300/60">
          <p
            key={`${talk.festivalId}-${slideKey}`}
            className="line-clamp-4 font-bold text-ink leading-snug motion-safe:animate-fade"
            data-testid="waiting-talk"
          >
            {line.text}
          </p>
          <p className="mt-0.5 truncate text-ink-soft text-xs">
            <span className="font-bold text-shu-700">{line.label}</span>・
            {t.waiting.from(talk.festivalName)}
          </p>
        </div>
        <Postcard category={category} />
      </div>

      {/* 出典は閉じていても文書には残し、開いたときだけ見せる */}
      <div
        id={detailsId}
        hidden={!open}
        className="mt-2 space-y-1.5 border-wood-300/60 border-t pt-2"
      >
        <SourceLink source={talk.source} compact />
        {isCandidate ? null : (
          <button
            type="button"
            className={buttonQuiet}
            onClick={() => {
              actions.setDraft(t.trivia.addMessage(talk.festivalName));
              focusComposer();
            }}
          >
            {t.trivia.addCandidate}
          </button>
        )}
      </div>
    </>
  );
}

/** 選択肢の頭に付ける記号（飾りなので読み上げない） */
const CHOICE_MARKS = ["A", "B", "C", "D"];

/** 選択式のクイズの1問。答えると正解と短い解説、出典を出す。答えなくても相談は進む */
function QuizSlide({ quiz }: { quiz: FestivalQuiz }) {
  const t = useT();
  const actions = useActions();
  const answer = useApp((state) => state.quiz.answers[quiz.id]);
  const stamps = useApp((state) => state.stamps);
  const festivalName = useApp((state) =>
    quiz.festivalId === undefined ? null : (state.festivals[quiz.festivalId]?.name.ja ?? null),
  );
  const answered = answer !== undefined;
  return (
    <div data-testid="quiz-card">
      <div className="flex items-start gap-2">
        <Portrait speaker="concierge" className="size-12 shrink-0 border-2 sm:size-14" />
        <div className="min-w-0 flex-1 rounded-xl bg-white px-2.5 py-2 shadow-sm ring-1 ring-wood-300/60">
          <p className="flex items-start gap-2 font-bold text-ink leading-snug motion-safe:animate-fade">
            <span
              aria-hidden="true"
              className="grid size-6 shrink-0 place-items-center rounded-full bg-shu-600 font-black text-kinari-50 text-xs"
            >
              Q
            </span>
            <span>
              <span className="sr-only">{t.quiz.question}：</span>
              {quiz.question}
            </span>
          </p>
          <p className="mt-0.5 truncate text-ink-soft text-xs">
            <span className="font-bold text-shu-700">{t.quiz.title}</span>
            {festivalName === null ? null : `・${t.waiting.from(festivalName)}`}
          </p>
        </div>
      </div>
      <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
        {quiz.choices.map((choice, index) => {
          const isRight = index === quiz.answer;
          const chosen = answer === index;
          return (
            <button
              key={choice}
              type="button"
              disabled={answered}
              onClick={() => actions.answerQuiz(quiz.id, index)}
              className={`flex min-h-10 items-center gap-2 rounded-xl border-2 px-2.5 py-1 text-left font-bold text-sm leading-snug shadow-sm transition ${
                answered && isRight
                  ? "border-emerald-700 bg-emerald-50 text-emerald-900"
                  : chosen
                    ? "border-stone-500 bg-stone-100 text-stone-700"
                    : "border-wood-300 bg-white text-ink hover:border-yamabuki-400 hover:bg-yamabuki-100"
              }`}
            >
              <span
                aria-hidden="true"
                className="grid size-6 shrink-0 place-items-center rounded-full bg-ai-800 font-black text-kinari-50 text-xs"
              >
                {CHOICE_MARKS[index]}
              </span>
              <span className="min-w-0">{choice}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 text-xs" role="status">
        {answered ? (
          <>
            <p className="font-bold text-ink">
              {answer === quiz.answer
                ? t.quiz.correct
                : t.quiz.wrong(quiz.choices[quiz.answer] ?? "")}
            </p>
            <p className="mt-0.5 text-ink" data-testid="quiz-explanation">
              {quiz.explanation}
            </p>
            <p className="mt-0.5 text-ink-soft">{t.quiz.stamps(stamps)}</p>
          </>
        ) : (
          <p className="text-ink-soft">{t.quiz.note}</p>
        )}
      </div>
      {answered ? (
        <div className="mt-0.5">
          <SourceLink source={quiz.source} compact />
        </div>
      ) : null}
    </div>
  );
}

/**
 * 待ち時間の窓の中身。豆知識を時間で送り、ときどきクイズを挟む。
 * 前後へ送る・止めるができ、指を乗せている間・出典を開いている間・動きを減らす設定のときは送らない
 */
function WaitingBody() {
  const t = useT();
  const actions = useActions();
  const index = useApp((state) => state.trivia.index);
  const deck = useApp((state) => state.quiz.deck);
  const answers = useApp((state) => state.quiz.answers);
  const { slide, current, talks } = useSlide();
  const reducedMotion = useReducedMotion();
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const position = slidePosition(index, talks.length, deck);
  const answered = slide?.kind === "quiz" && answers[slide.quizId] !== undefined;
  const delay = slide === null ? null : slideDelayMs(slide, answered);
  const canMove = position.count > 1;

  // 1枚ごとに時計をかけ直す（クイズに答えたら、解説を読む時間でかけ直す）
  // biome-ignore lint/correctness/useExhaustiveDependencies: index が変わるたびに、その1枚の時間を測り直す
  useEffect(() => {
    if (paused || hovered || open || reducedMotion || !canMove || delay === null) {
      return;
    }
    const timer = setTimeout(() => actions.nextTrivia(), delay);
    return () => clearTimeout(timer);
  }, [index, paused, hovered, open, reducedMotion, canMove, delay, actions]);

  if (current === null) {
    return null;
  }
  const move = (step: () => void) => {
    setOpen(false);
    step();
  };
  const dotCount = Math.min(position.count, MAX_DOTS);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 指を乗せている間は送りを止めるだけで、操作はボタンで行う
    <div
      data-testid="trivia-card"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {current.kind === "talk" ? (
        <TalkSlide talk={current.talk} slideKey={index} open={open} detailsId={detailsId} />
      ) : (
        <QuizSlide key={current.quiz.id} quiz={current.quiz} />
      )}

      <div className="mt-2 flex items-center justify-between gap-2">
        <button
          type="button"
          className={roundButton}
          aria-label={t.waiting.prev}
          disabled={!canMove}
          onClick={() => move(actions.prevTrivia)}
        >
          <ChevronLeft className="size-5" aria-hidden="true" />
        </button>
        {current.kind === "talk" ? (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-full border-2 border-wood-300 bg-white px-4 py-1 font-bold text-ink shadow-sm transition hover:border-yamabuki-400 hover:bg-yamabuki-100"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen(!open)}
          >
            <BookOpen className="size-4" aria-hidden="true" />
            {t.waiting.more}
            <ChevronDown
              className={`size-4 transition ${open ? "rotate-180" : ""}`}
              aria-hidden="true"
            />
          </button>
        ) : (
          <span className="inline-flex items-center gap-1.5 font-bold text-shu-700 text-sm">
            <CircleHelp className="size-4" aria-hidden="true" />
            {t.quiz.title}
          </span>
        )}
        <button
          type="button"
          className={roundButton}
          aria-label={t.waiting.next}
          disabled={!canMove}
          onClick={() => move(actions.nextTrivia)}
        >
          <ChevronRight className="size-5" aria-hidden="true" />
        </button>
      </div>

      <div className="relative mt-2">
        <Dots count={dotCount} active={position.index % dotCount} />
        {canMove && !reducedMotion ? (
          <button
            type="button"
            className="absolute top-1/2 right-0 grid size-7 -translate-y-1/2 place-items-center rounded-full text-ink-soft transition hover:bg-kinari-200 hover:text-ink"
            aria-label={paused ? t.waiting.resume : t.waiting.pause}
            aria-pressed={paused}
            onClick={() => setPaused(!paused)}
          >
            {paused ? (
              <Play className="size-4" aria-hidden="true" />
            ) : (
              <Pause className="size-4" aria-hidden="true" />
            )}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** 待ち時間の窓。返答を待つあいだ、豆知識とクイズを同じ1つの窓に出す */
export function WaitingCard() {
  const t = useT();
  const streaming = useApp((state) => state.session.streaming);
  if (!streaming) {
    return null;
  }
  return (
    <GameWindow
      ariaLabel={t.waiting.title}
      tone="ai"
      className="motion-safe:animate-pop"
      testId="waiting-guide"
      title={
        <>
          <BookOpen className="size-4" aria-hidden="true" />
          {t.waiting.host}
        </>
      }
    >
      <WaitingBody />
    </GameWindow>
  );
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
