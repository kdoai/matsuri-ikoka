import { afterEach, describe, expect, it } from "vitest";
import { allowRemoteVoice, forgetRemoteVoice, voiceAllowed } from "./hooks";

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
