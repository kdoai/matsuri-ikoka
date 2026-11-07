// 押している間だけ声を聞き、文字にする。ブラウザの音声認識（SpeechRecognition）を使い、ない環境では使えないと答える。
// 認識した文はそのまま送らず、入力欄に入れて確かめてもらう。音声はこの画面でも店のサーバーでも保存しない。

/** 認識の結果のうち、使う部分だけの形 */
export interface RecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: { readonly transcript: string };
}

export interface RecognitionEventLike {
  readonly results: ArrayLike<RecognitionResultLike>;
}

/** 音声認識のうち、使う部分だけの形（テストで差し替えられるようにする） */
export interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type RecognitionConstructor = new () => RecognitionLike;

/** 声を文字にできなかったわけ。どれでも、文字の相談はそのまま続けられる */
export type ListenFailure = "denied" | "noMic" | "noSpeech" | "network" | "unsupported" | "other";

/** ブラウザの認識のエラーの名前を、画面で伝えるわけに分ける */
export function listenFailure(error: string): ListenFailure | null {
  switch (error) {
    case "aborted":
      // 自分で止めたとき
      return null;
    case "not-allowed":
    case "service-not-allowed":
      return "denied";
    case "audio-capture":
      return "noMic";
    case "no-speech":
      return "noSpeech";
    case "network":
      return "network";
    case "language-not-supported":
      return "unsupported";
    default:
      return "other";
  }
}

/** 認識の結果を、確かな文と、まだ途中の文に分けてつなぐ */
export function transcriptOf(results: ArrayLike<RecognitionResultLike>): {
  final: string;
  interim: string;
} {
  let final = "";
  let interim = "";
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    const text = result !== undefined && result.length > 0 ? (result[0]?.transcript ?? "") : "";
    if (result?.isFinal) final += text;
    else interim += text;
  }
  const tidy = (text: string) => text.replace(/\s+/g, " ").trim();
  return { final: tidy(final), interim: tidy(interim) };
}

/** 聞き取った文を下書きに足す。日本語は詰め、英語は空白でつなぐ */
export function appendToDraft(draft: string, heard: string, lang: string): string {
  const text = heard.trim();
  if (text === "") return draft;
  if (draft.trim() === "") return text;
  const glue = lang.startsWith("ja") || /\s$/.test(draft) ? "" : " ";
  return `${draft}${glue}${text}`;
}

/** 押しっぱなしのまま放っておかれても、ここで聞くのをやめる */
export const MAX_LISTEN_MS = 60_000;

export interface ListenHandlers {
  /** 聞いている間の文（確かな文＋途中の文） */
  onHeard(text: string): void;
  /** 聞き終えた。聞き取れた文（なければ失敗のほうを呼ぶ） */
  onDone(text: string): void;
  onFail(reason: ListenFailure): void;
}

export interface PushToTalk {
  /** ボタンを押したとき */
  start(lang: string): void;
  /** ボタンを離したとき。聞き取った分は onDone で渡す */
  stop(): void;
  /** 画面を離れたときなど。何も渡さずにやめる */
  cancel(): void;
  readonly listening: boolean;
}

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** 押している間だけ聞く係。認識の機能がなければ null（声の入力のボタンを出さない） */
export function createPushToTalk(
  Recognition: RecognitionConstructor | null,
  handlers: ListenHandlers,
  timers: Timers = defaultTimers,
): PushToTalk | null {
  if (Recognition === null) return null;
  let current: RecognitionLike | null = null;
  let timer: unknown = null;
  /** いま聞いているものを、何も渡さずにやめる */
  let cancelCurrent: (() => void) | null = null;

  const finish = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
    current = null;
  };

  return {
    get listening() {
      return current !== null;
    },
    start(lang) {
      if (current !== null) return;
      const recognition = new Recognition();
      recognition.lang = lang;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      let heard = { final: "", interim: "" };
      let failure: ListenFailure | null = null;
      let cancelled = false;
      recognition.onresult = (event) => {
        if (cancelled) return;
        heard = transcriptOf(event.results);
        handlers.onHeard(
          `${heard.final}${heard.final && heard.interim ? " " : ""}${heard.interim}`,
        );
      };
      recognition.onerror = (event) => {
        failure ??= listenFailure(event.error);
      };
      recognition.onend = () => {
        if (current !== recognition) return;
        finish();
        cancelCurrent = null;
        if (cancelled) return;
        // 離したあとに確かにならなかった途中の文も、確かめてもらう前提で使う
        const text = heard.final !== "" ? heard.final : heard.interim;
        if (text !== "") handlers.onDone(text);
        else handlers.onFail(failure ?? "noSpeech");
      };
      current = recognition;
      try {
        recognition.start();
      } catch {
        finish();
        handlers.onFail("other");
        return;
      }
      timer = timers.set(() => current?.stop(), MAX_LISTEN_MS);
      cancelCurrent = () => {
        cancelled = true;
        recognition.abort();
        finish();
      };
    },
    stop() {
      current?.stop();
    },
    cancel() {
      cancelCurrent?.();
      cancelCurrent = null;
    },
  };
}

/** このブラウザの音声認識。なければ null */
export function browserRecognition(): RecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const candidates = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return candidates.SpeechRecognition ?? candidates.webkitSpeechRecognition ?? null;
}
