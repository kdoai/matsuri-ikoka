import { MAX_MESSAGE_LENGTH, noticeStall } from "@matsuri-ikoka/schema";
import {
  Clock,
  Flag,
  MessageCircle,
  MessageCircleQuestion,
  Phone,
  RotateCcw,
  Send,
  X,
} from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { formatDateTime } from "../i18n";
import { currentEmergency, type GuideEntry, guideLine } from "../state/guide";
import { useActions, useApp, useT } from "../state/react";
import { SourceLink } from "./common";
import { Portrait } from "./Portraits";
import { errorText, shortLine } from "./text";

// ガイドとの会話の窓。店の会話の窓と同じ、話し手の名札と顔の絵つきのセリフの枠。
// ガイドは店のコンシェルジュと同じひよこなので、同じ顔の絵を使う。チャット欄にせず、いまのひとことだけを出す。
// これまでの話は「これまでの話」で開ける。緊急の連絡先は、ガイドの文より先に、いちばん上に出す。

const replyClass =
  "inline-flex min-h-12 items-center justify-center gap-1.5 rounded-2xl border-2 px-3 py-2 font-bold leading-tight shadow-soft transition hover:-translate-y-0.5 motion-reduce:hover:translate-y-0 disabled:cursor-not-allowed disabled:opacity-60";
const REPLY_TONE = {
  plain: "border-line-strong bg-white/90 text-ink hover:border-yamabuki-400",
  primary: "border-wood-700/40 bg-yamabuki-400 text-ink hover:brightness-105",
} as const;

/** 最後の発言のあとに届いた記録（手帳に残したこと・出典） */
function latestEntries(entries: readonly GuideEntry[]): GuideEntry[] {
  const last = entries.findLastIndex((entry) => entry.kind === "user");
  return entries.slice(last + 1);
}

function HistoryEntry({ entry }: { entry: GuideEntry }) {
  const t = useT();
  const locale = useApp((state) => state.ui.locale);
  switch (entry.kind) {
    case "user":
      return (
        <p>
          <span className="font-bold">{t.street.you}：</span>
          {entry.text}
        </p>
      );
    case "guide":
      return (
        <p className="whitespace-pre-wrap">
          <span className="font-bold">{t.street.guideName}：</span>
          {entry.text}
        </p>
      );
    case "tool":
      return <p className="text-ink-soft">{entry.bubble}</p>;
    case "memo":
      return <p className="text-ink-soft">{t.street.memoSaved(entry.text)}</p>;
    case "emergency":
      return (
        <p className="font-bold text-shu-700">
          {entry.contacts
            .map((contact) => `${t.street.emergency[contact.service]} ${contact.number}`)
            .join("・")}
        </p>
      );
    case "sources":
      return (
        <div>
          <p className="text-ink-soft">
            {t.street.sourcesChecked(formatDateTime(entry.checkedAt, locale))}
          </p>
          {entry.sources.map((source) => (
            <SourceLink key={source.url} source={source} />
          ))}
        </div>
      );
    case "error":
      return <p className="text-shu-700">{errorText(entry, locale, t)}</p>;
  }
}

function Composer() {
  const t = useT();
  const actions = useActions();
  const streaming = useApp((state) => state.guide.streaming);
  const [draft, setDraft] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (text === "" || streaming) return;
    setDraft("");
    void actions.sendGuide(text);
  };
  return (
    <form className="flex items-center gap-2" onSubmit={submit} data-testid="guide-composer">
      <input
        type="text"
        value={draft}
        maxLength={MAX_MESSAGE_LENGTH}
        onChange={(event) => setDraft(event.target.value)}
        aria-label={t.street.composerLabel}
        placeholder={t.street.composerPlaceholder}
        data-guide-focus=""
        className="min-h-11 min-w-0 flex-1 rounded-xl border-2 border-line-strong bg-white px-3 py-1.5 text-ink"
      />
      <button
        type="submit"
        disabled={streaming || draft.trim() === ""}
        aria-label={streaming ? t.street.waiting : t.street.send}
        className="grid size-11 shrink-0 place-items-center rounded-xl bg-ai-700 text-white shadow-sm transition hover:bg-ai-800 disabled:cursor-not-allowed disabled:bg-stone-400"
      >
        {streaming ? (
          <Clock aria-hidden="true" className="size-5" />
        ) : (
          <Send aria-hidden="true" className="size-5" />
        )}
      </button>
    </form>
  );
}

/** 会話の窓の中で、最初に焦点を置く場所へ移る */
export function focusGuideDialogue(): void {
  document.querySelector<HTMLElement>("[data-testid='guide-dialogue'] [data-guide-focus]")?.focus();
}

export function GuideDialogue({ walk }: { walk: boolean }) {
  const t = useT();
  const actions = useActions();
  const locale = useApp((state) => state.ui.locale);
  const guide = useApp((state) => state.guide);
  const line = useMemo(() => guideLine(guide), [guide]);
  const emergency = useMemo(() => currentEmergency(guide), [guide]);
  const latest = useMemo(() => latestEntries(guide.entries), [guide.entries]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const canTalk = guide.availability === "ready";

  let text: string;
  let rest: string | null = null;
  switch (line.kind) {
    case "report":
      text = line.notice.summary;
      break;
    case "waiting":
      text = t.street.thinking;
      break;
    case "tool":
      text = line.bubble;
      break;
    case "guide": {
      const short = shortLine(line.text);
      text = expanded === line.id ? line.text : short.head;
      rest = short.rest;
      break;
    }
    case "error":
      text = errorText(line, locale, t);
      break;
    case "unavailable":
      text = t.street.unavailable;
      break;
    case "greeting":
      text =
        guide.availability === "failed"
          ? t.street.failed
          : guide.availability === "unavailable"
            ? t.street.unavailable
            : t.street.greeting;
      break;
  }
  const typing =
    line.kind === "waiting" || line.kind === "tool" || (line.kind === "guide" && line.streaming);

  return (
    <section
      aria-label={t.street.guideName}
      className="washi relative flex max-h-[calc(100dvh-var(--frame-top,0px)-2.5rem)] flex-col rounded-panel border-2 border-line-strong px-4 pt-5 pb-3 shadow-lift sm:px-6"
      data-testid="guide-dialogue"
    >
      <p className="-top-4 absolute left-24 flex items-center gap-1.5 rounded-full border border-kinari-50/70 bg-ai-800 py-1 pr-4 pl-2.5 font-bold text-base text-kinari-50 shadow-soft sm:left-36">
        <MessageCircle aria-hidden="true" className="size-4 text-yamabuki-400" />
        {/* 狭い画面では、閉じるボタンに重ならないよう短くする（読み上げは窓の名前で全文を伝える） */}
        <span aria-hidden="true" className="sm:hidden">
          {t.street.marker}
        </span>
        <span className="max-sm:sr-only">{t.street.guideName}</span>
      </p>
      <button
        type="button"
        onClick={() => actions.setGuideDialogue(false)}
        aria-label={t.street.close}
        data-testid="guide-dialogue-close"
        className="-top-3 absolute right-4 grid size-9 place-items-center rounded-full border border-line-strong bg-kinari-50 text-ink shadow-soft transition hover:bg-white"
      >
        <X aria-hidden="true" className="size-4" />
      </button>
      {/* 緊急の連絡先は、ガイドの文より先に出す */}
      {emergency.length > 0 ? (
        <div
          role="alert"
          data-testid="guide-emergency"
          className="mb-2 rounded-xl border-2 border-shu-600 bg-white px-3 py-2"
        >
          <p className="font-bold text-shu-700">{t.street.emergencyLead}</p>
          <ul className="mt-1 flex flex-wrap gap-2">
            {emergency.map((contact) => (
              <li key={contact.service}>
                <a
                  href={`tel:${contact.number}`}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-shu-600 px-3 font-bold text-white"
                >
                  <Phone aria-hidden="true" className="size-4" />
                  {t.street.emergency[contact.service]} {contact.number}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex min-h-0 gap-3 sm:gap-5">
        <Portrait
          speaker="concierge"
          className={`-mt-8 size-14 shrink-0 sm:size-20 ${typing ? "animate-pulse" : ""}`}
        />
        <div
          className="max-h-[min(38dvh,18rem)] min-h-[3.5rem] min-w-0 flex-1 overflow-y-auto overscroll-contain pr-1"
          aria-live="polite"
          aria-busy={typing}
          data-testid="guide-line"
          data-line={line.kind}
        >
          <p
            className={`whitespace-pre-wrap font-bold text-[1.05rem] leading-relaxed sm:text-xl ${
              line.kind === "error" ? "text-shu-700" : "text-ink"
            }`}
          >
            {text}
            {typing ? (
              <span aria-hidden="true" className="ml-1 inline-block animate-pulse text-ai-600">
                ●●●
              </span>
            ) : null}
          </p>
          {line.kind === "report" ? (
            <div className="mt-1 space-y-0.5">
              <p className="text-ink-soft text-sm">
                {t.street.noticeChecked(formatDateTime(line.notice.checkedAt, locale))}
              </p>
              {line.notice.sources.map((source) => (
                <SourceLink key={source.url} source={source} />
              ))}
            </div>
          ) : null}
          {rest !== null && line.kind === "guide" ? (
            <button
              type="button"
              className="mt-0.5 font-bold text-ai-700 text-base underline underline-offset-2"
              aria-expanded={expanded === line.id}
              onClick={() => setExpanded(expanded === line.id ? null : line.id)}
            >
              {expanded === line.id ? t.dialogue.less : t.dialogue.more}
            </button>
          ) : null}
          {/* 返答に添えた出典と、手帳に残したこと */}
          {line.kind === "report"
            ? null
            : latest.map((entry) =>
                entry.kind === "memo" || entry.kind === "sources" ? (
                  <div key={entry.id} className="mt-1 text-sm" data-testid={`guide-${entry.kind}`}>
                    <HistoryEntry entry={entry} />
                  </div>
                ) : null,
              )}
        </div>
      </div>
      <div className="mt-3 min-h-0 overflow-y-auto">
        <ul className="flex flex-wrap gap-2" aria-label={t.street.suggestionsLabel}>
          {line.kind === "report" ? (
            <>
              <li>
                <button
                  type="button"
                  data-guide-focus=""
                  data-testid="guide-lead"
                  className={`${replyClass} ${REPLY_TONE.primary}`}
                  onClick={() => actions.leadToStall(noticeStall(line.notice.content), walk)}
                >
                  <Flag aria-hidden="true" className="size-5" />
                  {t.street.leadMe}
                </button>
              </li>
              <li>
                <button
                  type="button"
                  className={`${replyClass} ${REPLY_TONE.plain}`}
                  onClick={actions.dismissReport}
                >
                  {t.street.later}
                </button>
              </li>
            </>
          ) : null}
          {line.kind === "error" && line.retryable && canTalk ? (
            <li>
              <button
                type="button"
                data-guide-focus=""
                className={`${replyClass} ${REPLY_TONE.primary}`}
                disabled={guide.streaming}
                onClick={() => void actions.retryGuide()}
              >
                <RotateCcw aria-hidden="true" className="size-5" />
                {t.street.retry}
              </button>
            </li>
          ) : null}
          {guide.availability === "failed" ? (
            <li>
              <button
                type="button"
                data-guide-focus=""
                className={`${replyClass} ${REPLY_TONE.primary}`}
                onClick={() => void actions.loadGuide(true)}
              >
                <RotateCcw aria-hidden="true" className="size-5" />
                {t.street.loadAgain}
              </button>
            </li>
          ) : null}
          {canTalk && line.kind !== "report"
            ? t.street.suggestions.map((suggestion) => (
                <li key={suggestion.label}>
                  <button
                    type="button"
                    className={`${replyClass} ${REPLY_TONE.plain}`}
                    disabled={guide.streaming}
                    onClick={() => void actions.sendGuide(suggestion.message)}
                  >
                    <MessageCircleQuestion aria-hidden="true" className="size-5" />
                    {suggestion.label}
                  </button>
                </li>
              ))
            : null}
        </ul>
        {guide.entries.length > 0 ? (
          <details className="mt-2 text-sm" data-testid="guide-history">
            <summary className="cursor-pointer font-bold text-ai-800">{t.street.history}</summary>
            <ol className="mt-1 max-h-48 space-y-1 overflow-y-auto">
              {guide.entries.map((entry) => (
                <li key={entry.id}>
                  <HistoryEntry entry={entry} />
                </li>
              ))}
            </ol>
          </details>
        ) : null}
      </div>
      {canTalk ? (
        <div className="mt-2 shrink-0 border-line border-t border-dashed pt-2">
          <Composer />
        </div>
      ) : null}
    </section>
  );
}
