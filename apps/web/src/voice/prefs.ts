// 声の設定。この端末だけで覚える（読み上げのオン・オフと、声の入力の説明を読んで使うと決めたか）。
// 読み書きできない環境（プライベートな窓など）では覚えず、毎回はじめの状態から始める。

export interface VoicePrefs {
  /** ガイドの返事を声で読み上げる */
  readAloud: boolean;
  /** 声の入力の説明を読んで、使うと決めた */
  voiceInputAccepted: boolean;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const READ_ALOUD_KEY = "matsuri-ikoka:read-aloud";
const VOICE_INPUT_KEY = "matsuri-ikoka:voice-input-accepted";

export interface VoicePrefStore {
  get(): VoicePrefs;
  setReadAloud(on: boolean): void;
  setVoiceInputAccepted(accepted: boolean): void;
  subscribe(listener: () => void): () => void;
}

export function createVoicePrefStore(storage: StorageLike | null): VoicePrefStore {
  const read = (key: string): boolean => {
    try {
      return storage?.getItem(key) === "1";
    } catch {
      return false;
    }
  };
  const write = (key: string, on: boolean) => {
    try {
      storage?.setItem(key, on ? "1" : "0");
    } catch {
      // 覚えられなくても、この画面の間は変えたとおりに動く
    }
  };
  let prefs: VoicePrefs = {
    readAloud: read(READ_ALOUD_KEY),
    voiceInputAccepted: read(VOICE_INPUT_KEY),
  };
  const listeners = new Set<() => void>();
  const update = (next: Partial<VoicePrefs>) => {
    prefs = { ...prefs, ...next };
    for (const listener of listeners) listener();
  };
  return {
    get: () => prefs,
    setReadAloud(on) {
      write(READ_ALOUD_KEY, on);
      update({ readAloud: on });
    },
    setVoiceInputAccepted(accepted) {
      write(VOICE_INPUT_KEY, accepted);
      update({ voiceInputAccepted: accepted });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

let shared: VoicePrefStore | null = null;

/** 画面全体で1つの声の設定 */
export function voicePrefs(): VoicePrefStore {
  shared ??= createVoicePrefStore(browserStorage());
  return shared;
}
