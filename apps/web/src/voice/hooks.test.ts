import { afterEach, describe, expect, it } from "vitest";
import { allowRemoteVoice, forgetRemoteVoice, shouldPauseReadAloud, voiceAllowed } from "./hooks";

describe("voiceAllowed", () => {
  afterEach(() => forgetRemoteVoice());

  it("この端末の中の声なら、説明なしで読める", () => {
    expect(voiceAllowed(true, "ja-JP")).toBe(true);
  });

  it("端末の外の声は、その言語で説明して認めてもらったときだけ読める", () => {
    expect(voiceAllowed(false, "ja-JP")).toBe(false);
    allowRemoteVoice("ja-JP");
    expect(voiceAllowed(false, "ja-JP")).toBe(true);
    // 言語を変えたら、もう一度説明する
    expect(voiceAllowed(false, "en-US")).toBe(false);
  });

  it("オフにしたら認めたことを忘れ、次にオンにするときまた説明する", () => {
    allowRemoteVoice("ja-JP");
    forgetRemoteVoice();
    expect(voiceAllowed(false, "ja-JP")).toBe(false);
  });
});

describe("shouldPauseReadAloud", () => {
  afterEach(() => forgetRemoteVoice());

  it("オンのまま、使う声が端末の外のものになったらオフにし、認めたことを忘れる", () => {
    expect(shouldPauseReadAloud(true, false, "en-US")).toBe(true);
    allowRemoteVoice("ja-JP");
    expect(shouldPauseReadAloud(true, false, "ja-JP")).toBe(false);
  });

  it("言語を変えたら、前の言語で認めたことを忘れ、戻っても説明なしでは読まない", () => {
    allowRemoteVoice("ja-JP");
    // 英語は端末の中の声で読める
    expect(shouldPauseReadAloud(true, true, "en-US")).toBe(false);
    expect(voiceAllowed(false, "ja-JP")).toBe(false);
    expect(shouldPauseReadAloud(true, false, "ja-JP")).toBe(true);
  });

  it("オフのときや端末の中の声のときは、オフにしない", () => {
    expect(shouldPauseReadAloud(false, false, "ja-JP")).toBe(false);
    expect(shouldPauseReadAloud(true, true, "ja-JP")).toBe(false);
  });
});
