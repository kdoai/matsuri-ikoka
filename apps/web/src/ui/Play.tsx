import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useState } from "react";
import type { Interaction } from "../scenes/controls";
import { type PlayNotice, playStore, usePlay } from "../state/play";
import { useApp, useT } from "../state/react";
import { KeyCap } from "./Hud";
import { useMediaQuery } from "./hooks";
import { Portrait } from "./Portraits";

// 店の中で遊ぶための 2D の部品：旅人の頭の横の「話す・使う」、操作の案内、仕掛けの結果の知らせ。
// 3D に出ることは、ここでもすべて文字で読める（近くにあるもの・見つけたひよこ・時計の時刻）。

type Messages = ReturnType<typeof useT>;

function interactionLabel(t: Messages, near: Interaction): string {
  switch (near.kind) {
    case "talk":
      return t.play.talk(t.staff.names[near.staff]);
    case "sit":
      return t.play.sit;
    case "chick":
      return t.play.chick;
    case "gimmick":
      return t.play.gimmicks[near.gimmick];
    case "exit":
      return t.play.exit;
  }
}

function noticeText(t: Messages, notice: PlayNotice): string {
  switch (notice.kind) {
    case "omikuji":
      return t.play.omikuji(t.play.fortunes[notice.fortune] ?? "");
    case "gacha":
      return t.play.gacha(t.play.prizes[notice.prize] ?? "");
    case "chick":
      return t.play.chickFound(notice.found);
    case "allChicks":
      return t.play.allChicks;
    case "staffOnly":
      return t.play.staffOnly;
    case "gimmick":
      return notice.interaction.kind === "gimmick"
        ? t.play.results[notice.interaction.gimmick]
        : interactionLabel(t, notice.interaction);
  }
}

/** いまの「使う」の文言。座っているときは「立つ」 */
function usePromptLabel(): string | null {
  const t = useT();
  const near = usePlay((state) => state.near);
  const sitting = usePlay((state) => state.sitting);
  if (sitting) return t.play.stand;
  return near === null ? null : interactionLabel(t, near);
}

/** 旅人の頭の横に出す「話す・使う」。位置は 3D の中から毎フレーム書き込む（data-bubble） */
export function PlayPrompt() {
  const label = usePromptLabel();
  const entering = usePlay((state) => state.entering);
  if (label === null || entering) return null;
  return (
    <div className="pointer-events-none absolute inset-0">
      <button
        type="button"
        data-bubble="player"
        data-testid="play-prompt"
        onClick={() => playStore.getState().requestInteract()}
        className="pointer-events-auto absolute top-0 left-0 flex items-center gap-2 whitespace-nowrap rounded-full border-2 border-yamabuki-400 bg-ink/75 py-1 pr-4 pl-1 font-bold text-kinari-50 shadow-lg backdrop-blur-sm transition hover:bg-ink/90"
      >
        <KeyCap>E</KeyCap>
        {label}
      </button>
    </div>
  );
}

function useClockText(locale: string): string {
  const format = () =>
    new Intl.DateTimeFormat(locale === "ja" ? "ja-JP" : "en-US", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date());
  const [text, setText] = useState(format);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 言語が変わったら書き直す
  useEffect(() => {
    setText(format());
    const timer = setInterval(() => setText(format()), 15_000);
    return () => clearInterval(timer);
  }, [locale]);
  return text;
}

/** 操作の案内と、店の中のようす（近くにあるもの・ひよこ・時計）。3D の旅人がいるときだけ出す */
export function PlayGuide() {
  const t = useT();
  const locale = useApp((state) => state.ui.locale);
  const active = usePlay((state) => state.active);
  const entering = usePlay((state) => state.entering);
  const chicks = usePlay((state) => state.chicks.length);
  const sitting = usePlay((state) => state.sitting);
  const label = usePromptLabel();
  const wide = useMediaQuery("(min-width: 1024px)");
  const [open, setOpen] = useState<boolean | null>(null);
  const clock = useClockText(locale);
  if (!active || entering) return null;
  const expanded = open ?? wide;
  return (
    <section
      aria-label={t.play.controlsTitle}
      className="rounded-2xl border-2 border-kinari-50/70 bg-ink/70 px-3 py-2 text-kinari-50 text-xs shadow-lg backdrop-blur-sm sm:text-sm"
      data-testid="play-guide"
    >
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 font-bold"
        aria-expanded={expanded}
        aria-controls="play-controls"
        onClick={() => setOpen(!expanded)}
      >
        <span>{t.play.controlsTitle}</span>
        {expanded ? (
          <ChevronUp aria-hidden="true" className="size-4" />
        ) : (
          <ChevronDown aria-hidden="true" className="size-4" />
        )}
        <span className="sr-only">{expanded ? t.play.controlsHide : t.play.controlsShow}</span>
      </button>
      {expanded ? (
        <dl id="play-controls" className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
          {t.play.controls.map((row) => (
            <div key={row.keys} className="contents">
              <dt className="whitespace-nowrap font-bold text-yamabuki-200">{row.keys}</dt>
              <dd>{row.action}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div
        className="mt-1.5 space-y-0.5 border-kinari-50/30 border-t pt-1.5"
        data-testid="play-status"
      >
        <p>
          <span className="font-bold">{t.play.near}：</span>
          {sitting ? t.play.sitting : (label ?? t.play.nothingNear)}
        </p>
        <p>
          {t.play.chicks(chicks)}・{t.play.clock(clock)}
        </p>
      </div>
    </section>
  );
}

/** 仕掛けを使った結果の知らせ。数秒で消え、読み上げにも伝える */
export function PlayNoticeToast() {
  const t = useT();
  const notice = usePlay((state) => state.notice);
  const [shown, setShown] = useState<number | null>(null);
  useEffect(() => {
    if (notice === null) return;
    setShown(notice.seq);
    const timer = setTimeout(() => setShown(null), 3_500);
    return () => clearTimeout(timer);
  }, [notice]);
  const visible = notice !== null && shown === notice.seq;
  return (
    <div
      role="status"
      className="-translate-x-1/2 pointer-events-none absolute top-20 left-1/2 z-40 max-w-[min(26rem,90vw)]"
    >
      {visible ? (
        <p
          key={notice.seq}
          className="animate-pop rounded-full border-2 border-yamabuki-400 bg-kinari-50 px-4 py-1.5 text-center font-bold text-ink text-sm shadow-xl"
          data-testid="play-notice"
        >
          {noticeText(t, notice.value)}
        </p>
      ) : null}
    </div>
  );
}

/**
 * 会話の窓をしまっている間の案内。3D の店では、コンシェルジュの頭の上に「話しかけてね」の吹き出しを出す
 * （位置は 3D の中から書き込む）。同じ文は下の案内の帯でも読める
 */
export function GreetingBubble() {
  const t = useT();
  const open = useApp((state) => state.ui.dialogueOpen);
  const streaming = useApp((state) => state.session.streaming);
  const entering = usePlay((state) => state.entering);
  if (open || streaming || entering) return null;
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      <p
        data-bubble="concierge"
        className="absolute top-0 left-0 max-w-60 rounded-2xl border-2 border-yamabuki-400 bg-kinari-50 px-3 py-1.5 text-center font-bold text-ink text-sm leading-snug shadow-lg"
        data-testid="greeting-bubble"
      >
        {t.dialogue.greeting}
      </p>
    </div>
  );
}

/**
 * 会話の窓をしまっている間、窓の場所に出す帯。コンシェルジュの案内の文と「話しかける」のボタン。
 * キーボード（Tab と Enter、または E）だけでも相談を始められる
 */
export function GreetingBar({ onTalk }: { onTalk: () => void }) {
  const t = useT();
  const entering = usePlay((state) => state.entering);
  if (entering) return null;
  return (
    <div
      className="mx-auto flex w-full max-w-xl items-center gap-2 rounded-3xl border-2 border-wood-700/60 bg-kinari-50/95 py-1.5 pr-1.5 pl-2 shadow-xl sm:gap-3"
      data-testid="greeting-bar"
    >
      <Portrait speaker="concierge" className="size-10 border-2" />
      <p className="min-w-0 flex-1 font-bold text-ink text-xs leading-snug sm:text-sm">
        {t.dialogue.greeting}
      </p>
      <button
        type="button"
        onClick={onTalk}
        aria-label={t.dialogue.talkToConcierge}
        className="flex shrink-0 items-center gap-2 rounded-full border-2 border-yamabuki-400 bg-ink/85 py-1 pr-3 pl-1 font-bold text-kinari-50 text-sm shadow transition hover:bg-ink sm:pr-4"
      >
        <KeyCap>E</KeyCap>
        {/* 狭い画面では短くする（読み上げは aria-label の全文） */}
        <span aria-hidden="true" className="sm:hidden">
          {t.hud.hints.talk}
        </span>
        <span aria-hidden="true" className="hidden sm:inline">
          {t.dialogue.talkToConcierge}
        </span>
      </button>
    </div>
  );
}
