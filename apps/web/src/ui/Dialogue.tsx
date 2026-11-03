import type { StaffId } from "@matsuri-ikoka/schema";
import {
  BookOpen,
  CalendarDays,
  CircleCheck,
  Ellipsis,
  Footprints,
  Map as MapIcon,
  MessageCircle,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Undo2,
  X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { useActions, useApp, useT } from "../state/react";
import { currentLine, shioriReady } from "../state/selectors";
import { Composer, focusComposer } from "./ChatPanel";
import { ConsultPanel } from "./Consult";
import { openTripPanel } from "./Hud";
import { Portrait, type Speaker } from "./Portraits";
import { errorText, shortLine } from "./text";

// 会話の窓。話すときだけ画面の下に出す、クリーム色のセリフの枠。
// 左に大きな表情の絵と名札、右にいまの一言（1〜2文。全文は「つづきを読む」と会話の記録で読める）。
// その下に、選んで進める相談か、返事の選択肢（アイコンと文字のボタン）を並べる。自分の言葉で書く欄は、いちばん下に小さく置き、
// 書いている間だけ広げる。これまでのやりとりは、右上の会話の記録で開く。

function NamePlate({ name }: { name: string }) {
  return (
    <p className="-top-4 absolute left-24 flex items-center gap-1.5 rounded-full border border-kinari-50/70 bg-ai-800 py-1 pr-4 pl-2.5 font-bold text-base text-kinari-50 shadow-soft sm:left-36">
      <MessageCircle aria-hidden="true" className="size-4 text-yamabuki-400" />
      {name}
    </p>
  );
}

/** 会話の窓の中で、最初に焦点を置く場所（選択肢、なければ入力欄）へ移る */
export function focusDialogue(): void {
  const first = document.querySelector<HTMLElement>(
    "[data-testid='dialogue'] [data-dialogue-focus]",
  );
  if (first !== null) first.focus();
  else focusComposer();
}

// 選択肢のボタンは、形（replyShape）と色（REPLY_TONE）を分けて重ねる。色のクラスはどちらか一方だけを付ける
const replyShape =
  "inline-flex min-h-16 min-w-[6.5rem] flex-col items-center justify-center gap-1 rounded-2xl border-2 px-3 py-2 text-center font-bold text-base leading-tight shadow-soft transition hover:-translate-y-0.5 motion-reduce:hover:translate-y-0 disabled:cursor-not-allowed disabled:opacity-60";

const REPLY_TONE = {
  plain: "border-line-strong bg-white/90 text-ink hover:border-yamabuki-400",
  primary: "border-wood-700/40 bg-yamabuki-400 text-ink hover:brightness-105",
} as const;

function Reply({
  onClick,
  icon,
  primary = false,
  disabled = false,
  children,
}: {
  onClick: () => void;
  icon: ReactNode;
  primary?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <li>
      <button
        type="button"
        className={`${replyShape} ${REPLY_TONE[primary ? "primary" : "plain"]}`}
        disabled={disabled}
        onClick={onClick}
        data-dialogue-focus=""
      >
        {icon}
        {children}
      </button>
    </li>
  );
}

/** 返事の選択肢。相談の進み具合から、次にしそうなことを出す。最後はいつも「その他（自由に書く）」 */
function ReplyChoices({ retry }: { retry: boolean }) {
  const t = useT();
  const actions = useActions();
  const streaming = useApp((state) => state.session.streaming);
  const stage = useApp((state) => state.session.stage);
  const hasItinerary = useApp((state) => state.itinerary.current !== null);
  const ready = useApp(shioriReady);
  const canReopenCandidates = useApp(
    (state) =>
      !state.ui.candidatesOpen &&
      state.candidates.length > 0 &&
      (state.session.stage === "candidates" || state.itinerary.current === null),
  );
  const revising = hasItinerary && (stage === "itinerary" || stage === "revising");
  // 「少し調整する」を押したら、調整の選択肢に入れ替える
  const [adjusting, setAdjusting] = useState(false);
  const other = (
    <Reply icon={<Ellipsis aria-hidden="true" className="size-5" />} onClick={focusComposer}>
      {t.dialogue.replies.other}
    </Reply>
  );
  if (revising && adjusting) {
    return (
      <ul
        aria-label={t.dialogue.replies.adjustLabel}
        className="flex flex-wrap gap-2"
        data-testid="reply-choices"
      >
        <Reply
          primary
          disabled={streaming}
          icon={<Footprints aria-hidden="true" className="size-5" />}
          onClick={() => {
            setAdjusting(false);
            void actions.send(t.dialogue.replies.slowerMessage);
          }}
        >
          {t.dialogue.replies.slower}
        </Reply>
        {other}
        <Reply
          icon={<Undo2 aria-hidden="true" className="size-5" />}
          onClick={() => setAdjusting(false)}
        >
          {t.dialogue.replies.back}
        </Reply>
      </ul>
    );
  }
  return (
    <ul
      aria-label={t.dialogue.replies.label}
      className="flex flex-wrap gap-2"
      data-testid="reply-choices"
    >
      {retry ? (
        <Reply
          primary
          disabled={streaming}
          icon={<RotateCcw aria-hidden="true" className="size-5" />}
          onClick={() => void actions.retry()}
        >
          {t.chat.retry}
        </Reply>
      ) : null}
      {ready ? (
        <Reply
          primary
          icon={<BookOpen aria-hidden="true" className="size-5" />}
          onClick={() => actions.openShiori()}
        >
          {t.itinerary.openShiori}
        </Reply>
      ) : null}
      {canReopenCandidates ? (
        <Reply
          primary
          icon={<Sparkles aria-hidden="true" className="size-5" />}
          onClick={() => actions.setCandidatesOpen(true)}
        >
          {t.candidates.reopen}
        </Reply>
      ) : null}
      {hasItinerary ? (
        <>
          <Reply
            primary={revising && !retry}
            icon={<CalendarDays aria-hidden="true" className="size-5" />}
            onClick={() => openTripPanel(actions, "itinerary")}
          >
            {t.dialogue.replies.plan}
          </Reply>
          <Reply
            icon={<MapIcon aria-hidden="true" className="size-5" />}
            onClick={() => openTripPanel(actions, "map")}
          >
            {t.dialogue.replies.map}
          </Reply>
        </>
      ) : null}
      {revising ? (
        <>
          <Reply
            disabled={streaming}
            icon={<CircleCheck aria-hidden="true" className="size-5" />}
            onClick={() => void actions.send(t.dialogue.replies.decideMessage)}
          >
            {t.dialogue.replies.decide}
          </Reply>
          <Reply
            disabled={streaming}
            icon={<SlidersHorizontal aria-hidden="true" className="size-5" />}
            onClick={() => {
              setAdjusting(true);
              window.requestAnimationFrame(focusDialogue);
            }}
          >
            {t.dialogue.replies.adjust}
          </Reply>
        </>
      ) : null}
      {stage === "hearing" || stage === "candidates" ? (
        <Reply
          disabled={streaming}
          icon={<RotateCcw aria-hidden="true" className="size-5" />}
          onClick={() => {
            actions.reopenConsult();
            window.requestAnimationFrame(focusDialogue);
          }}
        >
          {t.consult.reopen}
        </Reply>
      ) : null}
      {other}
    </ul>
  );
}

export function DialogueBox() {
  const t = useT();
  const actions = useActions();
  const locale = useApp((state) => state.ui.locale);
  const line = useApp(currentLine);
  const turn = useApp((state) => state.session.turn);
  const consultStep = useApp((state) => state.consult.step);
  const consultOpen = useApp(
    (state) =>
      state.consult.active &&
      !state.session.streaming &&
      // 片付いていないエラーがあれば、先にそれを見せる
      currentLine(state).kind !== "error",
  );
  const [expanded, setExpanded] = useState<string | null>(null);

  const speaker: StaffId = line.kind === "work" ? line.staff : "concierge";
  const name = t.staff.names[speaker];

  let text: string;
  let rest: string | null = null;
  if (consultOpen) {
    text = t.consult.prompts[consultStep];
  } else {
    switch (line.kind) {
      case "greeting":
        text = t.chat.greeting;
        break;
      case "waiting":
        // 考えている間は、短いひとことを入れ替えて出す
        text = t.dialogue.thinking2[turn % t.dialogue.thinking2.length] ?? t.dialogue.thinking;
        break;
      case "work":
        text = line.text;
        break;
      case "concierge": {
        const short = shortLine(line.text);
        text = expanded === line.id ? line.text : short.head;
        rest = short.rest;
        break;
      }
      case "error":
        text = errorText(line.entry, locale, t);
        break;
    }
  }
  const typing =
    !consultOpen && (line.kind === "waiting" || (line.kind === "concierge" && line.streaming));
  const retry =
    !consultOpen && line.kind === "error" && line.entry.retryable && !line.entry.resolved;
  const thinking = !consultOpen && (line.kind === "waiting" || line.kind === "work");

  return (
    <section
      aria-label={t.chat.title}
      className="washi relative rounded-panel border-2 border-line-strong px-4 pt-5 pb-3 shadow-lift sm:px-6"
      data-testid="dialogue"
      data-thinking={thinking}
      // 選択肢や入力欄でないところをクリックしたら、自由に書く欄へ移る（打った文字が旅人の操作に渡らない）
      onPointerUp={(event) => {
        const target = event.target as Element;
        if (target.closest("button, a, input, textarea, select, label, [role='tab']") === null) {
          focusComposer();
        }
      }}
    >
      <NamePlate name={name} />
      {/* 会話の窓をしまう（店の中を歩くとき）。コンシェルジュに話しかけると、また出る */}
      <button
        type="button"
        onClick={() => actions.setDialogue(false)}
        className="-top-3 absolute right-4 grid size-9 place-items-center rounded-full border border-line-strong bg-kinari-50 text-ink shadow-soft transition hover:bg-white"
        aria-label={t.dialogue.close}
        data-testid="dialogue-close"
      >
        <X aria-hidden="true" className="size-4" />
      </button>
      <div className="flex gap-3 sm:gap-5">
        <Portrait
          speaker={speaker as Speaker}
          className={`-mt-10 size-20 shrink-0 sm:size-32 ${thinking ? "animate-pulse" : ""}`}
        />
        <div
          className="min-h-[3.5rem] min-w-0 flex-1"
          aria-live="polite"
          aria-busy={typing}
          data-testid={line.kind === "error" && !consultOpen ? "dialogue-error" : "dialogue-line"}
        >
          {line.kind === "waiting" && !consultOpen ? (
            <p className="line-clamp-1 text-base text-ink-soft">
              <span className="sr-only">{t.chat.you}：</span>「{line.userText}」
            </p>
          ) : null}
          <p
            className={`whitespace-pre-wrap font-bold text-[1.05rem] leading-relaxed sm:text-xl ${
              line.kind === "error" && !consultOpen ? "text-shu-700" : "text-ink"
            }`}
          >
            {text}
            {typing ? (
              <span aria-hidden="true" className="ml-1 inline-block animate-pulse text-ai-600">
                ●●●
              </span>
            ) : null}
          </p>
          {rest !== null && line.kind === "concierge" ? (
            <button
              type="button"
              className="mt-0.5 font-bold text-ai-700 text-base underline underline-offset-2"
              aria-expanded={expanded === line.id}
              onClick={() => setExpanded(expanded === line.id ? null : line.id)}
            >
              {expanded === line.id ? t.dialogue.less : t.dialogue.more}
            </button>
          ) : null}
        </div>
      </div>
      <div className="mt-3">
        {consultOpen ? <ConsultPanel /> : thinking ? null : <ReplyChoices retry={retry} />}
      </div>
      <div className="mt-2 border-line border-t border-dashed pt-2">
        <Composer />
      </div>
    </section>
  );
}
