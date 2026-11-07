import { Mic } from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useActions, useApp, useAppStore, useT } from "../state/react";
import { sharedSpeaker } from "./hooks";
import {
  appendToDraft,
  browserRecognition,
  createPushToTalk,
  type ListenFailure,
  type PushToTalk,
} from "./listen";
import { voicePrefs } from "./prefs";
import { speechLang } from "./speak";

// 押している間だけ声で話すボタン。聞き取った文は入力欄の下書きに足し、送るのは利用者が確かめてから。
// 音声認識のないブラウザでは何も出さず、文字の相談だけになる。

type Phase =
  | { kind: "idle" }
  | { kind: "notice" }
  | { kind: "ready" }
  | { kind: "listening"; heard: string }
  | { kind: "filled" }
  | { kind: "failed"; reason: ListenFailure };

const STATUS_ID = "voice-input-status";

export function VoiceInput({ onFilled }: { onFilled: () => void }) {
  const t = useT();
  const store = useAppStore();
  const actions = useActions();
  const locale = useApp((state) => state.ui.locale);
  const draft = useApp((state) => state.ui.draft);
  const Recognition = useMemo(() => browserRecognition(), []);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const talk = useRef<PushToTalk | null>(null);
  const lang = speechLang(locale);
  const langRef = useRef(lang);
  langRef.current = lang;
  const onFilledRef = useRef(onFilled);
  onFilledRef.current = onFilled;

  useEffect(() => {
    talk.current = createPushToTalk(Recognition, {
      onHeard: (heard) => setPhase({ kind: "listening", heard }),
      onDone: (heard) => {
        const current = store.getState().ui.draft;
        actions.setDraft(appendToDraft(current, heard, langRef.current));
        setPhase({ kind: "filled" });
        onFilledRef.current();
      },
      onFail: (reason) => setPhase({ kind: "failed", reason }),
    });
    return () => {
      talk.current?.cancel();
      talk.current = null;
    };
  }, [Recognition, store, actions]);

  // 送ったら（下書きが空になったら）、聞き取りの知らせを片付ける
  useEffect(() => {
    if (draft === "") setPhase((now) => (now.kind === "filled" ? { kind: "idle" } : now));
  }, [draft]);

  if (Recognition === null) return null;

  const begin = () => {
    if (!voicePrefs().get().voiceInputAccepted) {
      setPhase({ kind: "notice" });
      return;
    }
    // 自分の読み上げの声を聞き取らないよう、先に止める
    sharedSpeaker().stop();
    setPhase({ kind: "listening", heard: "" });
    talk.current?.start(lang);
  };
  const end = () => talk.current?.stop();

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    begin();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== " " && event.key !== "Enter") return;
    // 押している間のキーを、店の中の旅人の操作に渡さない
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) begin();
  };
  const onKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    end();
  };

  const listening = phase.kind === "listening";
  let status: string | null = null;
  switch (phase.kind) {
    case "listening":
      status =
        phase.heard === ""
          ? t.voice.listening
          : `${t.voice.listening} ${t.voice.heard(phase.heard)}`;
      break;
    case "ready":
      status = t.voice.accepted;
      break;
    case "filled":
      status = t.voice.filled;
      break;
    case "failed":
      status = t.voice.failed[phase.reason];
      break;
    default:
      status = null;
  }

  return (
    <>
      <button
        type="button"
        className={`grid size-10 shrink-0 touch-none select-none place-items-center rounded-full border-2 shadow-soft transition ${
          listening
            ? "animate-pulse border-shu-700 bg-shu-600 text-white motion-reduce:animate-none"
            : "border-line-strong bg-white/95 text-ink hover:border-yamabuki-400"
        }`}
        aria-label={t.voice.hold}
        title={t.voice.hold}
        aria-pressed={listening}
        aria-describedby={status === null ? undefined : STATUS_ID}
        data-testid="voice-input"
        onPointerDown={onPointerDown}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={end}
        onContextMenu={(event) => event.preventDefault()}
      >
        <Mic aria-hidden="true" className="size-5" />
      </button>
      {/* 入力欄の行の下に、説明と聞き取りのようすを出す（Composer が並べる） */}
      <VoiceStatusSlot>
        {phase.kind === "notice" ? (
          <section
            aria-labelledby="voice-notice-title"
            className="mt-2 rounded-card border-2 border-line-strong bg-kinari-50 px-3 py-2 text-ink text-sm"
            data-testid="voice-notice"
          >
            <h3 id="voice-notice-title" className="font-bold text-base">
              {t.voice.noticeTitle}
            </h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 leading-relaxed">
              {t.voice.notice.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className="min-h-10 rounded-full border-2 border-wood-700/40 bg-yamabuki-400 px-4 font-bold text-ink"
                onClick={() => {
                  voicePrefs().setVoiceInputAccepted(true);
                  setPhase({ kind: "ready" });
                }}
              >
                {t.voice.accept}
              </button>
              <button
                type="button"
                className="min-h-10 rounded-full border-2 border-line-strong bg-white px-4 font-bold text-ink"
                onClick={() => {
                  setPhase({ kind: "idle" });
                  onFilledRef.current();
                }}
              >
                {t.voice.decline}
              </button>
            </div>
          </section>
        ) : null}
        <p
          id={STATUS_ID}
          className={`text-sm ${status === null ? "" : "pt-1"} ${phase.kind === "failed" ? "font-semibold text-shu-700" : "text-ink-soft"}`}
          aria-live="polite"
          data-testid="voice-status"
        >
          {status}
        </p>
      </VoiceStatusSlot>
    </>
  );
}

/** 入力欄の行の下の置き場所。行の中のボタンと分けて、下の段に並べる */
function VoiceStatusSlot({ children }: { children: ReactNode }) {
  return <div className="order-last basis-full space-y-1">{children}</div>;
}
