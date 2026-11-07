import { useEffect, useRef, useSyncExternalStore } from "react";
import { useActions, useApp } from "../state/react";
import { createReadAloud, type SpokenLine } from "./readAloud";
import {
  browserSynth,
  createSpeaker,
  onVoicesChanged,
  type Speaker,
  speechLang,
  voiceOnDevice,
} from "./speak";

// 声の処理を、画面の部品から使うための口。

let speaker: Speaker | null = null;

/** 画面全体で1つの読み上げの係（聞き取りを始めるときに止められるように） */
export function sharedSpeaker(): Speaker {
  if (speaker === null) {
    const synth = browserSynth();
    speaker = createSpeaker(synth?.synth ?? null, synth?.makeUtterance ?? null);
  }
  return speaker;
}

/** このブラウザで読み上げを使えるか */
export function canReadAloud(): boolean {
  return browserSynth() !== null;
}

// 声の入力で聞いている間か。聞いている間は読み上げを始めない
let listening = false;
const listeners = new Set<() => void>();

export function setListening(on: boolean): void {
  if (listening === on) return;
  listening = on;
  for (const listener of listeners) listener();
}

function subscribeListening(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getListening = () => listening;

export function useListening(): boolean {
  return useSyncExternalStore(subscribeListening, getListening, getListening);
}

// 端末の外の声で読むと説明して、オンにしてもらった言語。オフにしたら消し、オンにするたびに説明する
let remoteAllowed: string | null = null;

/** 端末の外の声で読むことを、説明してから認めてもらった */
export function allowRemoteVoice(lang: string): void {
  remoteAllowed = lang;
}

export function forgetRemoteVoice(): void {
  remoteAllowed = null;
}

/** いまの声で読んでよいか。端末の外の声なら、その言語で説明してから認めてもらったときだけ */
export function voiceAllowed(onDevice: boolean, lang: string): boolean {
  return onDevice || remoteAllowed === lang;
}

/**
 * 読み上げをいったんオフにするか。オンのまま言語を変えて、使う声が端末の外のものになったときは true。
 * 言語が変わったら、前の言語で認めてもらったことを忘れる（戻っても、もう一度説明する）。
 * オフにするときも忘れる
 */
export function shouldPauseReadAloud(enabled: boolean, onDevice: boolean, lang: string): boolean {
  if (remoteAllowed !== null && remoteAllowed !== lang) remoteAllowed = null;
  if (!enabled || onDevice || remoteAllowed === lang) return false;
  remoteAllowed = null;
  return true;
}

/**
 * 読み上げのオン・オフを見張る。使う声が端末の外のものになったら、いったんオフにして、
 * 次に設定を開いたときに一度だけ知らせる（ストアの readAloudNotice）。いまの声で読んでよいかを返す
 */
export function useReadAloudGuard(): boolean {
  const enabled = useApp((state) => state.ui.readAloud);
  const lang = speechLang(useApp((state) => state.ui.locale));
  const onDevice = useVoiceOnDevice(lang);
  const actions = useActions();
  useEffect(() => {
    if (shouldPauseReadAloud(enabled, onDevice, lang)) actions.setReadAloud(false, true);
  }, [enabled, onDevice, lang, actions]);
  return voiceAllowed(onDevice, lang);
}

/**
 * 読み上げがオンのとき、会話の窓に出た文を読む。文が変わったら前の読み上げを止め、
 * 文がない間（窓を閉じたとき・考えている間など）と聞いている間は黙る。窓が消えたら止める
 */
export function useReadAloud(line: SpokenLine | null): void {
  const enabled = useApp((state) => state.ui.readAloud);
  const lang = speechLang(useApp((state) => state.ui.locale));
  const heard = useListening();
  const allowed = useReadAloudGuard();
  const controller = useRef<ReturnType<typeof createReadAloud> | null>(null);
  controller.current ??= createReadAloud(sharedSpeaker());
  const key = line?.key ?? null;
  const text = line?.text ?? "";
  useEffect(() => {
    controller.current?.update({
      enabled: enabled && allowed,
      listening: heard,
      line: key === null ? null : { key, text },
      lang,
    });
  }, [enabled, allowed, heard, key, text, lang]);
  useEffect(() => () => controller.current?.stop(), []);
}

function voicesSnapshot(lang: string): boolean {
  const synth = browserSynth();
  return synth === null ? false : voiceOnDevice(synth.synth.getVoices(), lang);
}

/** 読み上げに使う声が、この端末の中で読むものか。声の一覧が届いたら選び直す */
export function useVoiceOnDevice(lang: string): boolean {
  return useSyncExternalStore(
    onVoicesChanged,
    () => voicesSnapshot(lang),
    () => false,
  );
}
