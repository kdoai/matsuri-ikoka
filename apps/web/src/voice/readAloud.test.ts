import { describe, expect, it } from "vitest";
import type { DialogueLine } from "../state/selectors";
import { createReadAloud, dialogueSpokenLine, type ReadAloudState } from "./readAloud";
import type { Speaker } from "./speak";

const reply: DialogueLine = {
  kind: "concierge",
  id: "m1",
  text: "架空の灯籠まつりを見つけました。川に灯籠が浮かびます。くわしくはしおりで。",
  streaming: false,
};

const base = {
  open: true,
  consult: null,
  line: reply,
  head: "架空の灯籠まつりを見つけました。川に灯籠が浮かびます。",
  expanded: false,
  text: "",
};

describe("dialogueSpokenLine", () => {
  it("窓に出ているセリフの頭を読む", () => {
    expect(dialogueSpokenLine(base)).toEqual({ key: "m1:head", text: base.head });
  });

  it("窓を閉じている間は読まない", () => {
    expect(dialogueSpokenLine({ ...base, open: false })).toBeNull();
    expect(dialogueSpokenLine({ ...base, open: false, consult: "だれと行きますか？" })).toBeNull();
  });

  it("「つづきを読む」では、続きの部分だけを読む", () => {
    expect(dialogueSpokenLine({ ...base, expanded: true })).toEqual({
      key: "m1:rest",
      text: "くわしくはしおりで。",
    });
  });

  it("流れてくる途中の返事、考えている間、作業の様子は読まない", () => {
    expect(dialogueSpokenLine({ ...base, line: { ...reply, streaming: true } })).toBeNull();
    expect(
      dialogueSpokenLine({ ...base, line: { kind: "waiting", userText: "八月に" } }),
    ).toBeNull();
    expect(
      dialogueSpokenLine({
        ...base,
        line: { kind: "work", staff: "researcher", text: "調べています" },
      }),
    ).toBeNull();
  });

  it("選んで進める相談の問い、あいさつ、エラーの文は窓の文のまま読む", () => {
    expect(dialogueSpokenLine({ ...base, consult: "だれと行きますか？" })).toEqual({
      key: "consult:だれと行きますか？",
      text: "だれと行きますか？",
    });
    expect(
      dialogueSpokenLine({ ...base, line: { kind: "greeting" }, text: "いらっしゃいませ" }),
    ).toEqual({ key: "greeting", text: "いらっしゃいませ" });
  });
});

function fakeSpeaker() {
  const calls: string[] = [];
  const speaker: Speaker = {
    say: (text, lang) => calls.push(`say:${lang}:${text}`),
    stop: () => calls.push("stop"),
    prime: () => calls.push("prime"),
  };
  return { speaker, calls };
}

const on: ReadAloudState = {
  enabled: true,
  listening: false,
  line: { key: "m1:head", text: "見つけました。" },
  lang: "ja-JP",
};

describe("createReadAloud", () => {
  it("オンのときに文が出たら読み、同じ文は読み直さない", () => {
    const { speaker, calls } = fakeSpeaker();
    const read = createReadAloud(speaker);
    read.update(on);
    read.update(on);
    expect(calls).toEqual(["say:ja-JP:見つけました。"]);
  });

  it("オフのときは読まない", () => {
    const { speaker, calls } = fakeSpeaker();
    createReadAloud(speaker).update({ ...on, enabled: false });
    expect(calls).toEqual(["stop"]);
  });

  it("窓を閉じたら（読む文がなくなったら）止め、開き直したらまた読む", () => {
    const { speaker, calls } = fakeSpeaker();
    const read = createReadAloud(speaker);
    read.update(on);
    read.update({ ...on, line: null });
    read.update(on);
    expect(calls).toEqual(["say:ja-JP:見つけました。", "stop", "say:ja-JP:見つけました。"]);
  });

  it("聞いている間は黙り、その間に届いた文は聞き終えてから読む", () => {
    const { speaker, calls } = fakeSpeaker();
    const read = createReadAloud(speaker);
    read.update(on);
    read.update({ ...on, listening: true });
    read.update({ ...on, listening: true, line: { key: "m2:head", text: "次の文です。" } });
    expect(calls).toEqual(["say:ja-JP:見つけました。", "stop", "stop"]);
    read.update({ ...on, line: { key: "m2:head", text: "次の文です。" } });
    expect(calls.at(-1)).toBe("say:ja-JP:次の文です。");
  });

  it("聞き始めて止めた文は、聞き終えても読み直さない", () => {
    const { speaker, calls } = fakeSpeaker();
    const read = createReadAloud(speaker);
    read.update(on);
    read.update({ ...on, listening: true });
    read.update(on);
    expect(calls).toEqual(["say:ja-JP:見つけました。", "stop"]);
  });

  it("言語を切り替えたら、その言語で読み直す", () => {
    const { speaker, calls } = fakeSpeaker();
    const read = createReadAloud(speaker);
    read.update(on);
    read.update({ ...on, lang: "en-US", line: { key: "m1:head", text: "Found it." } });
    expect(calls.at(-1)).toBe("say:en-US:Found it.");
  });

  it("窓が消えたら止める", () => {
    const { speaker, calls } = fakeSpeaker();
    const read = createReadAloud(speaker);
    read.update(on);
    read.stop();
    expect(calls.at(-1)).toBe("stop");
  });
});
