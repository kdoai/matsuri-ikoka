import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { otherLocale } from "../i18n";
import { playStore } from "../state/play";
import { useActions, useApp, useAppStore, useT } from "../state/react";
import { type FrameInsets, NO_INSETS } from "../state/scene";
import { proposalShown } from "../state/selectors";
import type { PanelTab } from "../state/types";
import { AccountMenu } from "./AccountMenu";
import { Backlog } from "./Backlog";
import { CandidateCards } from "./CandidateCards";
import { focusComposer } from "./ChatPanel";
import { DialogueBox, focusDialogue } from "./Dialogue";
import { FestivalResults } from "./FestivalResults";
import {
  ButtonHints,
  DateBadge,
  type HudPanel,
  IconButtons,
  Logo,
  ModeBadge,
  openTripPanel,
  useHudKeys,
} from "./Hud";
import { useMediaQuery } from "./hooks";
import { ItineraryPanel } from "./ItineraryPanel";
import { PasscodeDialog } from "./Passcode";
import { GreetingBar, PlayNoticeToast, PlayStatus, Tutorial } from "./Play";
import { GameStage } from "./SceneSlot";
import { StaffActivity } from "./StaffPanel";
import { saveTutorialSeen } from "./storage";
import { WaitingCard } from "./Waiting";

// ゲームの画面。いつも店（3D、使えないときは 2D の見取り図）を画面いっぱいに出し、
// 表示を3つの場面に分けて、そのとき要るものだけを重ねる。
// - 探索：ロゴと日付の小さな札、右上の丸いボタンとその下の小さな操作の案内、下の「話しかける」だけ。
//   はじめてのときだけ、操作の案内を出す
// - 会話：画面の下に会話の窓（セリフ・選択肢・自由に書く欄）
// - 計画：旅のしおり（旅程・旅の案内・持ち物と確認）を右に大きく開き、会話の窓は左下に寄せる。
//   祭りの候補は絵葉書のカードで重ねる
// 操作の案内は上の段の中に置き、ほかの窓は上の段の下から始めるので、どの幅でも重ならない。
// 幅 1024px 以上でしおりを開いていないときは、店内のようすと豆知識（クイズ）の窓を右に縦に並べる。
// 会話の窓は、幅 1280px 以上なら画面の横の真ん中に、それより狭ければ右の列の左の空いたところに置く。
// 旅程の提案が出たあとは、旅程を読む邪魔にならないよう豆知識（クイズ）の窓を出さない

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
export function useFrameInsets(
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
        // しまっている会話の窓（大きさ 0）は、重ならないものとして数える
        bottom: box === undefined || box.height === 0 ? 0 : Math.round(height - box.top),
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

/** 返答・エラー・合言葉の問いが届いたら、会話の窓をしまっていても出す */
function useAutoOpenDialogue(): void {
  const actions = useActions();
  const count = useApp(
    (state) =>
      state.messages.filter(
        (entry) => entry.kind === "concierge" || entry.kind === "error" || entry.kind === "user",
      ).length,
  );
  const seen = useRef(count);
  useEffect(() => {
    if (count > seen.current) actions.setDialogue(true);
    seen.current = count;
  }, [count, actions]);
}

export function Shop() {
  const actions = useActions();
  const store = useAppStore();
  const panelOpen = useApp((state) => state.ui.drawerOpen);
  const tab = useApp((state) => state.ui.tab);
  const hasItinerary = useApp((state) => state.itinerary.current !== null);
  const showWaiting = !useApp(proposalShown);
  const tutorialSeen = useApp((state) => state.ui.tutorialSeen);
  const leadingOut = useApp((state) => state.ui.leadingOut);
  const t = useT();
  const wide = useMediaQuery("(min-width: 1024px)");
  const roomy = useMediaQuery("(min-width: 1280px)");
  const [logOpen, setLogOpen] = useState(false);
  const [menu, setMenu] = useState<HudPanel>(null);
  const unread = useUnread(logOpen);
  const topRef = useRef<HTMLDivElement>(null);
  const dialogueRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const beside = wide && panelOpen;
  /** 店内のようすと豆知識の窓を、右の列に並べるか */
  const sideColumn = wide && !panelOpen;
  // 右の列としおりの窓は同時に出ないので、同じ ref で幅を測る
  const frame = useFrameInsets(topRef, dialogueRef, panelRef, beside || sideColumn);

  useEffect(() => {
    if (tutorialSeen) saveTutorialSeen();
  }, [tutorialSeen]);

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

  const dialogueOpen = useApp((state) => state.ui.dialogueOpen);
  /**
   * コンシェルジュに話しかける：会話の窓を出して、最初の選択肢（なければ入力欄）へ移る。
   * 会話の窓がもう出ていれば、自分の言葉で書く欄へ移る
   */
  const talk = useCallback(() => {
    if (store.getState().ui.dialogueOpen) {
      focusComposer();
      return;
    }
    actions.setDialogue(true);
    // 窓が出てから焦点を移す
    window.requestAnimationFrame(() => focusDialogue());
  }, [actions, store]);
  useAutoOpenDialogue();

  const onPad = useCallback(
    (command: "details" | "map" | "menu") => {
      if (command === "menu") toggleMenu();
      else togglePanel(command === "details" ? "itinerary" : "map");
    },
    [toggleMenu, togglePanel],
  );

  useHudKeys({
    // 3D の旅人がいれば、近くの人と話す・ものを使う。いなければ会話の窓の入力欄へ
    talk: () => {
      const play = playStore.getState();
      if (play.active) play.requestInteract();
      else talk();
    },
    details: () => togglePanel("itinerary"),
    map: () => togglePanel("map"),
    menu: toggleMenu,
  });

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-wood-900 text-ink">
      <GameStage frame={frame} onTalk={talk} onPad={onPad} onExit={actions.leaveShop} />

      {/* 上の段：ロゴと、1段に並べた操作の案内・丸いボタン */}
      <div
        ref={topRef}
        className="no-print pointer-events-none absolute inset-x-0 top-0 z-40 grid grid-cols-[1fr_auto] items-start gap-2 p-2 sm:p-3 [&>*]:pointer-events-auto"
      >
        <div className="flex flex-col items-start gap-1.5 justify-self-start">
          <Logo />
          {beside ? null : <DateBadge />}
          <ModeBadge />
        </div>
        <div className="flex items-center gap-1.5 justify-self-end sm:gap-2">
          <AccountMenu />
          <ButtonHints
            onDetails={() => togglePanel("itinerary")}
            onMap={() => togglePanel("map")}
            onMenu={toggleMenu}
            menuOpen={menu === "menu"}
          />
          <IconButtons onOpenLog={openLog} unread={unread} menu={menu} onMenu={setMenu} />
        </div>
      </div>

      {/* 左：いま動いているスタッフ（右の列がないとき）と、はじめての操作の案内。店の中のようすは読み上げにも伝える */}
      <div
        className="pointer-events-none absolute left-2 z-10 flex w-56 flex-col gap-2 sm:left-3 sm:w-64 [&>*]:pointer-events-auto"
        // 上の段と会話の窓の間に収める
        style={{
          top: frame.top + 8,
          maxHeight: `max(8rem, calc(100dvh - ${frame.top + frame.bottom + 16}px))`,
        }}
      >
        {sideColumn ? null : <StaffActivity />}
        {dialogueOpen || panelOpen ? null : <Tutorial />}
        <PlayStatus hidden />
      </div>

      {/*
        右の列：店内のようすと、豆知識（クイズ）の窓。窓の札が上に出るので、間を空ける。
        上の段から画面の下までに収め、高さが足りない分は窓の中でスクロールする
      */}
      {sideColumn ? (
        <div
          ref={panelRef}
          className="pointer-events-none absolute right-3 bottom-3 z-10 flex w-[22rem] flex-col gap-7 [&>*]:pointer-events-auto"
          style={{ top: frame.top + 22 }}
        >
          <StaffActivity />
          {showWaiting ? <WaitingCard /> : null}
        </div>
      ) : null}

      {/* 旅のしおり：旅程・旅の案内・持ち物と確認（広い画面は右に大きく重ね、狭い画面は上に重ねる） */}
      {panelOpen ? (
        <div
          ref={panelRef}
          id="trip-panel"
          className="absolute inset-x-2 bottom-2 z-30 lg:right-3 lg:bottom-3 lg:left-auto lg:w-[min(44rem,48vw)]"
          style={{ top: frame.top + 6 }}
          data-testid="panel-drawer"
        >
          <ItineraryPanel />
        </div>
      ) : null}

      {/* 会話の窓。探索の間は出さず、話しかけたら出す。待ち時間のカードは、その上に出す */}
      {dialogueOpen || leadingOut ? null : (
        <div className="absolute inset-x-2 bottom-3 z-20 sm:bottom-4">
          <GreetingBar onTalk={talk} />
        </div>
      )}
      <div
        ref={dialogueRef}
        hidden={!dialogueOpen}
        // 会話の窓は、上の段（丸いボタンと操作の案内）の下までに収める
        style={{ "--frame-top": `${frame.top}px` } as CSSProperties}
        className={`absolute inset-x-2 bottom-2 z-20 sm:inset-x-3 sm:bottom-3 ${
          beside
            ? "lg:right-[calc(min(44rem,48vw)+1.5rem)] lg:left-3"
            : !sideColumn
              ? "lg:inset-x-0 lg:mx-auto lg:w-[min(50rem,calc(100vw-30rem))]"
              : roomy
                ? // 右の列と重ならない幅で、画面の横の真ん中に置く
                  "lg:inset-x-0 lg:mx-auto lg:w-[min(50rem,calc(100vw-47rem))]"
                : // 真ん中に置くと狭くなりすぎる幅では、右の列の左の空いたところに置く
                  "lg:right-[24rem] lg:left-3 lg:mx-auto lg:max-w-[50rem]"
        }`}
      >
        {/* 右の列がないときは、待ち時間の窓を会話の窓の真上の中ほどに置き、左上の店内のようすに重ねない */}
        {sideColumn || !showWaiting ? null : (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-full mx-auto mb-6 flex w-full max-w-md flex-col [&>*]:pointer-events-auto"
            // 上へ伸びても、上の段にかからない高さまでにする（札の分と、会話の窓との間を除く）
            style={{ maxHeight: `max(10rem, calc(100dvh - ${frame.top + frame.bottom + 48}px))` }}
          >
            <WaitingCard />
          </div>
        )}
        <DialogueBox />
      </div>

      {leadingOut ? (
        <p
          role="status"
          data-testid="lead-out"
          className="-translate-x-1/2 absolute bottom-6 left-1/2 z-30 max-w-[90vw] animate-pop rounded-full border-2 border-yamabuki-400 bg-kinari-50 px-5 py-2 text-center font-bold text-ink shadow-xl"
        >
          {t.street.leadOut}
        </p>
      ) : null}
      <PlayNoticeToast />
      <CandidateCards />
      <FestivalResults />
      <PasscodeDialog />
      {logOpen ? <Backlog onClose={() => setLogOpen(false)} /> : null}
    </div>
  );
}
