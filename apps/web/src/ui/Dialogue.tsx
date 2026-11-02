import type { StaffId } from "@matsuri-ikoka/schema";
import { useState } from "react";
import { useActions, useApp, useT } from "../state/react";
import { currentLine, shioriReady } from "../state/selectors";
import { Composer, ConditionChips, PreferenceBar } from "./ChatPanel";
import { buttonPrimary, buttonSecondary } from "./common";
import { STAFF_LOOK } from "./StaffPanel";
import { errorText } from "./text";

// 会話の窓。店の画面の下に重ねて、話し手の名札と、いまの一言（流れてくる返答）を大きく出し、
// その場で返事を書く。これまでのやりとりは「会話の記録」で開く。

function NamePlate({ staff, name }: { staff: StaffId | null; name: string }) {
  const look = staff === null ? null : STAFF_LOOK[staff];
  return (
    <p className="-top-4 absolute left-5 flex items-center gap-1.5 rounded-full bg-ai-700 py-1 pr-4 pl-1.5 font-bold text-sm text-white shadow-md ring-2 ring-kinari-50">
      {look === null ? null : (
        <span
          aria-hidden="true"
          className={`grid size-7 place-items-center rounded-full font-bold text-xs ring-2 ${look.badge}`}
        >
          {look.initial}
        </span>
      )}
      {name}
    </p>
  );
}

export function DialogueBox({ onOpenLog }: { onOpenLog: () => void }) {
  const t = useT();
  const actions = useActions();
  const locale = useApp((state) => state.ui.locale);
  const line = useApp(currentLine);
  const streaming = useApp((state) => state.session.streaming);
  const ready = useApp(shioriReady);
  const canReopenCandidates = useApp(
    (state) =>
      !state.ui.candidatesOpen &&
      state.candidates.length > 0 &&
      (state.session.stage === "candidates" || state.itinerary.current === null),
  );
  const [showPreferences, setShowPreferences] = useState(false);

  const speaker: { staff: StaffId | null; name: string } =
    line.kind === "work"
      ? { staff: line.staff, name: t.staff.names[line.staff] }
      : { staff: "concierge", name: t.chat.concierge };

  let text: string;
  switch (line.kind) {
    case "greeting":
      text = t.chat.greeting;
      break;
    case "waiting":
      text = t.dialogue.thinking;
      break;
    case "work":
    case "concierge":
      text = line.text;
      break;
    case "error":
      text = errorText(line.entry, locale, t);
      break;
  }
  const typing = line.kind === "waiting" || (line.kind === "concierge" && line.streaming);
  const retry = line.kind === "error" && line.entry.retryable && !line.entry.resolved;

  return (
    <section
      aria-label={t.chat.title}
      className="relative rounded-[1.75rem] border-4 border-wood-700 bg-kinari-50/97 px-4 pt-6 pb-3 shadow-[0_10px_30px_rgb(0_0_0/0.35)] sm:px-6"
      data-testid="dialogue"
    >
      <NamePlate staff={speaker.staff} name={speaker.name} />
      <div
        className="min-h-[4.5rem]"
        aria-live="polite"
        aria-busy={typing}
        data-testid={line.kind === "error" ? "dialogue-error" : "dialogue-line"}
      >
        {line.kind === "waiting" ? (
          <p className="text-ink-soft text-sm">
            <span className="sr-only">{t.chat.you}：</span>「{line.userText}」
          </p>
        ) : null}
        <p
          className={`whitespace-pre-wrap font-medium text-lg leading-relaxed sm:text-xl ${
            line.kind === "error" ? "text-shu-700" : "text-ink"
          }`}
        >
          {text}
          {typing ? (
            <span aria-hidden="true" className="ml-1 inline-block animate-pulse text-ai-600">
              ●●●
            </span>
          ) : line.kind === "concierge" || line.kind === "greeting" ? (
            <span aria-hidden="true" className="ml-1 inline-block animate-bounce text-ai-600">
              ▼
            </span>
          ) : null}
        </p>
        {retry || ready || canReopenCandidates ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {retry ? (
              <button
                type="button"
                className={buttonSecondary}
                disabled={streaming}
                onClick={() => void actions.retry()}
              >
                {t.chat.retry}
              </button>
            ) : null}
            {ready ? (
              <button type="button" className={buttonPrimary} onClick={() => actions.openShiori()}>
                {t.itinerary.openShiori}
              </button>
            ) : null}
            {canReopenCandidates ? (
              <button
                type="button"
                className={buttonSecondary}
                onClick={() => actions.setCandidatesOpen(true)}
              >
                {t.candidates.reopen}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="mt-2 space-y-2 border-wood-300/70 border-t pt-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <ConditionChips />
          </div>
          <button
            type="button"
            className="min-h-9 rounded-full border border-ai-200 bg-white px-3 font-semibold text-ai-800 text-xs lg:hidden"
            aria-expanded={showPreferences}
            aria-controls="dialogue-preferences"
            onClick={() => setShowPreferences((open) => !open)}
          >
            {t.preferences.title}
          </button>
          <button
            type="button"
            className="min-h-9 rounded-full border border-ai-200 bg-white px-3 font-semibold text-ai-800 text-xs"
            onClick={onOpenLog}
          >
            {t.dialogue.openLog}
          </button>
        </div>
        <div id="dialogue-preferences" className={showPreferences ? "" : "hidden lg:block"}>
          <PreferenceBar />
        </div>
        <Composer />
      </div>
    </section>
  );
}
