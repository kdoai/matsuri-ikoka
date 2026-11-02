import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { otherLocale } from "../i18n";
import { useActions, useApp, useT } from "../state/react";
import { type FrameInsets, NO_INSETS } from "../state/scene";
import { PROGRESS_STEPS, progressStep } from "../state/selectors";
import { Backlog } from "./Backlog";
import { CandidateCards } from "./CandidateCards";
import { DialogueBox } from "./Dialogue";
import { useMediaQuery } from "./hooks";
import { ItineraryPanel } from "./ItineraryPanel";
import { PasscodeDialog } from "./Passcode";
import { GameStage } from "./SceneSlot";
import { StaffActivity } from "./StaffPanel";
import { playSound } from "./sound";
import { WaitingCard } from "./Waiting";

// ゲームの画面。いつも店（3D、使えないときは 2D の見取り図）を画面いっぱいに出し、
// その上に会話の窓・旅程のパネル・待ち時間のカードを重ねる。
// 店のカメラは、重なるものを避けた残りの場所に店を収めて映す。

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
                <span aria-hidden="true" className="h-px w-2 bg-kinari-300/70 sm:w-3" />
              ) : null}
              <span
                aria-current={state === "current" ? "step" : undefined}
                className={`whitespace-nowrap rounded-full px-2 py-0.5 font-semibold ${
                  state === "current"
                    ? "bg-yamabuki-400 text-ink"
                    : state === "past"
                      ? "bg-ai-600 text-white"
                      : "bg-ink/55 text-kinari-100"
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

const roundButton =
  "min-h-10 rounded-full border-2 border-kinari-50/80 bg-ai-800/85 px-3 py-1 font-bold text-white text-xs shadow-md backdrop-blur-sm transition hover:bg-ai-700 sm:text-sm";

function TopBar() {
  const t = useT();
  const actions = useActions();
  const [menuOpen, setMenuOpen] = useState(false);
  const soundOn = useApp((state) => state.ui.soundOn);
  const isMock = useApp((state) => state.transport === "mock");
  const panelOpen = useApp((state) => state.ui.drawerOpen);
  return (
    <header className="no-print flex flex-wrap items-start justify-between gap-2 p-2 sm:p-3 [&>*]:pointer-events-auto">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="rounded-full border-2 border-wood-900 bg-kinari-50 px-3 py-1 font-bold text-ink text-sm tracking-wider shadow-md sm:text-base">
            {t.app.name}
          </h1>
          {isMock ? (
            <span
              className="rounded-full bg-yamabuki-400 px-2 py-0.5 font-bold text-ink text-xs shadow"
              title={t.app.mockNote}
              data-testid="mock-note"
            >
              {t.app.mockBadge}
            </span>
          ) : null}
        </div>
        <div className="hidden max-w-full overflow-x-auto rounded-full bg-ink/35 px-1.5 py-1 backdrop-blur-sm sm:block">
          <StageProgress />
        </div>
      </div>
      <div className="relative flex flex-wrap items-center justify-end gap-1.5">
        <button
          type="button"
          className={roundButton}
          aria-expanded={panelOpen}
          aria-controls="trip-panel"
          onClick={() => actions.setDrawer(!panelOpen)}
        >
          {panelOpen ? t.itinerary.closePanel : t.itinerary.openPanel}
        </button>
        {/* 狭い画面では、ほかのボタンをメニューにまとめる */}
        <button
          type="button"
          className={`${roundButton} lg:hidden`}
          aria-expanded={menuOpen}
          aria-controls="game-menu"
          onClick={() => setMenuOpen((open) => !open)}
        >
          {t.app.menu}
        </button>
        <div
          id="game-menu"
          className={`${
            menuOpen ? "flex" : "hidden"
          } absolute top-full right-0 mt-1.5 flex-col items-stretch gap-1.5 rounded-2xl bg-ink/60 p-2 backdrop-blur-sm lg:static lg:mt-0 lg:flex lg:flex-row lg:items-center lg:bg-transparent lg:p-0 lg:backdrop-blur-none`}
        >
          <LanguageButton className={roundButton} />
          <button
            type="button"
            className={roundButton}
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
          <button type="button" className={roundButton} onClick={() => void actions.restart()}>
            {t.app.restart}
          </button>
        </div>
      </div>
    </header>
  );
}

/** 重なる部品の大きさを測り、店のカメラが避ける幅にする */
function useFrameInsets(
  top: React.RefObject<HTMLElement | null>,
  dialogue: React.RefObject<HTMLElement | null>,
  panel: React.RefObject<HTMLElement | null>,
  panelBeside: boolean,
): FrameInsets {
  const [insets, setInsets] = useState<FrameInsets>(NO_INSETS);
  useLayoutEffect(() => {
    const measure = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const topBar = top.current?.getBoundingClientRect();
      const box = dialogue.current?.getBoundingClientRect();
      const side = panel.current?.getBoundingClientRect();
      const next: FrameInsets = {
        top: topBar === undefined ? 0 : Math.round(topBar.bottom),
        bottom: box === undefined ? 0 : Math.round(height - box.top),
        right: panelBeside && side !== undefined ? Math.round(width - side.left) : 0,
        left: 0,
      };
      setInsets((current) =>
        current.top === next.top &&
        current.bottom === next.bottom &&
        current.right === next.right &&
        current.left === next.left
          ? current
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const element of [top.current, dialogue.current, panel.current]) {
      if (element !== null) observer.observe(element);
    }
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [top, dialogue, panel, panelBeside]);
  return insets;
}

export function Shop() {
  const actions = useActions();
  const panelOpen = useApp((state) => state.ui.drawerOpen);
  const hasItinerary = useApp((state) => state.itinerary.current !== null);
  const wide = useMediaQuery("(min-width: 1024px)");
  const [logOpen, setLogOpen] = useState(false);
  const topRef = useRef<HTMLDivElement>(null);
  const dialogueRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const beside = wide && panelOpen;
  const frame = useFrameInsets(topRef, dialogueRef, panelRef, beside);

  // 旅程ができたら、旅程のパネルを開いて見せる
  useEffect(() => {
    if (hasItinerary) {
      actions.setDrawer(true);
    }
  }, [hasItinerary, actions]);

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-wood-900 text-ink">
      <GameStage frame={frame} />

      <div ref={topRef} className="pointer-events-none absolute inset-x-0 top-0 z-40">
        <TopBar />
      </div>
      <div className="pointer-events-none absolute top-16 left-2 z-10 w-60 sm:top-24 sm:left-3 sm:w-64 [&>*]:pointer-events-auto">
        <StaffActivity />
      </div>

      {/* 旅程・地図・出典の紙のパネル（広い画面は右に重ね、狭い画面は上に重ねる） */}
      {panelOpen ? (
        <div
          ref={panelRef}
          id="trip-panel"
          className="absolute inset-x-2 top-16 bottom-2 z-30 lg:top-24 lg:right-3 lg:bottom-3 lg:left-auto lg:w-[min(30rem,38vw)]"
          data-testid="panel-drawer"
        >
          <ItineraryPanel />
        </div>
      ) : null}

      {/* 会話の窓。待ち時間のカードは、その上に出す */}
      <div
        ref={dialogueRef}
        className={`absolute inset-x-2 bottom-2 z-20 sm:inset-x-3 sm:bottom-3 ${
          beside ? "lg:right-[calc(min(30rem,38vw)+1.5rem)] lg:left-3" : "lg:mx-auto lg:max-w-4xl"
        }`}
      >
        <div className="pointer-events-none absolute bottom-full left-0 mb-6 w-full max-w-xs [&>*]:pointer-events-auto">
          <WaitingCard />
        </div>
        <DialogueBox onOpenLog={() => setLogOpen(true)} />
      </div>

      <CandidateCards />
      <PasscodeDialog />
      {logOpen ? <Backlog onClose={() => setLogOpen(false)} /> : null}
    </div>
  );
}
