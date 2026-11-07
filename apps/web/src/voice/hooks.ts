import { useEffect, useRef, useSyncExternalStore } from "react";
import { useApp } from "../state/react";
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

/**
 * 読み上げがオンのとき、会話の窓に出た文を読む。文が変わったら前の読み上げを止め、
 * 文がない間（窓を閉じたとき・考えている間など）と聞いている間は黙る。窓が消えたら止める
 */
export function useReadAloud(line: SpokenLine | null): void {
  const enabled = useApp((state) => state.ui.readAloud);
  const lang = speechLang(useApp((state) => state.ui.locale));
  const heard = useListening();
  const controller = useRef<ReturnType<typeof createReadAloud> | null>(null);
  controller.current ??= createReadAloud(sharedSpeaker());
  const key = line?.key ?? null;
  const text = line?.text ?? "";
  useEffect(() => {
    controller.current?.update({
      enabled,
      listening: heard,
      line: key === null ? null : { key, text },
      lang,
    });
  }, [enabled, heard, key, text, lang]);
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
