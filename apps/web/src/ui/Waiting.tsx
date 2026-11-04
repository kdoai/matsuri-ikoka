import {
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  PartyPopper,
  Pause,
  Play,
  Sparkles,
  UtensilsCrossed,
  X,
} from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { usePlay } from "../state/play";
import { useActions, useApp, useT } from "../state/react";
import type { QuizKind, WaitingTalk } from "../state/types";
import { waitingTalks } from "../state/waiting";
import { focusComposer } from "./ChatPanel";
import { buttonQuiet, SourceLink } from "./common";
import { GameWindow } from "./GameWindow";
import { useReducedMotion } from "./hooks";
import { CATEGORY_ICON, CATEGORY_TONE, LanternIcon } from "./icons";
import { Portrait } from "./Portraits";
import { choiceIcon, MAX_STAMP_DOTS, quizDots } from "./quizLook";

// 待ち時間を楽しめる時間にする部品：コンシェルジュの豆知識（祭りの小話・見どころ・作法）と
// 祭りクイズを1つの窓で出す。しおり完成の演出もここに置く。

/** 豆知識を切り替える間隔 */
const TALK_INTERVAL_MS = 7_000;

/** 何話目かを、話の数の中に収める（前へ戻ると負になるので、正の余りにする） */
function talkIndex(index: number, count: number): number {
  const size = Math.max(1, count);
  return ((index % size) + size) % size;
}

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

/** いま話している豆知識（返答を待っていないときは null） */
function useCurrentTalk(): WaitingTalk | null {
  const streaming = useApp((state) => state.session.streaming);
  const index = useApp((state) => state.trivia.index);
  const talks = useTalks();
  const talk = talks[talkIndex(index, talks.length)];
  return streaming && talk !== undefined ? talk : null;
}

/**
 * 3D の店で、豆知識係（コンシェルジュ）の頭の上に出す吹き出し。位置は 3D の中から書き込む。
 * 同じ文は豆知識の窓で読めるので、読み上げからは外す
 */
export function HostBubble() {
  const talk = useCurrentTalk();
  const talkText = useTalkText();
  const entering = usePlay((state) => state.entering);
  if (talk === null || entering) return null;
  const { text } = talkText(talk);
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      <p
        data-bubble="concierge"
        className="absolute top-0 left-0 line-clamp-3 max-w-60 rounded-2xl border-2 border-ai-700 bg-kinari-50 px-2.5 py-1 text-center font-bold text-ink text-xs leading-snug shadow-lg"
        data-testid="host-bubble"
      >
        {text}
      </p>
    </div>
  );
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
 * 豆知識：コンシェルジュが祭りの小話・見どころ・作法を話す（中身は祭りのデータだけで、出典を添える）。
 * 数秒ごとに次の話へ移り、前後へ送る・止めるができる。「くわしく見る」で出典と候補に入れるボタンを開く
 */
function TriviaBody() {
  const t = useT();
  const actions = useActions();
  const index = useApp((state) => state.trivia.index);
  const festivals = useApp((state) => state.festivals);
  const candidates = useApp((state) => state.candidates);
  const talks = useTalks();
  const talkText = useTalkText();
  const reducedMotion = useReducedMotion();
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [open, setOpen] = useState(false);
  const detailsId = useId();

  useEffect(() => {
    if (paused || hovered || open || reducedMotion || talks.length < 2) {
      return;
    }
    const timer = setInterval(() => actions.nextTrivia(), TALK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [paused, hovered, open, reducedMotion, talks.length, actions]);

  const position = talkIndex(index, talks.length);
  const talk = talks[position];
  if (talk === undefined) {
    return null;
  }
  const line = talkText(talk);
  const isCandidate = candidates.some((c) => c.festivalId === talk.festivalId);
  const category = festivals[talk.festivalId]?.category ?? "other";
  const dotCount = Math.min(talks.length, MAX_STAMP_DOTS);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 指を乗せている間は送りを止めるだけで、操作はボタンで行う
    <div
      data-testid="trivia-card"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="flex items-center gap-2">
        <Portrait speaker="concierge" className="size-12 shrink-0 border-2 sm:size-14" />
        <div className="min-w-0 flex-1 rounded-xl bg-white px-2.5 py-2 shadow-sm ring-1 ring-wood-300/60">
          <p
            key={`${talk.festivalId}-${index}`}
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

      <div className="mt-2 flex items-center justify-between gap-2">
        <button
          type="button"
          className={roundButton}
          aria-label={t.waiting.prev}
          disabled={talks.length < 2}
          onClick={() => actions.prevTrivia()}
        >
          <ChevronLeft className="size-5" aria-hidden="true" />
        </button>
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
        <button
          type="button"
          className={roundButton}
          aria-label={t.waiting.next}
          disabled={talks.length < 2}
          onClick={() => actions.nextTrivia()}
        >
          <ChevronRight className="size-5" aria-hidden="true" />
        </button>
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

      <div className="relative mt-2">
        <Dots count={dotCount} active={position % dotCount} />
        {talks.length > 1 ? (
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

/** 選択肢に添える絵 */
function ChoiceGlyph({ kind, choice }: { kind: QuizKind; choice: string }) {
  const icon = choiceIcon(kind, choice);
  const Icon =
    icon.type === "category"
      ? (CATEGORY_ICON[icon.category] ?? PartyPopper)
      : icon.type === "food"
        ? UtensilsCrossed
        : Sparkles;
  return <Icon className="size-6 shrink-0 text-shu-600" aria-hidden="true" />;
}

/**
 * 2択のクイズ。問い・絵つきの選択肢・スタンプの点を、豆知識と同じ窓に出す。
 * 答えなくても相談は進み、閉じると豆知識に戻る。返答が終わると消える
 */
function QuizBody({ onClose }: { onClose: () => void }) {
  const t = useT();
  const actions = useActions();
  const quiz = useApp((state) => state.quiz);
  const stamps = useApp((state) => state.stamps);
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
  const dots = quizDots(stamps, answered);
  return (
    <div data-testid="quiz-card">
      <div className="flex items-start gap-2">
        <Portrait speaker="concierge" className="size-12 shrink-0 border-2 sm:size-14" />
        <p className="flex min-w-0 flex-1 items-start gap-2 rounded-xl bg-white px-2.5 py-2 font-bold text-ink leading-snug shadow-sm ring-1 ring-wood-300/60">
          <span
            aria-hidden="true"
            className="grid size-6 shrink-0 place-items-center rounded-full bg-shu-600 font-black text-kinari-50 text-xs"
          >
            Q
          </span>
          <span>
            <span className="sr-only">{t.quiz.question}：</span>
            {t.quiz.prompts[question.kind](question.festivalName)}
          </span>
        </p>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
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
              className={`flex min-h-12 items-center gap-2 rounded-xl border-2 px-2.5 py-1.5 text-left font-bold text-sm leading-snug shadow-sm transition ${
                answered && isRight
                  ? "border-emerald-700 bg-emerald-50 text-emerald-900"
                  : chosen
                    ? "border-stone-500 bg-stone-100 text-stone-700"
                    : "border-wood-300 bg-white text-ink hover:border-yamabuki-400 hover:bg-yamabuki-100"
              }`}
            >
              <ChoiceGlyph kind={question.kind} choice={choice} />
              <span className="min-w-0">{label(choice)}</span>
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-xs" role="status">
        {answered ? (
          <span className="font-bold text-ink">
            {correct ? t.quiz.correct : t.quiz.wrong(label(question.choices[question.correct]))}
          </span>
        ) : (
          <span className="text-ink-soft">{t.quiz.note}</span>
        )}
      </p>
      {answered ? (
        <div className="mt-0.5">
          <SourceLink source={question.source} compact />
        </div>
      ) : null}
      <p
        className="mt-2 flex justify-center gap-1.5"
        role="img"
        aria-label={t.quiz.stamps(stamps)}
        data-testid="quiz-dots"
      >
        {dots.map((dot, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: 点は並びの位置だけで見分ける
            key={i}
            className={`size-2.5 rounded-full border-2 ${
              dot === "stamp"
                ? "border-shu-600 bg-shu-600"
                : dot === "current"
                  ? "border-ai-700 bg-kinari-50"
                  : "border-ai-200 bg-transparent"
            }`}
          />
        ))}
      </p>
      {/* 閉じるボタンは選択肢のあとに置き、キーボードでは問いと選択肢を先に回る */}
      <button
        type="button"
        onClick={onClose}
        aria-label={t.quiz.close}
        className="absolute -top-3 -right-3 grid size-8 place-items-center rounded-full border-2 border-kinari-50 bg-ai-800 text-kinari-50 shadow-md transition hover:bg-ai-600"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * 待ち時間の窓。クイズが出ていればクイズを、そうでなければ豆知識を、同じ1つの窓に出す。
 * クイズを閉じたら豆知識に戻る（閉じたかどうかは、この窓の見せ方だけの状態）
 */
export function WaitingCard() {
  const t = useT();
  const streaming = useApp((state) => state.session.streaming);
  const quizTurn = useApp((state) =>
    state.quiz.question === null ? null : state.quiz.offeredTurn,
  );
  const [closedTurn, setClosedTurn] = useState<number | null>(null);
  const showQuiz = quizTurn !== null && quizTurn !== closedTurn;
  if (!streaming && !showQuiz) {
    return null;
  }
  return (
    <GameWindow
      ariaLabel={showQuiz ? t.quiz.title : t.waiting.title}
      tone={showQuiz ? "shu" : "ai"}
      className="motion-safe:animate-pop"
      testId="waiting-guide"
      title={
        showQuiz ? (
          <>
            <LanternIcon className="size-4" />
            {t.quiz.title}
          </>
        ) : (
          <>
            <BookOpen className="size-4" aria-hidden="true" />
            {t.waiting.host}
          </>
        )
      }
    >
      {showQuiz ? <QuizBody onClose={() => setClosedTurn(quizTurn)} /> : <TriviaBody />}
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
