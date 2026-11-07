import { useEffect, useSyncExternalStore } from "react";
import { useApp } from "../state/react";
import { type VoicePrefs, voicePrefs } from "./prefs";
import { browserSynth, createSpeaker, type Speaker, speechLang } from "./speak";

// 声の設定と読み上げを、画面の部品から使うための口。

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

export function useVoicePrefs(): VoicePrefs {
  const store = voicePrefs();
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** 会話の窓で、いま読み上げる文。key が変わったときだけ読み直す */
export interface SpokenLine {
  key: string;
  text: string;
}

/**
 * 読み上げがオンのとき、会話の窓に出た文を読む。文が変わったら前の読み上げを止め、
 * 文がない間（考えている間など）は黙る。窓が消えたら止める
 */
export function useReadAloud(line: SpokenLine | null): void {
  const { readAloud } = useVoicePrefs();
  const locale = useApp((state) => state.ui.locale);
  const key = line?.key ?? null;
  const text = line?.text ?? "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: 同じ文（key）を、描き直しのたびに読み直さない
  useEffect(() => {
    if (!readAloud) {
      sharedSpeaker().stop();
      return;
    }
    if (key === null || text.trim() === "") {
      sharedSpeaker().stop();
      return;
    }
    sharedSpeaker().say(text, speechLang(locale));
  }, [readAloud, key, locale]);
  useEffect(() => () => sharedSpeaker().stop(), []);
}
