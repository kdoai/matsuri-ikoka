import { describe, expect, it } from "vitest";
import {
  appendToDraft,
  browserRecognition,
  createPushToTalk,
  type ListenFailure,
  listenFailure,
  MAX_LISTEN_MS,
  type RecognitionEventLike,
  type RecognitionLike,
  type RecognitionResultLike,
  type Timers,
  transcriptOf,
} from "./listen";

function result(transcript: string, isFinal: boolean): RecognitionResultLike {
  return { isFinal, length: 1, 0: { transcript } };
}

/** ブラウザの音声認識の代わり。作られた認識を外から動かせるようにする */
function fakeRecognition(options: { throwOnStart?: boolean } = {}) {
  const made: FakeRecognition[] = [];
  class FakeRecognition implements RecognitionLike {
    lang = "";
    continuous = false;
    interimResults = false;
    maxAlternatives = 0;
    onresult: ((event: RecognitionEventLike) => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    started = false;
    stopped = false;
    aborted = false;
    constructor() {
      made.push(this);
    }
    start() {
      if (options.throwOnStart) throw new Error("InvalidStateError");
      this.started = true;
    }
    stop() {
      this.stopped = true;
    }
    abort() {
      this.aborted = true;
    }
    hear(...results: RecognitionResultLike[]) {
      this.onresult?.({ results });
    }
    fail(error: string) {
      this.onerror?.({ error });
    }
    end() {
      this.onend?.();
    }
  }
  return { Recognition: FakeRecognition, made };
}

function recorder() {
  const heard: string[] = [];
  const done: string[] = [];
  const failed: ListenFailure[] = [];
  return {
    heard,
    done,
    failed,
    handlers: {
      onHeard: (text: string) => heard.push(text),
      onDone: (text: string) => done.push(text),
      onFail: (reason: ListenFailure) => failed.push(reason),
    },
  };
}

function fakeTimers() {
  const pending = new Map<number, { callback: () => void; ms: number }>();
  let next = 0;
  const timers: Timers = {
    set: (callback, ms) => {
      next += 1;
      pending.set(next, { callback, ms });
      return next;
    },
    clear: (handle) => pending.delete(handle as number),
  };
  return { timers, pending };
}

describe("listenFailure", () => {
  it("マイクを断られたこと・聞き取れなかったことを分ける", () => {
    expect(listenFailure("not-allowed")).toBe("denied");
    expect(listenFailure("service-not-allowed")).toBe("denied");
    expect(listenFailure("audio-capture")).toBe("noMic");
    expect(listenFailure("no-speech")).toBe("noSpeech");
    expect(listenFailure("network")).toBe("network");
    expect(listenFailure("language-not-supported")).toBe("unsupported");
    expect(listenFailure("bad-grammar")).toBe("other");
  });

  it("自分で止めたときは失敗にしない", () => {
    expect(listenFailure("aborted")).toBeNull();
  });
});

describe("transcriptOf", () => {
  it("確かな文と途中の文を分けてつなぐ", () => {
    expect(
      transcriptOf([
        result("八月の週末に", true),
        result(" 日帰りで ", false),
        result("行きたい", false),
      ]),
    ).toEqual({ final: "八月の週末に", interim: "日帰りで 行きたい" });
  });

  it("候補のない結果は飛ばす", () => {
    expect(transcriptOf([{ isFinal: true, length: 0 } as RecognitionResultLike])).toEqual({
      final: "",
      interim: "",
    });
  });
});

describe("appendToDraft", () => {
  it("下書きがなければ、聞き取った文だけを入れる", () => {
    expect(appendToDraft("", "架空の祭りに行きたい", "ja-JP")).toBe("架空の祭りに行きたい");
  });

  it("日本語は詰め、英語は空白でつなぐ", () => {
    expect(appendToDraft("八月に", "行きたい", "ja-JP")).toBe("八月に行きたい");
    expect(appendToDraft("In August", "with family", "en-US")).toBe("In August with family");
  });

  it("何も聞き取れなければ、下書きを変えない", () => {
    expect(appendToDraft("八月に", "  ", "ja-JP")).toBe("八月に");
  });
});

describe("createPushToTalk", () => {
  it("音声認識のないブラウザでは使えない（文字の相談だけにする）", () => {
    expect(createPushToTalk(null, recorder().handlers)).toBeNull();
    expect(browserRecognition()).toBeNull();
  });

  it("押している間だけ聞き、離したら聞き取った文を渡す", () => {
    const { Recognition, made } = fakeRecognition();
    const rec = recorder();
    const talk = createPushToTalk(Recognition, rec.handlers, fakeTimers().timers);
    talk?.start("ja-JP");
    const recognition = made[0];
    expect(recognition?.lang).toBe("ja-JP");
    expect(recognition?.continuous).toBe(true);
    expect(recognition?.interimResults).toBe(true);
    expect(talk?.listening).toBe(true);

    recognition?.hear(result("八月の", false));
    recognition?.hear(result("八月の週末", true), result("に", false));
    expect(rec.heard).toEqual(["八月の", "八月の週末 に"]);

    talk?.stop();
    expect(recognition?.stopped).toBe(true);
    recognition?.hear(result("八月の週末に", true));
    recognition?.end();
    expect(rec.done).toEqual(["八月の週末に"]);
    expect(rec.failed).toEqual([]);
    expect(talk?.listening).toBe(false);
  });

  it("確かにならなかった途中の文も、確かめてもらう文として渡す", () => {
    const { Recognition, made } = fakeRecognition();
    const rec = recorder();
    const talk = createPushToTalk(Recognition, rec.handlers, fakeTimers().timers);
    talk?.start("ja-JP");
    made[0]?.hear(result("提灯を見たい", false));
    talk?.stop();
    made[0]?.end();
    expect(rec.done).toEqual(["提灯を見たい"]);
  });

  it("マイクを断られたら、そのわけを伝える（文字の相談は続けられる）", () => {
    const { Recognition, made } = fakeRecognition();
    const rec = recorder();
    const talk = createPushToTalk(Recognition, rec.handlers, fakeTimers().timers);
    talk?.start("ja-JP");
    made[0]?.fail("not-allowed");
    made[0]?.end();
    expect(rec.failed).toEqual(["denied"]);
    expect(rec.done).toEqual([]);
  });

  it("何も聞き取れずに終わったら、聞き取れなかったと伝える", () => {
    const { Recognition, made } = fakeRecognition();
    const rec = recorder();
    const talk = createPushToTalk(Recognition, rec.handlers, fakeTimers().timers);
    talk?.start("en-US");
    talk?.stop();
    made[0]?.end();
    expect(rec.failed).toEqual(["noSpeech"]);
  });

  it("始められなかったら失敗として伝え、次にまた押せる", () => {
    const { Recognition } = fakeRecognition({ throwOnStart: true });
    const rec = recorder();
    const talk = createPushToTalk(Recognition, rec.handlers, fakeTimers().timers);
    talk?.start("ja-JP");
    expect(rec.failed).toEqual(["other"]);
    expect(talk?.listening).toBe(false);
  });

  it("聞いている間にもう一度押しても、二つ目は始めない", () => {
    const { Recognition, made } = fakeRecognition();
    const talk = createPushToTalk(Recognition, recorder().handlers, fakeTimers().timers);
    talk?.start("ja-JP");
    talk?.start("ja-JP");
    expect(made).toHaveLength(1);
  });

  it("画面を離れたら、聞き取った文を渡さずにやめる", () => {
    const { Recognition, made } = fakeRecognition();
    const rec = recorder();
    const talk = createPushToTalk(Recognition, rec.handlers, fakeTimers().timers);
    talk?.start("ja-JP");
    made[0]?.hear(result("途中まで", true));
    talk?.cancel();
    expect(made[0]?.aborted).toBe(true);
    made[0]?.end();
    expect(rec.done).toEqual([]);
    expect(rec.failed).toEqual([]);
    expect(talk?.listening).toBe(false);
  });

  it("押しっぱなしでも、決めた時間で聞くのをやめる", () => {
    const { Recognition, made } = fakeRecognition();
    const { timers, pending } = fakeTimers();
    const talk = createPushToTalk(Recognition, recorder().handlers, timers);
    talk?.start("ja-JP");
    const [timer] = [...pending.values()];
    expect(timer?.ms).toBe(MAX_LISTEN_MS);
    timer?.callback();
    expect(made[0]?.stopped).toBe(true);
    made[0]?.end();
    expect(pending.size).toBe(0);
  });
});
