import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { otherLocale } from "../i18n";
import { useActions, useApp, useT } from "../state/react";
import { type FrameInsets, NO_INSETS } from "../state/scene";
import type { PanelTab } from "../state/types";
import { Backlog } from "./Backlog";
import { CandidateCards } from "./CandidateCards";
import { focusComposer } from "./ChatPanel";
import { DialogueBox } from "./Dialogue";
import {
  ButtonHints,
  DateBadge,
  GuideCard,
  type HudPanel,
  IconButtons,
  Logo,
  MiniMapCard,
  openTripPanel,
  SectionTabs,
  useHudKeys,
} from "./Hud";
import { useMediaQuery } from "./hooks";
import { ItineraryPanel } from "./ItineraryPanel";
import { PasscodeDialog } from "./Passcode";
import { GameStage } from "./SceneSlot";
import { StaffActivity } from "./StaffPanel";
import { WaitingCard } from "./Waiting";

// ゲームの画面。いつも店（3D、使えないときは 2D の見取り図）を画面いっぱいに出し、
// その上に HUD を重ねる：上にロゴ・場面のタブ・丸いボタン、右上に旅の案内と小さな地図、
// 下に会話の窓、左下に日付、右下にボタンの案内。旅程のパネルは右に開く。
// 狭い画面では、タブと案内をメニューにまとめ、会話の窓を主にする。

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

/** 重なる部品の大きさを測り、2D の見取り図が避ける幅にする */
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

/** 会話の窓に出ない作業の記録が増えたら、お知らせに印を付ける */
function useUnread(logOpen: boolean): boolean {
  const records = useApp(
    (state) =>
      state.messages.filter((entry) => entry.kind === "work" || entry.kind === "error").length,
  );
  const [seen, setSeen] = useState(records);
  useEffect(() => {
    if (logOpen) setSeen(records);
  }, [logOpen, records]);
  return !logOpen && records > seen;
}

export function Shop() {
  const t = useT();
  const actions = useActions();
  const panelOpen = useApp((state) => state.ui.drawerOpen);
  const tab = useApp((state) => state.ui.tab);
  const hasItinerary = useApp((state) => state.itinerary.current !== null);
  const isMock = useApp((state) => state.transport === "mock");
  const wide = useMediaQuery("(min-width: 1024px)");
  const [logOpen, setLogOpen] = useState(false);
  const [menu, setMenu] = useState<HudPanel>(null);
  const unread = useUnread(logOpen);
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

  /** 同じタブがもう開いていれば閉じ、そうでなければそのタブで開く */
  const togglePanel = useCallback(
    (next: PanelTab) => {
      if (panelOpen && tab === next) {
        actions.setDrawer(false);
      } else {
        openTripPanel(actions, next);
      }
    },
    [actions, panelOpen, tab],
  );
  const openLog = useCallback(() => {
    setMenu(null);
    setLogOpen(true);
  }, []);
  const toggleMenu = useCallback(() => setMenu((open) => (open === "menu" ? null : "menu")), []);

  useHudKeys({
    talk: focusComposer,
    details: () => togglePanel("itinerary"),
    map: () => togglePanel("map"),
    menu: toggleMenu,
  });

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-wood-900 text-ink">
      <GameStage frame={frame} onTalk={focusComposer} />

      {/* 上の段：ロゴ・場面のタブ・丸いボタン */}
      <div
        ref={topRef}
        className="no-print pointer-events-none absolute inset-x-0 top-0 z-40 grid grid-cols-[1fr_auto] items-start gap-2 p-2 sm:p-3 lg:grid-cols-[1fr_auto_1fr] [&>*]:pointer-events-auto"
      >
        <div className="flex items-center gap-2 justify-self-start">
          <Logo />
          {isMock ? (
            <span
              className="whitespace-nowrap rounded-full bg-yamabuki-400 px-2 py-0.5 font-bold text-[0.7rem] text-ink shadow sm:text-xs"
              title={t.app.mockNote}
              data-testid="mock-note"
            >
              {t.app.mockBadge}
            </span>
          ) : null}
        </div>
        <SectionTabs className="hidden lg:block" />
        <div className="justify-self-end">
          <IconButtons onOpenLog={openLog} unread={unread} menu={menu} onMenu={setMenu} />
        </div>
      </div>

      {/* 左：いま動いているスタッフ */}
      <div
        className="pointer-events-none absolute left-2 z-10 w-56 sm:left-3 sm:w-64 [&>*]:pointer-events-auto"
        style={{ top: frame.top + 8 }}
      >
        <StaffActivity />
      </div>

      {/* 右上：旅の案内と小さな地図（広い画面で、旅程のパネルを開いていないとき） */}
      {wide && !panelOpen ? (
        <div
          className="pointer-events-none absolute right-3 z-10 flex w-80 flex-col gap-3 [&>*]:pointer-events-auto"
          style={{ top: frame.top + 14 }}
          data-testid="guide-column"
        >
          <GuideCard />
          {hasItinerary ? <MiniMapCard /> : null}
        </div>
      ) : null}

      {/* 旅程・地図・出典の紙のパネル（広い画面は右に重ね、狭い画面は上に重ねる） */}
      {panelOpen ? (
        <div
          ref={panelRef}
          id="trip-panel"
          className="absolute inset-x-2 bottom-2 z-30 lg:right-3 lg:bottom-16 lg:left-auto lg:w-[min(30rem,38vw)]"
          style={{ top: frame.top + 6 }}
          data-testid="panel-drawer"
        >
          <ItineraryPanel />
        </div>
      ) : null}

      {/* 左下：旅の日と出発の駅 */}
      {wide && !beside ? (
        <div className="absolute bottom-3 left-3 z-10">
          <DateBadge />
        </div>
      ) : null}

      {/* 右下：ボタンの案内（旅程のパネルを開いているときは、パネルの下に横に並べる） */}
      {wide ? (
        <div className="no-print absolute right-3 bottom-3 z-30">
          <ButtonHints
            onDetails={() => togglePanel("itinerary")}
            onMap={() => togglePanel("map")}
            onMenu={toggleMenu}
            stacked={!beside}
          />
        </div>
      ) : null}

      {/* 会話の窓。待ち時間のカードは、その上に出す */}
      <div
        ref={dialogueRef}
        className={`absolute inset-x-2 bottom-2 z-20 sm:inset-x-3 sm:bottom-3 ${
          beside
            ? "lg:right-[calc(min(30rem,38vw)+1.5rem)] lg:left-3"
            : "lg:inset-x-0 lg:mx-auto lg:w-[min(50rem,calc(100vw-30rem))]"
        }`}
      >
        <div className="pointer-events-none absolute bottom-full left-0 mb-8 w-full max-w-xs [&>*]:pointer-events-auto">
          <WaitingCard />
        </div>
        <DialogueBox />
      </div>

      <CandidateCards />
      <PasscodeDialog />
      {logOpen ? <Backlog onClose={() => setLogOpen(false)} /> : null}
    </div>
  );
}
