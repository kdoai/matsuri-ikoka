import type { Locale } from "../state/types";

// ガイドの返事の読み上げ。ブラウザの読み上げ（speechSynthesis）を使い、ない環境では何もしない。
// 読むのは会話の窓に出ている文だけにして、文字と声がずれないようにする。

/** 画面の言語に合わせた読み上げ・聞き取りの言語 */
export function speechLang(locale: Locale): string {
  return locale === "ja" ? "ja-JP" : "en-US";
}

/** 1回に読ませる長さの目安。長い文を一度に渡すと、途中で止まるブラウザがある */
export const UTTERANCE_CHARS = 160;

/**
 * 読み上げる文に整える。URL は読み上げても分からないので外し、飾りの記号と余分な空白を詰める。
 * 中身は画面の文のまま（言い換えない）
 */
export function speakableText(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[*#`_>|]+/g, " ")
    .replace(/[→⇒]/g, "、")
    .replace(/[ \t　]+/g, " ")
    .replace(/\s*\n+\s*/g, "\n")
    .trim();
}

/** 文の区切りで分け、長すぎる文は文字数で切る */
export function utteranceChunks(text: string, max = UTTERANCE_CHARS): string[] {
  const sentences = text.match(/[^。！？!?\n]+[。！？!?]*|\n+/g) ?? [];
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim() !== "") chunks.push(current.trim());
    current = "";
  };
  for (const sentence of sentences) {
    if (sentence.trim() === "") {
      flush();
      continue;
    }
    if (current.length + sentence.length > max) flush();
    let rest = sentence;
    while (rest.length > max) {
      chunks.push(rest.slice(0, max).trim());
      rest = rest.slice(max);
    }
    current += rest;
  }
  flush();
  return chunks.filter((chunk) => chunk !== "");
}

/** 会話の窓で「つづきを読む」を開いたときに読む部分。すでに読んだ最初の文は繰り返さない */
export function continuationText(head: string, full: string): string {
  if (!head.endsWith("…") && full.startsWith(head)) return full.slice(head.length).trim();
  return full;
}

/** 読み上げに使う部分だけの形（テストで差し替えられるようにする） */
export interface SynthLike {
  speak(utterance: UtteranceLike): void;
  cancel(): void;
  getVoices(): readonly VoiceLike[];
  /** 使える声の一覧が変わったとき（読み込みが遅れて届くブラウザがある） */
  addEventListener?(type: "voiceschanged", listener: () => void): void;
}

export interface VoiceLike {
  lang: string;
  localService: boolean;
  default?: boolean;
}

export interface UtteranceLike {
  lang: string;
  voice: VoiceLike | null;
}

export type UtteranceFactory = (text: string) => UtteranceLike;

/**
 * 言語に合う声を選ぶ。この端末の中で読む声を先にする（端末の外で読む声は、文がブラウザの提供元に送られる）。
 * 端末の中の声がなければ端末の外の声を使い、合う声がなければ null（ブラウザに任せる）
 */
export function pickVoice(voices: readonly VoiceLike[], lang: string): VoiceLike | null {
  const prefix = lang.slice(0, 2).toLowerCase();
  const matching = voices.filter((voice) =>
    voice.lang.replace("_", "-").toLowerCase().startsWith(prefix),
  );
  const exact = (voice: VoiceLike) =>
    voice.lang.replace("_", "-").toLowerCase() === lang.toLowerCase();
  return (
    matching.find((voice) => voice.localService && exact(voice)) ??
    matching.find((voice) => voice.localService) ??
    matching.find(exact) ??
    matching[0] ??
    null
  );
}

/**
 * 選ぶ声が、この端末の中で読むものか。端末の外の声や、選べずにブラウザに任せるときは false
 * （ブラウザによっては、読み上げる文を提供元のサーバーへ送って声にする）
 */
export function voiceOnDevice(voices: readonly VoiceLike[], lang: string): boolean {
  return pickVoice(voices, lang)?.localService === true;
}

export interface Speaker {
  /** 前の読み上げを止めて、この文を読む */
  say(text: string, lang: string): void;
  stop(): void;
}

/** 読み上げの係。読み上げの機能がなければ、何もしない係を返す */
export function createSpeaker(
  synth: SynthLike | null,
  makeUtterance: UtteranceFactory | null,
): Speaker {
  if (synth === null || makeUtterance === null) {
    return { say: () => undefined, stop: () => undefined };
  }
  let spoke = false;
  // 言語ごとに選んだ声。声の一覧が変わったら選び直す
  const chosen = new Map<string, VoiceLike | null>();
  synth.addEventListener?.("voiceschanged", () => chosen.clear());
  const voiceFor = (lang: string): VoiceLike | null => {
    const known = chosen.get(lang);
    if (known !== undefined) return known;
    const voices = synth.getVoices();
    const voice = pickVoice(voices, lang);
    // 一覧がまだ届いていないときは覚えず、次にまた選ぶ
    if (voices.length > 0) chosen.set(lang, voice);
    return voice;
  };
  return {
    say(text, lang) {
      synth.cancel();
      spoke = true;
      const voice = voiceFor(lang);
      for (const chunk of utteranceChunks(speakableText(text))) {
        const utterance = makeUtterance(chunk);
        utterance.lang = lang;
        utterance.voice = voice;
        synth.speak(utterance);
      }
    },
    stop() {
      // 読んでいないときは、ブラウザの読み上げに触らない（ほかの音のじゃまをしない）
      if (!spoke) return;
      spoke = false;
      synth.cancel();
    },
  };
}

/** 声の一覧が変わったら知らせる。読み上げの機能がなければ何もしない */
export function onVoicesChanged(listener: () => void): () => void {
  const synth = typeof window === "undefined" ? undefined : window.speechSynthesis;
  // 声の一覧の知らせを持たない古いブラウザでは、選び直さない
  if (synth === undefined || typeof synth.addEventListener !== "function") {
    return () => undefined;
  }
  synth.addEventListener("voiceschanged", listener);
  return () => synth.removeEventListener("voiceschanged", listener);
}

/** このブラウザの読み上げの機能。なければ null */
export function browserSynth(): { synth: SynthLike; makeUtterance: UtteranceFactory } | null {
  if (typeof window === "undefined") return null;
  const synth = window.speechSynthesis;
  const Utterance = window.SpeechSynthesisUtterance;
  if (synth === undefined || typeof Utterance !== "function") return null;
  return {
    synth: synth as unknown as SynthLike,
    makeUtterance: (text) => new Utterance(text) as unknown as UtteranceLike,
  };
}
