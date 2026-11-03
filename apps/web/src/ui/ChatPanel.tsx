import { MAX_MESSAGE_LENGTH, type Preferences } from "@matsuri-ikoka/schema";
import { SendHorizontal } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef } from "react";
import { formatDate } from "../i18n";
import { useActions, useApp, useT } from "../state/react";
import { conditionChips, shioriReady } from "../state/selectors";
import type { ChatEntry } from "../state/types";
import { buttonPrimary, buttonSecondary } from "./common";
import { STAFF_LOOK } from "./StaffPanel";
import { errorText } from "./text";

// 会話欄：コンシェルジュの返答、利用者の発言、作業の記録。返答は流れてくるそばから出す。

const WORK_MARK = { running: "…", ok: "✓", failed: "!" } as const;
const WORK_STYLE = {
  running: "text-ai-700",
  ok: "text-emerald-800",
  failed: "text-shu-700",
} as const;

function Entry({ entry, isLastError }: { entry: ChatEntry; isLastError: boolean }) {
  const t = useT();
  const actions = useActions();
  const locale = useApp((state) => state.ui.locale);
  const streaming = useApp((state) => state.session.streaming);
  switch (entry.kind) {
    case "user":
      return (
        <li className="flex justify-end" data-testid="chat-user">
          <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-ai-700 px-3 py-2 font-medium text-white">
            <span className="sr-only">{t.chat.you}：</span>
            {entry.text}
          </p>
        </li>
      );
    case "concierge":
      return (
        <li className="flex items-start gap-2" data-testid="chat-concierge">
          <span
            aria-hidden="true"
            className={`mt-1 grid size-8 shrink-0 place-items-center rounded-full font-bold text-sm ring-2 ${STAFF_LOOK.concierge.badge}`}
          >
            {STAFF_LOOK.concierge.initial}
          </span>
          <p
            className="max-w-[88%] whitespace-pre-wrap rounded-2xl rounded-tl-sm border-2 border-wood-300 bg-white px-3 py-2 text-ink"
            aria-busy={entry.streaming}
          >
            <span className="sr-only">{t.chat.concierge}：</span>
            {entry.text}
            {entry.streaming ? (
              <span aria-hidden="true" className="ml-0.5 animate-pulse text-ai-600">
                ▍
              </span>
            ) : null}
          </p>
        </li>
      );
    case "work":
      return (
        <li className="flex items-start gap-2 pl-10 text-sm" data-testid="chat-work">
          <span aria-hidden="true" className={`w-3 shrink-0 font-bold ${WORK_STYLE[entry.status]}`}>
            {WORK_MARK[entry.status]}
          </span>
          <p className="text-ink-soft">
            <span className="font-bold text-ink">{t.staff.names[entry.staff]}</span>：{entry.bubble}
            {entry.result !== null && entry.result !== entry.bubble ? (
              <span className={`font-semibold ${WORK_STYLE[entry.status]}`}> → {entry.result}</span>
            ) : null}
            <span className="sr-only">（{t.chat.work[entry.status]}）</span>
          </p>
        </li>
      );
    case "preference": {
      const key = entry.key;
      const options = t.preferences[key] as Record<string, string>;
      return (
        <li className="pl-10 text-ink-soft text-sm" data-testid="chat-preference">
          {t.chat.preferenceChanged(t.preferences.labels[key], options[entry.value] ?? entry.value)}
        </li>
      );
    }
    case "error":
      return (
        <li
          className="ml-10 rounded-xl border-2 border-shu-600 bg-shu-500/10 px-3 py-2 text-sm"
          data-testid="chat-error"
          role="alert"
        >
          <p className="font-semibold text-shu-700">{errorText(entry, locale, t)}</p>
          {entry.retryable && !entry.resolved && isLastError ? (
            <button
              type="button"
              className={`${buttonSecondary} mt-2 min-h-10 py-1 text-sm`}
              disabled={streaming}
              onClick={() => void actions.retry()}
            >
              {t.chat.retry}
            </button>
          ) : null}
        </li>
      );
  }
}

export function ChatLog() {
  const t = useT();
  const actions = useActions();
  const messages = useApp((state) => state.messages);
  const streaming = useApp((state) => state.session.streaming);
  const ready = useApp(shioriReady);
  const listRef = useRef<HTMLElement>(null);
  const lastErrorId = messages.findLast((entry) => entry.kind === "error")?.id;
  const lastText = messages.at(-1);

  // 新しい発言や返答の続きが来たら、いちばん下まで送る
  // biome-ignore lint/correctness/useExhaustiveDependencies: 最後の発言が変わったときに送る
  useEffect(() => {
    const list = listRef.current;
    if (list !== null) {
      list.scrollTop = list.scrollHeight;
    }
  }, [lastText, ready, streaming]);

  return (
    <section
      ref={listRef}
      className="relative max-h-[60dvh] min-h-40 flex-1 overflow-y-auto px-1 py-2 lg:max-h-none lg:min-h-0"
      data-testid="chat-log"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: キーボードで会話をスクロールできるようにする
      tabIndex={0}
      aria-label={t.chat.title}
    >
      <ol className="space-y-2" aria-live="polite" aria-relevant="additions" aria-busy={streaming}>
        <li className="flex items-start gap-2">
          <span
            aria-hidden="true"
            className={`mt-1 grid size-8 shrink-0 place-items-center rounded-full font-bold text-sm ring-2 ${STAFF_LOOK.concierge.badge}`}
          >
            {STAFF_LOOK.concierge.initial}
          </span>
          <p className="max-w-[88%] rounded-2xl rounded-tl-sm border-2 border-wood-300 bg-white px-3 py-2 text-ink">
            {t.chat.greeting}
          </p>
        </li>
        {messages.map((entry) => (
          <Entry key={entry.id} entry={entry} isLastError={entry.id === lastErrorId} />
        ))}
        {ready ? (
          <li className="ml-10 flex flex-wrap items-center gap-2 rounded-xl border-2 border-shu-600 bg-kinari-50 px-3 py-2">
            <span className="font-bold text-shu-700">{t.chat.shioriReady}</span>
            <button type="button" className={buttonPrimary} onClick={() => actions.openShiori()}>
              {t.itinerary.openShiori}
            </button>
          </li>
        ) : null}
      </ol>
    </section>
  );
}

/** 読み取れた条件のチップ */
export function ConditionChips() {
  const t = useT();
  const locale = useApp((state) => state.ui.locale);
  const conditions = useApp((state) => state.session.conditions);
  const move = useApp((state) => state.preferences.move);
  const chips = useMemo(() => conditionChips(conditions, move), [conditions, move]);
  if (chips.length === 0) {
    return null;
  }
  const text = (key: string, value: string): string => {
    switch (key) {
      case "date": {
        const [from, to] = value.split("/");
        return to === undefined
          ? formatDate(value, locale)
          : t.conditions.range(formatDate(from ?? "", locale), formatDate(to, locale));
      }
      case "origin":
        return t.conditions.origin(value);
      case "nights":
        return t.conditions.nights(Number(value));
      case "party": {
        const [adults, children] = value.split("/").map(Number);
        return t.conditions.party(adults ?? 1, children ?? 0);
      }
      default:
        return t.conditions.move[value as Preferences["move"]];
    }
  };
  return (
    <section aria-label={t.conditions.title} data-testid="condition-chips">
      <ul className="flex flex-wrap gap-1.5">
        {chips.map((chip) => (
          <li
            key={chip.key}
            className="animate-fade rounded-full border border-ai-200 bg-ai-50 px-2.5 py-0.5 font-semibold text-ai-800 text-sm"
          >
            {text(chip.key, chip.value)}
          </li>
        ))}
      </ul>
    </section>
  );
}

const PREFERENCE_KEYS = ["party", "spot", "food", "move"] as const satisfies (keyof Preferences)[];
const PREFERENCE_OPTIONS: { [K in keyof Preferences]: readonly Preferences[K][] } = {
  party: ["adults", "kids", "seniors"],
  spot: ["classic", "auto", "hidden"],
  food: ["stalls", "local"],
  move: ["train", "car"],
};

/** 旅のこだわり（4項目）。会話欄のすぐ上の、小さな切り替え */
export function PreferenceBar() {
  const t = useT();
  const actions = useActions();
  const preferences = useApp((state) => state.preferences);
  const streaming = useApp((state) => state.session.streaming);
  const ready = useApp((state) => state.session.status === "ready");
  return (
    <section aria-label={t.preferences.title} data-testid="preference-bar">
      <h2 className="sr-only">{t.preferences.title}</h2>
      <div className="flex flex-wrap gap-x-2.5 gap-y-1">
        {PREFERENCE_KEYS.map((key) => (
          <fieldset key={key} className="flex items-center gap-1" disabled={streaming || !ready}>
            <legend className="sr-only">{t.preferences.labels[key]}</legend>
            <span aria-hidden="true" className="font-bold text-ink-soft text-xs">
              {t.preferences.labels[key]}
            </span>
            <div className="flex rounded-lg bg-kinari-200 p-0.5">
              {PREFERENCE_OPTIONS[key].map((value) => {
                const label = (t.preferences[key] as Record<string, string>)[value] ?? value;
                const checked = preferences[key] === value;
                return (
                  <label
                    key={value}
                    className={`cursor-pointer rounded-md px-1.5 py-1 font-semibold text-xs transition has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-ai-500 ${
                      checked ? "bg-ai-700 text-white shadow-sm" : "text-ink hover:bg-kinari-50"
                    } ${streaming || !ready ? "cursor-not-allowed opacity-70" : ""}`}
                  >
                    <input
                      type="radio"
                      className="sr-only"
                      name={`preference-${key}`}
                      value={value}
                      checked={checked}
                      onChange={() =>
                        void actions.setPreference(key, value as Preferences[typeof key])
                      }
                    />
                    {label}
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
    </section>
  );
}

const COMPOSER_ID = "chat-input";

/** 入力欄にフォーカスを移す（下書きを入れたあと、すぐに送れるように） */
export function focusComposer(): void {
  document.getElementById(COMPOSER_ID)?.focus();
}

/** 発言の入力欄 */
export function Composer() {
  const t = useT();
  const actions = useActions();
  const draft = useApp((state) => state.ui.draft);
  const streaming = useApp((state) => state.session.streaming);
  const status = useApp((state) => state.session.status);
  const ready = status === "ready";
  const tooLong = draft.trim().length > MAX_MESSAGE_LENGTH;
  const canSend = ready && !streaming && draft.trim().length > 0 && !tooLong;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (canSend) {
      void actions.send(draft);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 変換中の Enter では送らない
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form onSubmit={submit} className="space-y-1" data-testid="composer">
      <div className="flex items-end gap-2">
        <label className="sr-only" htmlFor={COMPOSER_ID}>
          {t.chat.label}
        </label>
        <textarea
          id={COMPOSER_ID}
          rows={1}
          value={draft}
          onChange={(event) => actions.setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t.chat.placeholder}
          disabled={!ready}
          className="field-sizing-content max-h-28 min-h-11 min-w-0 flex-1 resize-none rounded-2xl border-2 border-wood-300 bg-white/95 px-4 py-2 text-base text-ink shadow-inner placeholder:text-stone-500 focus:border-ai-500 focus:outline-none disabled:bg-kinari-200"
          aria-invalid={tooLong}
          aria-describedby={tooLong ? "chat-too-long" : undefined}
        />
        <button
          type="submit"
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border-2 border-wood-700/40 bg-yamabuki-400 px-4 font-bold text-ink shadow-[inset_0_-3px_0_rgb(0_0_0/0.15)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:border-transparent disabled:bg-stone-300 disabled:text-stone-600"
          disabled={!canSend}
          aria-label={streaming ? t.chat.waiting : t.chat.send}
        >
          <SendHorizontal aria-hidden="true" className="size-4" />
          {/* 狭い画面では、待っている間の文を短くする（読み上げは aria-label の全文） */}
          <span aria-hidden="true" className="sm:hidden">
            {streaming ? "…" : t.chat.send}
          </span>
          <span aria-hidden="true" className="hidden sm:inline">
            {streaming ? t.chat.waiting : t.chat.send}
          </span>
        </button>
      </div>
      {tooLong ? (
        <p id="chat-too-long" className="font-semibold text-shu-700 text-sm">
          {t.chat.tooLong(MAX_MESSAGE_LENGTH)}
        </p>
      ) : null}
      {status === "opening" ? <p className="text-ink-soft text-sm">{t.chat.starting}</p> : null}
    </form>
  );
}
