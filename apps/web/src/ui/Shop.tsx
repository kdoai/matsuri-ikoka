import { useEffect } from "react";
import { otherLocale } from "../i18n";
import { useActions, useApp, useT } from "../state/react";
import { PROGRESS_STEPS, progressStep } from "../state/selectors";
import { CandidateCards } from "./CandidateCards";
import { ChatLog, Composer, ConditionChips, PreferenceBar } from "./ChatPanel";
import { buttonPrimary, buttonQuiet } from "./common";
import { useMediaQuery } from "./hooks";
import { ItineraryPanel } from "./ItineraryPanel";
import { PasscodeDialog } from "./Passcode";
import { SceneSlot } from "./SceneSlot";
import { playSound } from "./sound";
import { QuestBoard, WaitingCard } from "./Waiting";

// メインの画面：左に店内と会話、右に旅程・地図・出典のパネル。
// スマートフォンでは、右のパネルを下から引き出す。

export function StageProgress() {
  const t = useT();
  const stage = useApp((state) => state.session.stage);
  const current = PROGRESS_STEPS.indexOf(progressStep(stage));
  return (
    <nav aria-label={t.app.progress} data-testid="stage-progress">
      <ol className="flex items-center gap-1 text-xs">
        {PROGRESS_STEPS.map((step, index) => {
          const state = index < current ? "past" : index === current ? "current" : "future";
          return (
            <li key={step} className="flex items-center gap-1">
              {index > 0 ? (
                <span aria-hidden="true" className="h-px w-2 bg-kinari-300 sm:w-4" />
              ) : null}
              <span
                aria-current={state === "current" ? "step" : undefined}
                className={`whitespace-nowrap rounded-full px-2 py-0.5 font-semibold ${
                  state === "current"
                    ? "bg-yamabuki-400 text-ink"
                    : state === "past"
                      ? "bg-ai-600 text-white"
                      : "bg-ai-900/60 text-ai-100"
                }`}
              >
                {t.stage[step]}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function LanguageButton({ className = "" }: { className?: string }) {
  const t = useT();
  const actions = useActions();
  const locale = useApp((state) => state.ui.locale);
  return (
    <button
      type="button"
      className={className}
      lang={otherLocale(locale)}
      aria-label={`${t.app.language}: ${t.app.switchTo}`}
      onClick={() => actions.setLocale(otherLocale(locale))}
    >
      {t.app.switchTo}
    </button>
  );
}

function Header() {
  const t = useT();
  const actions = useActions();
  const soundOn = useApp((state) => state.ui.soundOn);
  const isMock = useApp((state) => state.transport === "mock");
  const headerButton =
    "min-h-10 rounded-lg border border-ai-200/50 px-2 py-1 font-semibold text-white text-xs hover:bg-ai-700 sm:px-2.5 sm:text-sm";
  return (
    <header className="no-print bg-ai-800 text-white shadow">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
        <h1 className="font-bold text-lg tracking-wider">
          {t.app.name}
          <span className="ml-2 hidden font-medium text-ai-100 text-xs sm:inline">
            {t.app.tagline}
          </span>
        </h1>
        <div className="order-3 w-full overflow-x-auto lg:order-none lg:w-auto lg:flex-1">
          <StageProgress />
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {isMock ? (
            <span
              className="hidden rounded bg-yamabuki-400 px-2 py-0.5 font-bold text-ink text-xs sm:inline"
              title={t.app.mockNote}
            >
              {t.app.mockBadge}
            </span>
          ) : null}
          <LanguageButton className={headerButton} />
          <button
            type="button"
            className={headerButton}
            aria-pressed={soundOn}
            title={t.app.soundHint}
            onClick={() => {
              actions.setSound(!soundOn);
              if (!soundOn) {
                playSound("hyoshigi");
              }
            }}
          >
            {soundOn ? t.app.soundOn : t.app.soundOff}
          </button>
          <button type="button" className={headerButton} onClick={() => void actions.restart()}>
            {t.app.restart}
          </button>
        </div>
      </div>
    </header>
  );
}

/** 候補を閉じたあとに、もう一度開くボタン */
function ReopenCandidates() {
  const t = useT();
  const actions = useActions();
  const show = useApp(
    (state) =>
      !state.ui.candidatesOpen &&
      state.candidates.length > 0 &&
      (state.session.stage === "candidates" || state.itinerary.current === null),
  );
  if (!show) {
    return null;
  }
  return (
    <button
      type="button"
      className={`${buttonQuiet} bg-white/95 shadow`}
      onClick={() => actions.setCandidatesOpen(true)}
    >
      {t.candidates.reopen}
    </button>
  );
}

export function Shop() {
  const t = useT();
  const actions = useActions();
  const drawerOpen = useApp((state) => state.ui.drawerOpen);
  const hasItinerary = useApp((state) => state.itinerary.current !== null);
  const isMock = useApp((state) => state.transport === "mock");
  // 広い画面では掲示板を店内の右上に、狭い画面では店内の下に置く
  const wide = useMediaQuery("(min-width: 640px)");
  // 小話かクイズが出ている間は、掲示板を小さくする
  const waitingShown = useApp(
    (state) =>
      state.quiz.question !== null ||
      (state.session.streaming && Object.values(state.festivals).some((f) => f.trivia.length > 0)),
  );

  // 旅程ができたら、スマートフォンでもパネルを開いて見せる
  useEffect(() => {
    if (hasItinerary) {
      actions.setDrawer(true);
    }
  }, [hasItinerary, actions]);

  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh lg:overflow-hidden">
      <Header />
      {isMock ? (
        <p className="no-print bg-yamabuki-100 px-3 py-1 text-ink text-xs" data-testid="mock-note">
          {t.app.mockNote}
        </p>
      ) : null}
      <main className="flex flex-col gap-3 p-2 pb-20 sm:p-3 sm:pb-20 lg:grid lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(380px,34%)] lg:grid-rows-[minmax(0,1fr)] lg:pb-3">
        {/* 左：店内と会話 */}
        <div className="relative flex flex-col gap-2 lg:min-h-0">
          <div className="h-[19rem] shrink-0 lg:h-[47%] lg:min-h-64">
            <SceneSlot
              overlay={
                <>
                  {/* 店内の右の列：クエストの掲示板と、待ち時間のカード */}
                  <div className="pointer-events-none absolute inset-x-2 bottom-2 z-10 flex max-h-[calc(100%-1rem)] flex-col items-end gap-2 overflow-y-auto sm:inset-x-auto sm:top-2 sm:right-2 sm:w-[min(29%,19rem)] [&>*]:pointer-events-auto">
                    {wide ? (
                      <div className="w-full">
                        <QuestBoard compact={waitingShown} />
                      </div>
                    ) : null}
                    <WaitingCard />
                  </div>
                  <div className="pointer-events-none absolute bottom-2 left-2 z-10 [&>*]:pointer-events-auto">
                    <ReopenCandidates />
                  </div>
                </>
              }
            />
          </div>
          <div className="relative flex flex-col rounded-2xl border-2 border-wood-300 bg-kinari-50 p-2 shadow-sm lg:min-h-0 lg:flex-1">
            <ChatLog />
            <div className="space-y-2 border-kinari-300 border-t pt-2">
              <ConditionChips />
              <PreferenceBar />
              <Composer />
            </div>
          </div>
          {wide ? null : <QuestBoard />}
          <CandidateCards />
          <PasscodeDialog />
        </div>

        {/* 右：旅程・地図・出典（スマートフォンでは下から引き出す） */}
        <div
          className={`fixed inset-x-0 bottom-0 z-30 h-[78dvh] p-2 transition-transform duration-300 lg:static lg:z-auto lg:h-auto lg:min-h-0 lg:translate-y-0 lg:p-0 ${
            drawerOpen ? "translate-y-0" : "translate-y-[calc(100%-3.5rem)]"
          }`}
          data-testid="panel-drawer"
          data-open={drawerOpen}
        >
          <button
            type="button"
            className={`${buttonPrimary} mb-1 w-full rounded-b-none lg:hidden`}
            aria-expanded={drawerOpen}
            aria-controls="itinerary-drawer"
            onClick={() => actions.setDrawer(!drawerOpen)}
          >
            {drawerOpen ? t.itinerary.closePanel : t.itinerary.openPanel}
          </button>
          <div id="itinerary-drawer" className="h-[calc(100%-3rem)] lg:h-full">
            <ItineraryPanel />
          </div>
        </div>
      </main>
    </div>
  );
}
