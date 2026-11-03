import { STAFF_IDS, type StaffId } from "@matsuri-ikoka/schema";
import { useEffect, useMemo, useRef, useState } from "react";
import { useActions, useApp, useT } from "../state/react";
import type { WaitingTalk } from "../state/types";
import { waitingTalks } from "../state/waiting";
import { focusComposer } from "./ChatPanel";
import { buttonQuiet, SourceLink } from "./common";
import { useReducedMotion } from "./hooks";
import { Portrait } from "./Portraits";

// 待ち時間を楽しめる時間にする部品：豆知識係（祭りの小話・見どころ・作法）、クイズ、しおり完成の演出。

/** 豆知識を切り替える間隔 */
const TALK_INTERVAL_MS = 7_000;
/** この時間を過ぎたら、旅程づくりには時間がかかることを伝える */
const LONG_WAIT_MS = 20_000;

/** 秒を「1:05」の形にする */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** 返答を待っている間だけ、1秒ごとに描き直すための今の時刻 */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

/** 返答を待ち始めた時刻と、スタッフごとに動き始めた時刻 */
function useWaitClock(streaming: boolean, busy: readonly StaffId[]) {
  const started = useRef<number | null>(null);
  const staffStarted = useRef<Partial<Record<StaffId, number>>>({});
  if (streaming && started.current === null) started.current = Date.now();
  if (!streaming) started.current = null;
  for (const id of STAFF_IDS) {
    if (busy.includes(id)) staffStarted.current[id] ??= Date.now();
    else delete staffStarted.current[id];
  }
  return { started: started.current, staffStarted: staffStarted.current };
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

/** いま話している豆知識（返答を待っていないときは null） */
function useCurrentTalk(): { talk: WaitingTalk; count: number } | null {
  const streaming = useApp((state) => state.session.streaming);
  const festivals = useApp((state) => state.festivals);
  const candidates = useApp((state) => state.candidates);
  const itinerary = useApp((state) => state.itinerary);
  const index = useApp((state) => state.trivia.index);
  const talks = useMemo(
    () => waitingTalks({ festivals, candidates, itinerary }),
    [festivals, candidates, itinerary],
  );
  const talk = talks[index % Math.max(1, talks.length)];
  return streaming && talk !== undefined ? { talk, count: talks.length } : null;
}

/**
 * 3D の店で、豆知識係（コンシェルジュ）の頭の上に出す吹き出し。位置は 3D の中から書き込む。
 * 同じ文は豆知識係のカードで読めるので、読み上げからは外す
 */
export function HostBubble() {
  const current = useCurrentTalk();
  const talkText = useTalkText();
  if (current === null) return null;
  const { text } = talkText(current.talk);
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

/**
 * 待ち時間の豆知識係。スタッフが調べものや旅程づくりをしている間、コンシェルジュが
 * 祭りの小話・見どころ・作法を話す（中身は祭りのデータだけで、出典を添える）。
 * 数秒ごとに次の話へ移り、送る・止めるができる。だれが何をしているか、どれだけ経ったかも出す。
 */
/** compact のときは話を出さず、だれが何をしているかと経過時間だけを出す（クイズと並べるとき） */
export function WaitingGuide({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const actions = useActions();
  const streaming = useApp((state) => state.session.streaming);
  const festivals = useApp((state) => state.festivals);
  const candidates = useApp((state) => state.candidates);
  const itinerary = useApp((state) => state.itinerary);
  const staff = useApp((state) => state.staff);
  const index = useApp((state) => state.trivia.index);
  const reducedMotion = useReducedMotion();
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const talks = useMemo(
    () => waitingTalks({ festivals, candidates, itinerary }),
    [festivals, candidates, itinerary],
  );
  const busy = STAFF_IDS.filter((id) => id !== "concierge" && staff[id].phase !== "idle");
  const clock = useWaitClock(streaming, busy);
  const now = useNow(streaming);
  const talkText = useTalkText();

  useEffect(() => {
    if (!streaming || compact || paused || hovered || reducedMotion || talks.length < 2) {
      return;
    }
    const timer = setInterval(() => actions.nextTrivia(), TALK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [streaming, compact, paused, hovered, reducedMotion, talks.length, actions]);

  if (!streaming) {
    return null;
  }
  const talk = talks[index % Math.max(1, talks.length)];
  const elapsed = clock.started === null ? 0 : now - clock.started;
  const isCandidate =
    talk !== undefined && candidates.some((c) => c.festivalId === talk.festivalId);
  const line = talk === undefined ? null : talkText(talk);
  return (
    <aside
      aria-label={t.waiting.title}
      className="w-full max-w-[19rem] animate-pop rounded-2xl border-2 border-ai-700 bg-white/95 px-3 py-2 text-sm shadow-lg sm:max-w-sm"
      data-testid="waiting-guide"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="flex items-center gap-2">
        <Portrait speaker="concierge" className="size-9 border-2" />
        <div className="min-w-0 flex-1">
          <p className="font-bold text-ai-700 text-xs">{t.waiting.host}</p>
          <p className="text-ink-soft text-xs" data-testid="waiting-elapsed">
            {t.waiting.elapsed(formatElapsed(elapsed))}
          </p>
        </div>
      </div>
      {!compact && talk !== undefined && line !== null ? (
        <div className="mt-1.5" data-testid="trivia-card">
          <p className="font-bold text-shu-700 text-xs">{line.label}</p>
          <p
            key={`${talk.festivalId}-${index}`}
            className="mt-0.5 animate-fade font-medium text-ink"
            data-testid="waiting-talk"
          >
            {line.text}
          </p>
          <p className="mt-0.5 text-ink-soft text-xs">{t.waiting.from(talk.festivalName)}</p>
          <div className="mt-0.5">
            <SourceLink source={talk.source} compact />
          </div>
        </div>
      ) : null}
      <div className={`mt-1.5 flex flex-wrap gap-1 ${compact ? "hidden" : ""}`}>
        {talks.length > 1 ? (
          <button type="button" className={buttonQuiet} onClick={() => actions.nextTrivia()}>
            {t.waiting.next}
          </button>
        ) : null}
        {talks.length > 1 ? (
          <button
            type="button"
            className={buttonQuiet}
            aria-pressed={paused}
            onClick={() => setPaused(!paused)}
          >
            {paused ? t.waiting.resume : t.waiting.pause}
          </button>
        ) : null}
        {talk === undefined || isCandidate ? null : (
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
      {busy.length > 0 ? (
        <div className="mt-1.5 border-ai-100 border-t pt-1.5" data-testid="waiting-staff">
          <p className="font-bold text-ink-soft text-xs">{t.waiting.working}</p>
          <ul className="mt-0.5 space-y-0.5 text-xs">
            {busy.map((id) => {
              const state = staff[id];
              const since = clock.staffStarted[id];
              return (
                <li key={id} className="flex items-baseline gap-1.5">
                  <span className="shrink-0 font-bold text-ink">{t.staff.names[id]}</span>
                  <span className="min-w-0 flex-1 truncate text-ink-soft">
                    {state.bubble ?? t.staff.phases[state.phase]}
                  </span>
                  <span className="shrink-0 font-mono text-ink-soft tabular-nums">
                    {since === undefined ? "" : formatElapsed(now - since)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {elapsed >= LONG_WAIT_MS ? (
        <p className="mt-1.5 text-ink-soft text-xs">{t.waiting.longWait}</p>
      ) : null}
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

/** 待ち時間のカード。クイズが出ているときはクイズ、ほかは豆知識係 */
export function WaitingCard() {
  const hasQuiz = useApp((state) => state.quiz.question !== null);
  return hasQuiz ? (
    <div className="flex flex-col gap-2">
      <QuizCard />
      <WaitingGuide compact />
    </div>
  ) : (
    <WaitingGuide />
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
