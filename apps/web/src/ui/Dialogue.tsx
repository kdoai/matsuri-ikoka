import type { StaffId } from "@matsuri-ikoka/schema";
import { MessageCircle, X } from "lucide-react";
import { useActions, useApp, useT } from "../state/react";
import { currentLine, shioriReady } from "../state/selectors";
import { Composer, focusComposer } from "./ChatPanel";
import { Portrait, type Speaker } from "./Portraits";
import { errorText } from "./text";

// 会話の窓。店の画面の下に重ねて、話し手の顔の絵と名札、いまの一言（流れてくる返答）を大きく出し、
// その下で返事を書く。これまでのやりとりは、お知らせ（会話の記録）で開く。

function NamePlate({ name }: { name: string }) {
  return (
    <p className="-top-4 absolute left-24 flex items-center gap-1.5 rounded-full bg-ai-800 py-1 pr-4 pl-2.5 font-bold text-kinari-50 text-sm shadow-md ring-2 ring-kinari-50 sm:left-32">
      <MessageCircle aria-hidden="true" className="size-4 text-yamabuki-400" />
      {name}
    </p>
  );
}

const actionChip =
  "inline-flex min-h-9 items-center gap-1 rounded-full border-2 border-ai-700 bg-white px-3.5 font-bold text-ai-800 text-sm shadow-sm transition hover:bg-ai-50 disabled:cursor-not-allowed disabled:opacity-60";

export function DialogueBox() {
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

  const speaker: StaffId = line.kind === "work" ? line.staff : "concierge";
  const name = t.staff.names[speaker];

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
      className="relative rounded-[2rem] border-[3px] border-wood-700/70 bg-gradient-to-b from-[#fffaf0] to-[#f6ead2] px-4 pt-5 pb-3 shadow-[0_12px_32px_rgb(0_0_0/0.4)] sm:px-6"
      data-testid="dialogue"
      // 会話の窓のどこをクリックしても、入力欄に焦点を移す（打った文字が旅人の操作に渡らない）
      onPointerUp={(event) => {
        const target = event.target as Element;
        if (target.closest("button, a, input, textarea, select, [role='tab']") === null) {
          focusComposer();
        }
      }}
    >
      {/* 波の模様の飾り */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-6 bottom-1.5 h-3 bg-[radial-gradient(circle_at_50%_100%,transparent_5px,rgb(156_105_57/0.18)_6px,transparent_7px)] bg-[length:16px_12px]"
      />
      <NamePlate name={name} />
      {/* 会話の窓をしまう（店の中を歩くとき）。コンシェルジュに話しかけると、また出る */}
      <button
        type="button"
        onClick={() => actions.setDialogue(false)}
        className="-top-3 absolute right-4 grid size-9 place-items-center rounded-full border-2 border-wood-700/60 bg-kinari-50 text-ink shadow-md transition hover:bg-white"
        aria-label={t.dialogue.close}
        data-testid="dialogue-close"
      >
        <X aria-hidden="true" className="size-4" />
      </button>
      <div className="flex gap-3 sm:gap-5">
        <Portrait speaker={speaker as Speaker} className="-mt-9 size-20 sm:size-28" />
        <div
          className="min-h-[4.5rem] min-w-0 flex-1"
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
            {!typing && (line.kind === "concierge" || line.kind === "greeting") ? (
              <span
                aria-hidden="true"
                className="ml-2 inline-block animate-bounce align-middle text-ai-700 text-sm"
              >
                ▼
              </span>
            ) : null}
          </p>
          {retry || ready || canReopenCandidates ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {retry ? (
                <button
                  type="button"
                  className={actionChip}
                  disabled={streaming}
                  onClick={() => void actions.retry()}
                >
                  {t.chat.retry}
                </button>
              ) : null}
              {ready ? (
                <button
                  type="button"
                  className={`${actionChip} border-shu-600 bg-shu-600 text-white hover:bg-shu-700`}
                  onClick={() => actions.openShiori()}
                >
                  {t.itinerary.openShiori}
                </button>
              ) : null}
              {canReopenCandidates ? (
                <button
                  type="button"
                  className={actionChip}
                  onClick={() => actions.setCandidatesOpen(true)}
                >
                  {t.candidates.reopen}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className="mt-2 border-wood-300/60 border-t border-dashed pt-2">
        <Composer />
      </div>
    </section>
  );
}
