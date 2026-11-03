import { mainFestivalDay } from "@matsuri-ikoka/schema";
import {
  Bell,
  BookOpen,
  Briefcase,
  ChevronRight,
  CircleHelp,
  ClipboardCheck,
  Landmark,
  Map as MapIcon,
  Maximize2,
  Menu,
  Navigation,
  Route,
  Settings,
  Sparkles,
  Sun,
  Volume2,
  VolumeX,
} from "lucide-react";
import { lazy, type ReactNode, Suspense, useEffect, useRef } from "react";
import { formatDate, otherLocale } from "../i18n";
import { useActions, useApp, useT } from "../state/react";
import { currentSection, mainFestival, type Section, shioriReady } from "../state/selectors";
import type { PanelTab } from "../state/types";
import { ConditionChips, PreferenceBar } from "./ChatPanel";
import { LanternIcon, YaguraIcon } from "./icons";
import { playSound } from "./sound";

// ゲームの画面に重ねる表示（HUD）：ロゴ、場面のタブ、丸いボタン、旅の案内のカード、小さな地図、
// 日付、ボタンの案内。どれもストアを読むだけで、操作はストアの actions を呼ぶ。

const MapView = lazy(() => import("./MapView"));

/** HUD の紙の板の見た目 */
export const hudCard =
  "rounded-2xl border-2 border-wood-700/50 bg-kinari-50/95 shadow-[0_8px_24px_rgb(0_0_0/0.3)] backdrop-blur-sm";

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

const SECTION_ICON: Record<Section, (props: { className?: string }) => ReactNode> = {
  guide: (props) => <Landmark {...props} />,
  candidates: (props) => <Sparkles {...props} />,
  shiori: (props) => <BookOpen {...props} />,
  confirm: (props) => <ClipboardCheck {...props} />,
};

/** 場面のタブ：旅程の案内・祭りの候補・旅のしおり・確認 */
export function SectionTabs({ className = "" }: { className?: string }) {
  const t = useT();
  const actions = useActions();
  const active = useApp(currentSection);
  const hasCandidates = useApp((state) => state.candidates.length > 0);
  const hasItinerary = useApp((state) => state.itinerary.current !== null);
  const ready = useApp(shioriReady);

  const open: Record<Section, (() => void) | null> = {
    guide: () => openTripPanel(actions, "itinerary"),
    candidates: hasCandidates ? () => actions.setCandidatesOpen(true) : null,
    shiori: ready ? () => actions.openShiori() : null,
    confirm: hasItinerary ? () => openTripPanel(actions, "sources") : null,
  };

  return (
    <nav aria-label={t.hud.sectionsLabel} className={className} data-testid="section-tabs">
      <ul className="flex gap-1 rounded-full bg-ai-900/60 p-1 shadow-lg backdrop-blur-sm">
        {(Object.keys(open) as Section[]).map((section) => {
          const Icon = SECTION_ICON[section];
          const onClick = open[section];
          const current = active === section;
          return (
            <li key={section}>
              <button
                type="button"
                aria-current={current ? "page" : undefined}
                aria-disabled={onClick === null}
                title={onClick === null ? t.hud.notYet : undefined}
                onClick={onClick ?? undefined}
                className={`flex min-h-10 items-center gap-2 whitespace-nowrap rounded-full px-4 py-1.5 font-bold text-sm transition ${
                  current
                    ? "bg-yamabuki-400 text-ink shadow-[inset_0_-2px_0_rgb(0_0_0/0.15)]"
                    : onClick === null
                      ? "cursor-not-allowed text-kinari-50/45"
                      : "text-kinari-50 hover:bg-ai-700/80"
                }`}
              >
                <Icon className="size-4.5" />
                {t.hud.sections[section]}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

const roundIcon =
  "relative grid size-10 shrink-0 place-items-center sm:size-11 rounded-full border-2 border-kinari-50/85 bg-ai-900/70 text-kinari-50 shadow-lg backdrop-blur-sm transition hover:bg-ai-700";

/** 丸いボタンから開く小さな板。外を押すか Esc で閉じる */
function Popover({
  id,
  title,
  onClose,
  children,
}: {
  id: string;
  title: string;
  onClose: () => void;
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
      className={`${hudCard} absolute top-full right-0 z-50 mt-2 w-[min(22rem,calc(100vw-1.5rem))] p-4 text-ink`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="font-bold">{title}</p>
        <button
          type="button"
          className="rounded-full px-2 py-0.5 text-ink-soft text-sm hover:bg-kinari-200"
          onClick={onClose}
        >
          {t.hud.close}
        </button>
      </div>
      {children}
    </div>
  );
}

type Panel = "menu" | "preferences" | "settings" | "help" | null;

type Actions = ReturnType<typeof useActions>;

/** 旅程のパネルを、指定したタブで開く（候補のカードが開いていれば閉じる） */
export function openTripPanel(actions: Actions, tab: PanelTab): void {
  actions.setCandidatesOpen(false);
  actions.setTab(tab);
  actions.setDrawer(true);
}

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
  const hasCandidates = useApp((state) => state.candidates.length > 0);
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
      icon: <Bell className="size-5 text-wood-700" />,
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
              <span className="text-left text-sm leading-tight">{item.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </Popover>
  );
}

/** 右上の丸いボタン：お知らせ（会話の記録）・旅のこだわり・設定・使い方（狭い画面ではメニューも） */
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
        className={`${roundIcon} lg:hidden`}
        aria-label={t.hud.hints.menu}
        title={t.hud.hints.menu}
        aria-expanded={menu === "menu"}
        aria-controls="hud-menu"
        onClick={() => toggle("menu")}
      >
        <Menu className="size-5" />
      </button>
      <button
        type="button"
        className={roundIcon}
        aria-label={t.hud.notifications}
        title={t.hud.notifications}
        onClick={onOpenLog}
      >
        <Bell className="size-5" />
        {unread ? (
          <span className="absolute top-0.5 right-0.5 size-3 rounded-full bg-shu-500 ring-2 ring-kinari-50">
            <span className="sr-only">{t.hud.newNotice}</span>
          </span>
        ) : null}
      </button>
      <button
        type="button"
        className={roundIcon}
        aria-label={t.hud.preferences}
        title={t.hud.preferences}
        aria-expanded={menu === "preferences"}
        aria-controls="hud-preferences"
        onClick={() => toggle("preferences")}
      >
        <Briefcase className="size-5" />
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
      {menu === "preferences" ? (
        <Popover id="hud-preferences" title={t.hud.preferences} onClose={close}>
          <div className="space-y-3">
            <ConditionChips />
            <PreferenceBar />
          </div>
        </Popover>
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
        <Popover id="hud-help" title={t.hud.helpTitle} onClose={close}>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-relaxed">
            {t.hud.helpLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        </Popover>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 右上：旅の案内のカードと小さな地図

/** 旅の案内：いまの旅程（なければ相談の入り口）、主役の祭りの見どころ、次にすること */
export function GuideCard() {
  const t = useT();
  const actions = useActions();
  const locale = useApp((state) => state.ui.locale);
  const itinerary = useApp((state) => state.itinerary.current);
  const stage = useApp((state) => state.session.stage);
  const conditions = useApp((state) => state.session.conditions);
  const festival = useApp(mainFestival);
  const ready = useApp(shioriReady);

  const date =
    (itinerary ? mainFestivalDay(itinerary).date : undefined) ??
    (conditions.when?.kind === "date" ? conditions.when.date : undefined);
  const origin = itinerary?.origin ?? conditions.origin;
  const highlight = festival?.highlights[0] ?? null;

  return (
    <section aria-labelledby="guide-card-title" className={`${hudCard} relative w-full p-3 pt-5`}>
      <p
        id="guide-card-title"
        className="-top-3.5 absolute left-3 flex items-center gap-1.5 rounded-full bg-ai-800 py-1 pr-3 pl-2 font-bold text-kinari-50 text-xs shadow-md ring-2 ring-yamabuki-400"
      >
        <LanternIcon className="size-4 text-yamabuki-400" />
        {t.hud.guideTitle}
      </p>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-bold text-ink text-lg leading-snug">
            {itinerary?.title ?? t.hud.noTrip}
          </p>
          {date !== undefined || origin !== undefined ? (
            <p className="mt-0.5 text-ink-soft text-sm">
              {[date === undefined ? null : formatDate(date, locale), origin]
                .filter((part) => part !== null && part !== undefined)
                .join("・")}
            </p>
          ) : null}
          {festival !== null ? (
            <p className="mt-1.5 text-sm">
              <span className="mr-1 rounded bg-shu-600 px-1.5 py-0.5 font-bold text-white text-xs">
                {t.hud.mainFestival}
              </span>
              <span className="font-bold">{festival.name.ja}</span>
              {highlight === null ? null : <span className="block text-ink-soft">{highlight}</span>}
            </p>
          ) : null}
          <p
            className={`mt-1.5 flex items-start gap-1.5 text-sm ${ready ? "font-bold text-emerald-800" : "text-ink"}`}
            data-testid="guide-step"
          >
            <span
              aria-hidden="true"
              className={`mt-1 size-3 shrink-0 rounded-sm border-2 ${ready ? "border-emerald-700 bg-emerald-600" : "border-wood-500"}`}
            />
            {t.hud.steps[stage]}
          </p>
        </div>
        {itinerary === null ? null : (
          <button
            type="button"
            className="grid size-8 shrink-0 place-items-center rounded-full bg-kinari-200 text-ink hover:bg-kinari-300"
            aria-label={t.hud.guideOpen}
            title={t.hud.guideOpen}
            onClick={() => openTripPanel(actions, "itinerary")}
          >
            <ChevronRight className="size-5" />
          </button>
        )}
      </div>
    </section>
  );
}

/** 小さな地図：旅程の地点と順番。押すと旅程のパネルの地図を開く */
export function MiniMapCard() {
  const t = useT();
  const actions = useActions();
  return (
    <section
      aria-label={t.hud.minimap}
      className={`${hudCard} relative overflow-hidden p-1`}
      data-testid="mini-map"
    >
      <Suspense fallback={<div className="h-36" />}>
        <MapView interactive={false} heightClass="h-36" showPlaces={false} framed={false} />
      </Suspense>
      <span
        aria-hidden="true"
        className="absolute top-2 right-2 z-[500] grid size-8 place-items-center rounded-full bg-kinari-50 text-ink shadow"
        title={t.hud.north}
      >
        <Navigation className="size-4 fill-ink" />
      </span>
      <button
        type="button"
        className="absolute right-2 bottom-2 z-[500] grid size-8 place-items-center rounded-full bg-kinari-50 text-ink shadow hover:bg-kinari-200"
        aria-label={t.hud.expandMap}
        title={t.hud.expandMap}
        onClick={() => openTripPanel(actions, "map")}
      >
        <Maximize2 className="size-4" />
      </button>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 下の段：日付とボタンの案内

/** 日付と出発の駅（左下） */
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
      className={`${hudCard} flex items-center gap-3 px-4 py-2.5`}
      data-testid="date-badge"
    >
      <Sun aria-hidden="true" className="size-8 shrink-0 text-yamabuki-400 drop-shadow" />
      <div className="leading-tight">
        <p className="font-bold text-ink text-xl">
          {date === undefined ? t.hud.dateUnset : formatDate(date, locale)}
        </p>
        {origin === undefined ? null : (
          <p className="text-ink-soft text-sm">{t.hud.from(origin)}</p>
        )}
      </div>
    </section>
  );
}

function KeyCap({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-7 place-items-center rounded-full bg-kinari-50 font-black text-ink text-sm"
    >
      {children}
    </span>
  );
}

/** ボタンの案内（右下）。キーボードの X・Y・M でも同じことができる */
export function ButtonHints({
  onDetails,
  onMap,
  onMenu,
  stacked = false,
}: {
  onDetails: () => void;
  onMap: () => void;
  onMenu: () => void;
  /** 縦に積む（会話の窓の横に置くとき） */
  stacked?: boolean;
}) {
  const t = useT();
  const hint =
    "flex items-center gap-2 rounded-full border-2 border-kinari-50/70 bg-ink/65 py-1 pr-4 pl-1 font-bold text-kinari-50 text-sm shadow-lg backdrop-blur-sm transition hover:bg-ink/85";
  return (
    <div
      className={`flex gap-2 ${stacked ? "flex-col items-end" : "items-center"}`}
      data-testid="button-hints"
    >
      <button type="button" className={hint} onClick={onDetails}>
        <KeyCap>X</KeyCap>
        {t.hud.hints.details}
      </button>
      <button type="button" className={hint} onClick={onMap}>
        <KeyCap>Y</KeyCap>
        {t.hud.hints.map}
      </button>
      <button type="button" className={hint} onClick={onMenu}>
        <KeyCap>＋</KeyCap>
        {t.hud.hints.menu}
      </button>
    </div>
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
      <KeyCap>A</KeyCap>
      {t.hud.hints.talk}
    </button>
  );
}

/**
 * キーボードでの操作：A で話す、X で旅程、Y で地図、M でメニュー。
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
      const target = event.target as HTMLElement | null;
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        target?.closest("input, textarea, select, [contenteditable='true']") !== null
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      const action =
        key === "a"
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
