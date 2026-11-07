import { describe, expect, it } from "vitest";
import { createVoicePrefStore, type StorageLike } from "./prefs";

function memoryStorage(initial: Record<string, string> = {}): StorageLike & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

describe("createVoicePrefStore", () => {
  it("はじめは読み上げも声の入力も使わない", () => {
    expect(createVoicePrefStore(memoryStorage()).get()).toEqual({
      readAloud: false,
      voiceInputAccepted: false,
    });
  });

  it("変えた設定をこの端末で覚え、次に開いたときに戻す", () => {
    const storage = memoryStorage();
    const prefs = createVoicePrefStore(storage);
    prefs.setReadAloud(true);
    prefs.setVoiceInputAccepted(true);
    expect(createVoicePrefStore(storage).get()).toEqual({
      readAloud: true,
      voiceInputAccepted: true,
    });
  });

  it("変わったら知らせ、やめたら知らせない", () => {
    const prefs = createVoicePrefStore(memoryStorage());
    let calls = 0;
    const unsubscribe = prefs.subscribe(() => {
      calls += 1;
    });
    prefs.setReadAloud(true);
    unsubscribe();
    prefs.setReadAloud(false);
    expect(calls).toBe(1);
    expect(prefs.get().readAloud).toBe(false);
  });

  it("覚えられない環境でも、この画面の間は変えたとおりに動く", () => {
    const broken: StorageLike = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const prefs = createVoicePrefStore(broken);
    expect(prefs.get().readAloud).toBe(false);
    prefs.setReadAloud(true);
    expect(prefs.get().readAloud).toBe(true);
    expect(createVoicePrefStore(null).get().voiceInputAccepted).toBe(false);
  });
});
