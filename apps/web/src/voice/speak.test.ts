import { describe, expect, it } from "vitest";
import {
  browserSynth,
  continuationText,
  createSpeaker,
  pickVoice,
  type SynthLike,
  speakableText,
  speechLang,
  type UtteranceLike,
  utteranceChunks,
  type VoiceLike,
  voiceOnDevice,
} from "./speak";

function fakeSynth(voices: VoiceLike[] = []) {
  const spoken: { text: string; lang: string; voice: VoiceLike | null }[] = [];
  let cancels = 0;
  const synth: SynthLike = {
    speak: (utterance) => spoken.push(utterance as UtteranceLike & { text: string }),
    cancel: () => {
      cancels += 1;
      spoken.length = 0;
    },
    getVoices: () => voices,
  };
  const make = (text: string) => ({ text, lang: "", voice: null, volume: 1 }) as UtteranceLike;
  return { synth, make, spoken, cancels: () => cancels };
}

describe("speechLang", () => {
  it("画面の言語に合わせた言語で読む", () => {
    expect(speechLang("ja")).toBe("ja-JP");
    expect(speechLang("en")).toBe("en-US");
  });
});

describe("speakableText", () => {
  it("URL と飾りの記号を外し、文はそのまま残す", () => {
    expect(speakableText("**架空の灯籠まつり**は https://example.com/a で確かめられます。")).toBe(
      "架空の灯籠まつり は で確かめられます。",
    );
  });

  it("矢印は区切りとして読み、余分な空白と改行を詰める", () => {
    expect(speakableText("駅 → 会場\n\n\n  夜は　提灯")).toBe("駅 、 会場\n夜は 提灯");
  });
});

describe("utteranceChunks", () => {
  it("文の区切りで分け、短い文はまとめる", () => {
    expect(utteranceChunks("見つけました。架空の祭りです！", 160)).toEqual([
      "見つけました。架空の祭りです！",
    ]);
    expect(utteranceChunks("一つ目の文です。二つ目の文です。", 9)).toEqual([
      "一つ目の文です。",
      "二つ目の文です。",
    ]);
  });

  it("長すぎる文は文字数で切る", () => {
    const chunks = utteranceChunks("あ".repeat(25), 10);
    expect(chunks).toEqual(["あ".repeat(10), "あ".repeat(10), "あ".repeat(5)]);
  });

  it("空の文は読まない", () => {
    expect(utteranceChunks("  \n\n ")).toEqual([]);
  });
});

describe("continuationText", () => {
  it("つづきを開いたら、最初の文のあとだけを読む", () => {
    expect(continuationText("一つ目。二つ目。", "一つ目。二つ目。三つ目。")).toBe("三つ目。");
  });

  it("文字数で切った文なら、全文を読み直す", () => {
    expect(continuationText("長い文…", "長い文がつづく。")).toBe("長い文がつづく。");
  });
});

describe("pickVoice", () => {
  const voices: VoiceLike[] = [
    { lang: "en-US", localService: true },
    { lang: "ja-JP", localService: false },
    { lang: "ja_JP", localService: true },
  ];

  it("言語の合う、この端末の中で読む声を先にする", () => {
    expect(pickVoice(voices, "ja-JP")).toBe(voices[2]);
  });

  it("合う声がなければブラウザに任せる", () => {
    expect(pickVoice(voices, "fr-FR")).toBeNull();
    expect(pickVoice([], "ja-JP")).toBeNull();
  });
});

describe("voiceOnDevice", () => {
  it("この端末の中の声で読めるときだけ true", () => {
    expect(voiceOnDevice([{ lang: "ja-JP", localService: true }], "ja-JP")).toBe(true);
  });

  it("端末の外の声しかないときや、声を選べずブラウザに任せるときは false", () => {
    expect(voiceOnDevice([{ lang: "ja-JP", localService: false }], "ja-JP")).toBe(false);
    expect(voiceOnDevice([], "ja-JP")).toBe(false);
  });
});

describe("createSpeaker", () => {
  it("声の一覧が届いたら、声を選び直す", () => {
    const voices: VoiceLike[] = [];
    let changed: (() => void) | null = null;
    const spoken: UtteranceLike[] = [];
    const synth: SynthLike = {
      speak: (utterance) => spoken.push(utterance),
      cancel: () => undefined,
      getVoices: () => voices,
      addEventListener: (_type, listener) => {
        changed = listener;
      },
    };
    const speaker = createSpeaker(synth, () => ({ lang: "", voice: null, volume: 1 }));
    speaker.say("一つ目。", "ja-JP");
    expect(spoken[0]?.voice).toBeNull();
    const remote = { lang: "ja-JP", localService: false };
    voices.push(remote);
    speaker.say("二つ目。", "ja-JP");
    expect(spoken[1]?.voice).toBe(remote);
    const local = { lang: "ja-JP", localService: true };
    voices.push(local);
    speaker.say("三つ目。", "ja-JP");
    // 一覧が変わったと知らされるまでは、選んだ声を使い続ける
    expect(spoken[2]?.voice).toBe(remote);
    (changed as (() => void) | null)?.();
    speaker.say("四つ目。", "ja-JP");
    expect(spoken[3]?.voice).toBe(local);
  });

  it("前の読み上げを止めてから、言語と声を付けて読む", () => {
    const voice = { lang: "ja-JP", localService: true };
    const fake = fakeSynth([voice]);
    const speaker = createSpeaker(fake.synth, fake.make);
    speaker.say("架空の夏まつりを見つけました。", "ja-JP");
    expect(fake.cancels()).toBe(1);
    expect(fake.spoken).toEqual([
      { text: "架空の夏まつりを見つけました。", lang: "ja-JP", voice, volume: 1 },
    ]);
    speaker.stop();
    expect(fake.spoken).toEqual([]);
  });

  it("読んでいないときに止めても、ブラウザの読み上げに触らない", () => {
    const fake = fakeSynth();
    const speaker = createSpeaker(fake.synth, fake.make);
    speaker.stop();
    expect(fake.cancels()).toBe(0);
    speaker.say("こんにちは", "ja-JP");
    speaker.stop();
    speaker.stop();
    expect(fake.cancels()).toBe(2);
  });

  it("出口を開けるときは、音量 0 の空の文だけを読ませる", () => {
    const fake = fakeSynth();
    createSpeaker(fake.synth, fake.make).prime();
    expect(fake.spoken).toEqual([{ text: " ", lang: "", voice: null, volume: 0 }]);
  });

  it("読み上げの機能がなければ、何もせずに壊れない", () => {
    const speaker = createSpeaker(null, null);
    expect(() => {
      speaker.say("こんにちは", "ja-JP");
      speaker.prime();
      speaker.stop();
    }).not.toThrow();
  });

  it("ブラウザの外（テストの環境）では、読み上げの機能はない", () => {
    expect(browserSynth()).toBeNull();
  });
});
