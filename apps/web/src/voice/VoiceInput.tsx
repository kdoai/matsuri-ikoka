import { Mic } from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useApp, useT } from "../state/react";
import { loadVoiceInputAccepted, saveVoiceInputAccepted } from "../ui/storage";
import { setListening, sharedSpeaker } from "./hooks";
import {
  appendToDraft,
  browserRecognition,
  createPushToTalk,
  type ListenFailure,
  type PushToTalk,
} from "./listen";
import { createPressControl, type PressControl, type PressMode, type PressSource } from "./press";
import { speechLang } from "./speak";

// 声で話すボタン。長く押したときは押している間だけ聞く。短く押したとき（ダブルタップなど）や、
// click だけが届いたとき（スクリーンリーダーの決定など）は、押すと聞き始め、もう一度押すと止める（press.ts）。聞き取った文は入力欄の下書きに足し、送るのは利用者が確かめてから。
// 音声認識のないブラウザでは何も出さず、文字の相談だけになる。

type Phase =
  | { kind: "idle" }
  | { kind: "notice" }
  | { kind: "ready" }
  | { kind: "listening"; heard: string }
  | { kind: "filled" }
  | { kind: "failed"; reason: ListenFailure };

/** 説明を読んで使うと決めたか。端末に覚えられなくても、この画面の間は覚えておく */
let acceptedHere = false;

/**
 * 入力欄の横に置く。下書きはその入力欄が持つものを読み書きする（店の会話の窓はストア、ガイドの会話の窓は部品の中）
 */
export function VoiceInput({
  draft,
  onDraft,
  onFilled,
}: {
  draft: string;
  onDraft: (text: string) => void;
  onFilled: () => void;
}) {
  const t = useT();
  const statusId = useId();
  const noticeTitleId = useId();
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;
  const locale = useApp((state) => state.ui.locale);
  const Recognition = useMemo(() => browserRecognition(), []);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // 聞いているあいだの止め方（離したら止まる・もう一度押すと止まる）。表示の文を出し分ける
  const [mode, setMode] = useState<PressMode>("idle");
  const talk = useRef<PushToTalk | null>(null);
  const lang = speechLang(locale);
  const langRef = useRef(lang);
  langRef.current = lang;
  const onFilledRef = useRef(onFilled);
  onFilledRef.current = onFilled;
  const noticeTitle = useRef<HTMLHeadingElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // 押し方（長く押す・短く押す・click だけ）の扱い。キーを押している間は入力欄へ焦点を移さない
  // （入力欄に移ると、キーの繰り返しで聞き取った文が送られてしまう）
  const press = useRef<PressControl | null>(null);
  press.current ??= createPressControl({
    now: () => performance.now(),
    accepted: () => acceptedHere || loadVoiceInputAccepted(),
    showNotice: () => setPhase({ kind: "notice" }),
    start: () => talk.current?.start(langRef.current) === true,
    stop: () => talk.current?.stop(),
    listening: () => talk.current?.listening === true,
    started: () => {
      // 自分の読み上げの声を聞き取らないよう、聞き始めたら止める
      sharedSpeaker().stop();
      setListening(true);
      setPhase({ kind: "listening", heard: "" });
    },
    modeChanged: setMode,
    focusInput: () => onFilledRef.current(),
    defer: (callback) => window.setTimeout(callback, 0),
  });

  useEffect(() => {
    const ended = () => {
      setListening(false);
      press.current?.ended();
    };
    talk.current = createPushToTalk(Recognition, {
      onHeard: (heard) => setPhase({ kind: "listening", heard }),
      onDone: (heard) => {
        ended();
        onDraftRef.current(appendToDraft(draftRef.current, heard, langRef.current));
        setPhase({ kind: "filled" });
        press.current?.filled();
      },
      onFail: (reason) => {
        ended();
        setPhase({ kind: "failed", reason });
      },
    });
    // タブが隠れたら、聞いた分を渡さずにやめる
    const onHidden = () => {
      if (!document.hidden || talk.current?.listening !== true) return;
      talk.current.cancel();
      ended();
      setPhase({ kind: "idle" });
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      talk.current?.cancel();
      talk.current = null;
      setListening(false);
    };
  }, [Recognition]);

  // 送ったら（下書きが空になったら）、聞き取りの知らせを片付ける
  useEffect(() => {
    if (draft === "") setPhase((now) => (now.kind === "filled" ? { kind: "idle" } : now));
  }, [draft]);

  // 切り替えで聞いている間は、ボタンの外を押したら止める（ボタンに焦点が来ず、焦点が外れたことが届かないブラウザがある）
  useEffect(() => {
    if (mode !== "toggle") return;
    const onOutside = (event: Event) => {
      if (event.target instanceof Node && button.current?.contains(event.target)) return;
      press.current?.outside();
    };
    document.addEventListener("pointerdown", onOutside, true);
    return () => document.removeEventListener("pointerdown", onOutside, true);
  }, [mode]);

  // 説明を出したら、見出しへ焦点を移して読ませる
  useEffect(() => {
    if (phase.kind === "notice") noticeTitle.current?.focus();
  }, [phase.kind]);

  if (Recognition === null) return null;

  const isPressKey = (event: KeyboardEvent<HTMLButtonElement>) =>
    event.key === " " || event.key === "Enter";
  const sourceOf = (event: PointerEvent<HTMLButtonElement>): PressSource =>
    event.pointerType === "mouse" ? "mouse" : "touch";
  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    press.current?.down(sourceOf(event));
  };
  const onPointerUp = (event: PointerEvent<HTMLButtonElement>) =>
    press.current?.up(sourceOf(event));
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!isPressKey(event)) return;
    // 押している間のキーを、店の中の旅人の操作に渡さない
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) press.current?.down("key");
  };
  const onKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!isPressKey(event)) return;
    event.preventDefault();
    event.stopPropagation();
    press.current?.up("key");
  };

  const listening = phase.kind === "listening";
  let status: string | null = null;
  switch (phase.kind) {
    case "listening":
      {
        const now = mode === "toggle" ? t.voice.listeningToggle : t.voice.listening;
        status = phase.heard === "" ? now : `${now} ${t.voice.heard(phase.heard)}`;
      }
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
        ref={button}
        className={`grid size-10 shrink-0 touch-none select-none place-items-center rounded-full border-2 shadow-soft transition ${
          listening
            ? "animate-pulse border-shu-700 bg-shu-600 text-white motion-reduce:animate-none"
            : "border-line-strong bg-white/95 text-ink hover:border-yamabuki-400"
        }`}
        aria-label={listening ? t.voice.stop : t.voice.hold}
        title={mode === "toggle" ? t.voice.toggleTitle : t.voice.hold}
        aria-pressed={listening}
        aria-describedby={status === null ? undefined : statusId}
        data-testid="voice-input"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={onPointerUp}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        // click だけが届く操作（スクリーンリーダーの決定など）では、押すたびに聞く・止めるを切り替える
        onClick={() => press.current?.click()}
        onBlur={() => press.current?.blur()}
        onContextMenu={(event) => event.preventDefault()}
      >
        <Mic aria-hidden="true" className="size-5" />
      </button>
      {/* 入力欄の行の下に、説明と聞き取りのようすを出す（Composer が並べる） */}
      <VoiceStatusSlot>
        {phase.kind === "notice" ? (
          <section
            aria-labelledby={noticeTitleId}
            className="mt-2 rounded-card border-2 border-line-strong bg-kinari-50 px-3 py-2 text-ink text-sm"
            data-testid="voice-notice"
          >
            <h3
              id={noticeTitleId}
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
                  // 説明の欄は消えるので、焦点をマイクのボタンへ戻す
                  window.requestAnimationFrame(() => button.current?.focus());
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
          id={statusId}
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
