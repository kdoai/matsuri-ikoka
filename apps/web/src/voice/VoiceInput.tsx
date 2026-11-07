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
import { loadVoiceInputAccepted, saveVoiceInputAccepted } from "../ui/storage";
import { setListening, sharedSpeaker } from "./hooks";
import {
  appendToDraft,
  browserRecognition,
  createPushToTalk,
  type ListenFailure,
  type PushToTalk,
} from "./listen";
import { speechLang } from "./speak";

// 声で話すボタン。押している間だけ聞く。スクリーンリーダーなどで押した（click だけが届いた）ときは、
// 押すと聞き始め、もう一度押すと止める。聞き取った文は入力欄の下書きに足し、送るのは利用者が確かめてから。
// 音声認識のないブラウザでは何も出さず、文字の相談だけになる。

type Phase =
  | { kind: "idle" }
  | { kind: "notice" }
  | { kind: "ready" }
  | { kind: "listening"; heard: string }
  | { kind: "filled" }
  | { kind: "failed"; reason: ListenFailure };

const STATUS_ID = "voice-input-status";
const NOTICE_TITLE_ID = "voice-notice-title";

/** 説明を読んで使うと決めたか。端末に覚えられなくても、この画面の間は覚えておく */
let acceptedHere = false;

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
  // キーを押している間は焦点を移さない（入力欄に移ると、キーの繰り返しで聞き取った文が送られてしまう）
  const keyHeld = useRef(false);
  const focusAfterKey = useRef(false);
  // 押して離す操作で始めたあとに届く click を、もう一度の押し直しと取り違えない
  const pressed = useRef(false);
  const noticeTitle = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const fill = () => {
      if (keyHeld.current) focusAfterKey.current = true;
      else onFilledRef.current();
    };
    talk.current = createPushToTalk(Recognition, {
      onHeard: (heard) => setPhase({ kind: "listening", heard }),
      onDone: (heard) => {
        setListening(false);
        const current = store.getState().ui.draft;
        actions.setDraft(appendToDraft(current, heard, langRef.current));
        setPhase({ kind: "filled" });
        fill();
      },
      onFail: (reason) => {
        setListening(false);
        setPhase({ kind: "failed", reason });
      },
    });
    // タブが隠れたら、聞いた分を渡さずにやめる
    const onHidden = () => {
      if (!document.hidden || talk.current?.listening !== true) return;
      talk.current.cancel();
      setListening(false);
      setPhase({ kind: "idle" });
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      talk.current?.cancel();
      talk.current = null;
      setListening(false);
    };
  }, [Recognition, store, actions]);

  // 送ったら（下書きが空になったら）、聞き取りの知らせを片付ける
  useEffect(() => {
    if (draft === "") setPhase((now) => (now.kind === "filled" ? { kind: "idle" } : now));
  }, [draft]);

  // 説明を出したら、見出しへ焦点を移して読ませる
  useEffect(() => {
    if (phase.kind === "notice") noticeTitle.current?.focus();
  }, [phase.kind]);

  if (Recognition === null) return null;

  const begin = () => {
    if (!acceptedHere && !loadVoiceInputAccepted()) {
      setPhase({ kind: "notice" });
      return;
    }
    // 自分の読み上げの声を聞き取らないよう、先に止める
    sharedSpeaker().stop();
    if (talk.current?.start(lang) !== true) return;
    setListening(true);
    setPhase({ kind: "listening", heard: "" });
  };
  const end = () => talk.current?.stop();
  const released = () => {
    window.setTimeout(() => {
      pressed.current = false;
    }, 0);
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pressed.current = true;
    begin();
  };
  const onPointerUp = () => {
    end();
    released();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== " " && event.key !== "Enter") return;
    // 押している間のキーを、店の中の旅人の操作に渡さない
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    keyHeld.current = true;
    pressed.current = true;
    begin();
  };
  const onKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    keyHeld.current = false;
    end();
    released();
    if (focusAfterKey.current) {
      focusAfterKey.current = false;
      onFilledRef.current();
    }
  };
  // click だけが届く操作（スクリーンリーダーの決定・ダブルタップ）では、押すたびに聞く・止めるを切り替える
  const onClick = () => {
    if (pressed.current) return;
    if (talk.current?.listening === true) end();
    else begin();
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
        aria-label={listening ? t.voice.stop : t.voice.hold}
        title={t.voice.hold}
        aria-pressed={listening}
        aria-describedby={status === null ? undefined : STATUS_ID}
        data-testid="voice-input"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={() => {
          if (pressed.current) onPointerUp();
        }}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onClick={onClick}
        onBlur={end}
        onContextMenu={(event) => event.preventDefault()}
      >
        <Mic aria-hidden="true" className="size-5" />
      </button>
      {/* 入力欄の行の下に、説明と聞き取りのようすを出す（Composer が並べる） */}
      <VoiceStatusSlot>
        {phase.kind === "notice" ? (
          <section
            aria-labelledby={NOTICE_TITLE_ID}
            className="mt-2 rounded-card border-2 border-line-strong bg-kinari-50 px-3 py-2 text-ink text-sm"
            data-testid="voice-notice"
          >
            <h3
              id={NOTICE_TITLE_ID}
              ref={noticeTitle}
              tabIndex={-1}
              className="font-bold text-base focus:outline-none"
            >
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
                  acceptedHere = true;
                  saveVoiceInputAccepted();
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
