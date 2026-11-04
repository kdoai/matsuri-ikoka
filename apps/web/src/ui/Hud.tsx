import { mainFestivalDay } from "@matsuri-ikoka/schema";
import {
  BookOpen,
  CircleHelp,
  ClipboardCheck,
  Map as MapIcon,
  Menu,
  MessageCircleMore,
  Route,
  Settings,
  Sparkles,
  Sun,
  Volume2,
  VolumeX,
} from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { formatDate, otherLocale } from "../i18n";
import { hasNextSteps } from "../state/events";
import { useActions, useApp, useT } from "../state/react";
import { shioriReady } from "../state/selectors";
import type { PanelTab } from "../state/types";
import { YaguraIcon } from "./icons";
import { ControlsList, PlayStatus } from "./Play";
import { playSound } from "./sound";

// ゲームの画面に重ねる表示（HUD）：ロゴ、丸いボタン、日付の札、操作の案内。
// 探索の間は小さな札だけを出し、3D の店内を隠さない。どれもストアを読むだけで、操作はストアの actions を呼ぶ。

/** HUD の紙の板の見た目 */
export const hudCard = "washi rounded-panel border border-line-strong shadow-lift";

// ---------------------------------------------------------------------------
// 上の段

export function Logo() {
  const t = useT();
  return (
    <h1 className="flex items-center gap-2 text-kinari-50 drop-shadow-[0_2px_4px_rgb(0_0_0/0.6)]">
      <YaguraIcon className="size-9 shrink-0 sm:size-12" />
      <span className="sr-only flex-col font-bold text-sm leading-tight tracking-[0.25em] sm:not-sr-only sm:flex sm:text-lg">
        <span>MATSURI</span>
        <span>IKOKA</span>
      </span>
      <span className="sr-only">{t.app.tagline}</span>
    </h1>
  );
}

const roundIcon =
  "relative grid size-10 shrink-0 place-items-center sm:size-11 rounded-full border-2 border-kinari-50/85 bg-ai-900/70 text-kinari-50 shadow-lg backdrop-blur-sm transition hover:bg-ai-700";

/** 丸いボタンから開く小さな板。外を押すか Esc で閉じる。中身が長ければ、板の中でスクロールする */
function Popover({
  id,
  title,
  onClose,
  wide = false,
  children,
}: {
  id: string;
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      id={id}
      role="dialog"
      aria-label={title}
      className={`${hudCard} absolute top-full right-0 z-50 mt-2 flex max-h-[calc(100dvh-6rem)] flex-col p-4 text-ink ${
        wide ? "w-[min(32rem,calc(100vw-1.5rem))]" : "w-[min(22rem,calc(100vw-1.5rem))]"
      }`}
    >
      <div className="mb-2 flex shrink-0 items-center justify-between gap-2">
        <p className="font-bold text-lg">{title}</p>
        <button
          type="button"
          className="min-h-10 rounded-full px-3 text-base text-ink-soft hover:bg-kinari-200"
          onClick={onClose}
        >
          {t.hud.close}
        </button>
      </div>
      <div className="-mr-2 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-2">{children}</div>
    </div>
  );
}

type Panel = "menu" | "settings" | "help" | null;

type Actions = ReturnType<typeof useActions>;

/** 旅程のパネルを、指定したタブで開く（候補のカードが開いていれば閉じる） */
export function openTripPanel(actions: Actions, tab: PanelTab): void {
  actions.setCandidatesOpen(false);
  actions.setTab(tab);
  actions.setDrawer(true);
}

const helpHeading =
  "mb-1.5 border-wood-300 border-b-2 pb-1 font-bold text-ai-800 text-lg leading-snug";

const menuItem =
  "flex min-h-12 w-full items-center gap-3 rounded-xl border-2 border-wood-300/70 bg-white px-3 font-bold text-ink transition hover:border-ai-500 hover:bg-ai-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-45 aria-disabled:hover:border-wood-300/70 aria-disabled:hover:bg-white";

/** メニュー：旅程・地図・出典・候補・しおり・会話の記録をまとめて開く */
function GameMenu({
  onOpenLog,
  onHelp,
  onClose,
}: {
  onOpenLog: () => void;
  onHelp: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const actions = useActions();
  const hasCandidates = useApp(
    (state) => state.candidates.length > 0 || hasNextSteps(state.search),
  );
  const hasItinerary = useApp((state) => state.itinerary.current !== null);
  const ready = useApp(shioriReady);
  const items: { key: string; label: string; icon: ReactNode; run: (() => void) | null }[] = [
    {
      key: "details",
      label: t.hud.hints.details,
      icon: <Route className="size-5 text-ai-700" />,
      run: () => openTripPanel(actions, "itinerary"),
    },
    {
      key: "map",
      label: t.hud.hints.map,
      icon: <MapIcon className="size-5 text-ai-700" />,
      run: () => openTripPanel(actions, "map"),
    },
    {
      key: "confirm",
      label: t.hud.sections.confirm,
      icon: <ClipboardCheck className="size-5 text-ai-700" />,
      run: hasItinerary ? () => openTripPanel(actions, "sources") : null,
    },
    {
      key: "candidates",
      label: t.hud.sections.candidates,
      icon: <Sparkles className="size-5 text-shu-600" />,
      run: hasCandidates ? () => actions.setCandidatesOpen(true) : null,
    },
    {
      key: "shiori",
      label: t.hud.sections.shiori,
      icon: <BookOpen className="size-5 text-shu-600" />,
      run: ready ? () => actions.openShiori() : null,
    },
    {
      key: "log",
      label: t.hud.notifications,
      icon: <MessageCircleMore className="size-5 text-wood-700" />,
      run: onOpenLog,
    },
    {
      key: "help",
      label: t.hud.help,
      icon: <CircleHelp className="size-5 text-wood-700" />,
      run: onHelp,
    },
  ];
  return (
    <Popover id="hud-menu" title={t.hud.menuTitle} onClose={onClose}>
      <ul className="grid grid-cols-2 gap-2" data-testid="game-menu">
        {items.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              className={menuItem}
              aria-disabled={item.run === null}
              title={item.run === null ? t.hud.notYet : undefined}
              onClick={() => {
                if (item.run === null) return;
                onClose();
                item.run();
              }}
            >
              <span aria-hidden="true">{item.icon}</span>
              <span className="text-left text-base leading-tight">{item.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </Popover>
  );
}

/** 右上の丸いボタン：会話の記録・設定・使い方（メニューは、左に並ぶ操作の案内の M から開く） */
export function IconButtons({
  onOpenLog,
  unread,
  menu,
  onMenu,
}: {
  onOpenLog: () => void;
  unread: boolean;
  menu: Panel;
  onMenu: (panel: Panel) => void;
}) {
  const t = useT();
  const actions = useActions();
  const locale = useApp((state) => state.ui.locale);
  const soundOn = useApp((state) => state.ui.soundOn);
  const toggle = (panel: Exclude<Panel, null>) => onMenu(menu === panel ? null : panel);
  const close = () => onMenu(null);

  return (
    <div className="relative flex items-center gap-1.5 sm:gap-2" data-testid="icon-buttons">
      <button
        type="button"
        className={roundIcon}
        aria-label={t.hud.notifications}
        title={t.hud.notifications}
        onClick={onOpenLog}
      >
        <MessageCircleMore className="size-5" />
        {unread ? (
          <span className="absolute top-0.5 right-0.5 size-3 rounded-full bg-shu-500 ring-2 ring-kinari-50">
            <span className="sr-only">{t.hud.newNotice}</span>
          </span>
        ) : null}
      </button>
      <button
        type="button"
        className={roundIcon}
        aria-label={t.hud.settings}
        title={t.hud.settings}
        aria-expanded={menu === "settings"}
        aria-controls="hud-settings"
        onClick={() => toggle("settings")}
      >
        <Settings className="size-5" />
      </button>
      <button
        type="button"
        className={`${roundIcon} max-sm:hidden`}
        aria-label={t.hud.help}
        title={t.hud.help}
        aria-expanded={menu === "help"}
        aria-controls="hud-help"
        onClick={() => toggle("help")}
      >
        <CircleHelp className="size-5" />
      </button>

      {menu === "menu" ? (
        <GameMenu onOpenLog={onOpenLog} onHelp={() => onMenu("help")} onClose={close} />
      ) : null}
      {menu === "settings" ? (
        <Popover id="hud-settings" title={t.hud.settings} onClose={close}>
          <div className="grid gap-2">
            <button
              type="button"
              className="min-h-11 rounded-xl border-2 border-ai-200 bg-white px-3 font-bold text-ai-800"
              lang={otherLocale(locale)}
              aria-label={`${t.app.language}: ${t.app.switchTo}`}
              onClick={() => actions.setLocale(otherLocale(locale))}
            >
              {t.app.switchTo}
            </button>
            <button
              type="button"
              className="flex min-h-11 items-center justify-center gap-2 rounded-xl border-2 border-ai-200 bg-white px-3 font-bold text-ai-800"
              aria-pressed={soundOn}
              title={t.app.soundHint}
              onClick={() => {
                actions.setSound(!soundOn);
                if (!soundOn) playSound("hyoshigi");
              }}
            >
              {soundOn ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
              {soundOn ? t.app.soundOn : t.app.soundOff}
            </button>
            <button
              type="button"
              className="min-h-11 rounded-xl border-2 border-shu-500/60 bg-white px-3 font-bold text-shu-700"
              onClick={() => {
                close();
                void actions.restart();
              }}
            >
              {t.app.restart}
            </button>
          </div>
        </Popover>
      ) : null}
      {menu === "help" ? (
        <Popover id="hud-help" title={t.hud.helpTitle} onClose={close} wide>
          <div className="space-y-4 text-base leading-relaxed" data-testid="help">
            <section aria-labelledby="help-steps">
              <h3 id="help-steps" className={helpHeading}>
                {t.hud.helpSections.steps}
              </h3>
              <ol className="list-decimal space-y-2 pl-6">
                {t.hud.helpLines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ol>
            </section>
            <section aria-labelledby="help-controls">
              <h3 id="help-controls" className={helpHeading}>
                {t.play.controlsTitle}
              </h3>
              <ControlsList large />
            </section>
            <section aria-labelledby="help-status">
              <h3 id="help-status" className={helpHeading}>
                {t.hud.helpSections.status}
              </h3>
              <PlayStatus className="text-ink-soft" />
            </section>
          </div>
        </Popover>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 日付の札と操作の案内

/** 日付と出発の駅。ロゴの下の小さな札 */
export function DateBadge() {
  const t = useT();
  const locale = useApp((state) => state.ui.locale);
  const itinerary = useApp((state) => state.itinerary.current);
  const conditions = useApp((state) => state.session.conditions);
  const date =
    (itinerary ? mainFestivalDay(itinerary).date : undefined) ??
    (conditions.when?.kind === "date" ? conditions.when.date : undefined);
  const origin = itinerary?.origin ?? conditions.origin;
  return (
    <section
      aria-label={t.conditions.title}
      className="hud-chip flex w-fit items-center gap-1.5 rounded-full py-1 pr-3 pl-2 text-xs leading-tight sm:text-sm"
      data-testid="date-badge"
    >
      <Sun aria-hidden="true" className="size-4 shrink-0 text-yamabuki-400" />
      <span className="font-bold">
        {date === undefined ? t.hud.dateUnset : formatDate(date, locale)}
      </span>
      {origin === undefined ? null : <span>・{t.hud.from(origin)}</span>}
    </section>
  );
}

/** 接客サーバーが見本の相談を再生しているとき（mock）だけ出す、小さな札 */
export function ModeBadge() {
  const t = useT();
  const mode = useApp((state) => state.session.mode);
  if (mode !== "mock") return null;
  return (
    <p
      className="hud-chip w-fit rounded-full px-3 py-1 text-xs leading-tight"
      data-testid="mode-badge"
      title={t.hud.replayingNote}
    >
      {t.hud.replaying}
      <span className="sr-only">。{t.hud.replayingNote}</span>
    </p>
  );
}

export function KeyCap({ children, small = false }: { children: ReactNode; small?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center rounded-full bg-kinari-50 font-black text-ink ${
        small ? "size-5 text-[0.7rem]" : "size-7 text-sm"
      }`}
    >
      {children}
    </span>
  );
}

/**
 * 操作の案内（上の段の、丸いボタンの左に同じ段で並ぶ札）。キーボードの X・Y・M、ゲームパッドの X・Y・スタートでも同じことができる。
 * 上の段の中に置くので、店内の絵や会話の窓・旅のしおりと重ならない。狭い画面ではキーの印とアイコンだけにする
 */
export function ButtonHints({
  onDetails,
  onMap,
  onMenu,
  menuOpen,
}: {
  onDetails: () => void;
  onMap: () => void;
  onMenu: () => void;
  menuOpen: boolean;
}) {
  const t = useT();
  const hint =
    "flex min-h-9 items-center gap-1 rounded-full py-0.5 pr-1.5 pl-0.5 font-bold text-sm transition hover:bg-kinari-50/15 sm:gap-1.5 sm:pr-2.5 sm:text-base";
  return (
    <nav
      aria-label={t.hud.opsGuide}
      className="hud-chip flex items-center gap-0.5 rounded-full p-1"
      data-testid="button-hints"
    >
      <button type="button" className={hint} onClick={onDetails} aria-label={t.hud.hints.details}>
        <KeyCap>X</KeyCap>
        <Route aria-hidden="true" className="size-4" />
        <span aria-hidden="true" className="max-sm:hidden">
          {t.hud.hints.details}
        </span>
      </button>
      <button type="button" className={hint} onClick={onMap} aria-label={t.hud.hints.map}>
        <KeyCap>Y</KeyCap>
        <MapIcon aria-hidden="true" className="size-4" />
        <span aria-hidden="true" className="max-sm:hidden">
          {t.hud.hints.map}
        </span>
      </button>
      <button
        type="button"
        className={hint}
        onClick={onMenu}
        aria-label={t.hud.hints.menu}
        aria-expanded={menuOpen}
        aria-controls="hud-menu"
      >
        <KeyCap>M</KeyCap>
        <Menu aria-hidden="true" className="size-4" />
        <span aria-hidden="true" className="max-sm:hidden">
          {t.hud.hints.menu}
        </span>
      </button>
    </nav>
  );
}

/** 2D のときの「話す」（3D のときは旅人の頭の横に出る） */
export function TalkButton({ onTalk }: { onTalk: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onTalk}
      className="flex items-center gap-2 rounded-full border-2 border-yamabuki-400 bg-ink/75 py-1 pr-4 pl-1 font-bold text-kinari-50 shadow-lg backdrop-blur-sm transition hover:bg-ink/90"
    >
      <KeyCap>E</KeyCap>
      {t.hud.hints.talk}
    </button>
  );
}

/**
 * キーボードでの操作：E（ほかに焦点がなければ Enter・Space も）で話す・使う、X で旅程、Y で地図、M でメニュー。
 * 旅人を歩かせる WASD・矢印は、3D の旅人が受ける。
 * 文字を入力しているときは何もしない。
 */
export function useHudKeys(handlers: {
  talk: () => void;
  details: () => void;
  map: () => void;
  menu: () => void;
}): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        (target?.closest("input, textarea, select, [contenteditable='true']") ?? null) !== null
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      // Enter と Space は、ボタンなどに焦点がないときだけ（ボタンの上では押したことになる）
      const onPage = target === null || target === document.body || target.tagName === "CANVAS";
      const action =
        key === "e" || ((key === "enter" || key === " ") && onPage)
          ? ref.current.talk
          : key === "x"
            ? ref.current.details
            : key === "y"
              ? ref.current.map
              : key === "m" || key === "+"
                ? ref.current.menu
                : null;
      if (action !== null) {
        event.preventDefault();
        action();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export type { Panel as HudPanel };
