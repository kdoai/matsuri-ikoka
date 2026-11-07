import { useEffect, useState } from "react";
import type { Interaction } from "../scenes/controls";
import { type PlayNotice, playStore, usePlay } from "../state/play";
import { useActions, useApp, useT } from "../state/react";
import { KeyCap } from "./Hud";
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
    case "stall":
      return t.street.lookStall;
    case "door":
      return t.street.backToShop;
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
  const onStreet = useApp((state) => state.ui.view === "street");
  if (sitting) return t.play.stand;
  // 通りのコンシェルジュは、旅のガイドとして話を聞く
  if (onStreet && near?.kind === "talk") return t.street.talk;
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

/** 操作の一覧。「使い方」とはじめての案内で出す。large のときは 16px の文字で、行の間を広げる */
export function ControlsList({
  rows,
  large = false,
}: {
  rows?: readonly { keys: string; action: string }[];
  large?: boolean;
}) {
  const t = useT();
  return (
    <dl
      className={`grid grid-cols-[auto_1fr] gap-x-4 ${large ? "gap-y-1.5 text-base" : "gap-y-0.5 text-sm"}`}
    >
      {(rows ?? t.play.controls).map((row) => (
        <div key={row.keys} className="contents">
          <dt className="whitespace-nowrap font-bold text-wood-700">{row.keys}</dt>
          <dd>{row.action}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * 店の中のようす（近くにあるもの・見つけたひよこ・店の時計）。3D に出ることを文字で読めるようにする。
 * ふだんは読み上げにだけ伝え（画面には旅人の頭の横の「E ○○」が出る）、「使い方」の中では見える文字で出す
 */
export function PlayStatus({
  className,
  hidden = false,
}: {
  className?: string;
  hidden?: boolean;
}) {
  const t = useT();
  const locale = useApp((state) => state.ui.locale);
  const chicks = usePlay((state) => state.chicks.length);
  const sitting = usePlay((state) => state.sitting);
  const label = usePromptLabel();
  const clock = useClockText(locale);
  return (
    <div className={hidden ? "sr-only" : className} data-testid="play-status">
      <p>
        <span className="font-bold">{t.play.near}：</span>
        {sitting ? t.play.sitting : (label ?? t.play.nothingNear)}
      </p>
      <p>
        {t.play.chicks(chicks)}・{t.play.clock(clock)}
      </p>
    </div>
  );
}

/**
 * はじめての操作の案内。最初に店に入ったときだけ出し、閉じるか、コンシェルジュに話しかけたら消える。
 * そのあとは右上の「使い方」から開ける
 */
export function Tutorial() {
  const t = useT();
  const actions = useActions();
  const seen = useApp((state) => state.ui.tutorialSeen);
  const entering = usePlay((state) => state.entering);
  if (seen || entering) return null;
  return (
    <section
      aria-labelledby="tutorial-title"
      className="washi w-72 animate-pop rounded-panel border border-line-strong p-3 text-ink shadow-lift"
      data-testid="play-guide"
    >
      <h2 id="tutorial-title" className="mb-1.5 font-bold">
        {t.tutorial.title}
      </h2>
      <ControlsList rows={t.tutorial.lines} />
      <p className="mt-2 font-bold text-ai-800 text-sm">{t.tutorial.talk}</p>
      <p className="mt-1 text-ink-soft text-xs">{t.tutorial.later}</p>
      <div className="mt-2 text-right">
        <button
          type="button"
          className="min-h-9 rounded-full border-2 border-wood-700/30 bg-yamabuki-400 px-4 font-bold text-ink text-sm shadow-soft"
          onClick={actions.dismissTutorial}
        >
          {t.tutorial.ok}
        </button>
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
 * 会話の窓をしまっている間の目印。3D の店では、コンシェルジュの頭の上に小さな「！」の札を出す
 * （位置は 3D の中から書き込む）。同じことは下の「話しかける」のボタンでも読める
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
        className="absolute top-0 left-0 flex items-center gap-1 rounded-full border-2 border-yamabuki-400 bg-kinari-50 py-0.5 pr-2.5 pl-1 font-bold text-ink text-xs shadow-soft"
        data-testid="greeting-bubble"
      >
        {/* 位置は 3D の中から transform で書き込むので、跳ねる動きは中の印だけに付ける */}
        <span className="grid size-5 animate-bounce place-items-center rounded-full bg-yamabuki-400 font-black">
          ！
        </span>
        {t.tutorial.marker}
      </p>
    </div>
  );
}

/**
 * 会話の窓をしまっている間、画面の下に出す小さな「話しかける」のボタン。
 * キーボード（Tab と Enter、または E）だけでも相談を始められる
 */
export function GreetingBar({ onTalk }: { onTalk: () => void }) {
  const t = useT();
  const entering = usePlay((state) => state.entering);
  if (entering) return null;
  return (
    <div className="mx-auto flex w-fit items-center" data-testid="greeting-bar">
      <button
        type="button"
        onClick={onTalk}
        aria-label={t.dialogue.talkToConcierge}
        className="hud-chip flex shrink-0 items-center gap-2 rounded-full py-1 pr-4 pl-1 font-bold text-sm transition hover:bg-ink/80"
      >
        <Portrait speaker="concierge" className="size-8 border" />
        <KeyCap small>E</KeyCap>
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
