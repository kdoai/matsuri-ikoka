import { describe, expect, it } from "vitest";
import { clientError } from "./errors";
import { applyEvent } from "./events";
import { initialData } from "./initial";
import { busyStaff, currentLine, currentSection } from "./selectors";
import { beginTurn, endTurn } from "./transitions";
import type { AppData } from "./types";

function fresh(): AppData {
  return initialData({ transport: "mock" });
}

function sent(message = "8月16日に行ける祭り"): AppData {
  const state = fresh();
  return beginTurn(state, { kind: "chat", message, preferences: state.preferences });
}

describe("会話の窓のいまの一言", () => {
  it("店に入ったときは、あいさつ", () => {
    expect(currentLine(fresh())).toEqual({ kind: "greeting" });
  });

  it("送ったあと何も届いていなければ、送った発言を添えて待つ", () => {
    expect(currentLine(sent())).toEqual({ kind: "waiting", userText: "8月16日に行ける祭り" });
  });

  it("スタッフが調べている間は、その吹き出しを出し、終わったら結果の一文に替える", () => {
    let state = applyEvent(sent(), {
      type: "tool.start",
      data: {
        toolCallId: "a",
        tool: "search_festivals",
        staff: "researcher",
        bubble: "探しています",
      },
    });
    expect(currentLine(state)).toEqual({ kind: "work", staff: "researcher", text: "探しています" });
    state = applyEvent(state, {
      type: "tool.end",
      data: {
        toolCallId: "a",
        tool: "search_festivals",
        staff: "researcher",
        ok: true,
        bubble: "2件見つかりました",
        count: 2,
      },
    });
    expect(currentLine(state)).toMatchObject({ kind: "work", text: "2件見つかりました" });
    expect(busyStaff(state)).toEqual(["researcher"]);
  });

  it("コンシェルジュが話し始めたら、流れてくる返答を出す", () => {
    let state = applyEvent(sent(), {
      type: "message.delta",
      data: { messageId: "m-1", text: "鈴鳴灯籠まつりが" },
    });
    expect(currentLine(state)).toMatchObject({ kind: "concierge", streaming: true });
    state = applyEvent(state, {
      type: "message.delta",
      data: { messageId: "m-1", text: "おすすめです。" },
    });
    state = applyEvent(state, {
      type: "done",
      data: { stage: "candidates", conditions: {}, preferences: state.preferences },
    });
    expect(currentLine(state)).toMatchObject({
      kind: "concierge",
      text: "鈴鳴灯籠まつりがおすすめです。",
      streaming: false,
    });
  });

  it("返答のあとに片付いていないエラーがあれば、エラーを出す", () => {
    const state = endTurn(sent(), clientError("connection_lost"));
    expect(currentLine(state)).toMatchObject({
      kind: "error",
      entry: { code: "connection_lost", retryable: true },
    });
  });

  it("次の発言を送るまでは、前の返答を出したままにする", () => {
    let state = applyEvent(sent(), {
      type: "message.delta",
      data: { messageId: "m-1", text: "どちらにしますか。" },
    });
    state = applyEvent(state, {
      type: "done",
      data: { stage: "candidates", conditions: {}, preferences: state.preferences },
    });
    state = endTurn(state, null);
    expect(currentLine(state)).toMatchObject({ kind: "concierge", text: "どちらにしますか。" });
  });
});

describe("ゲームの画面の上のタブ", () => {
  it("開いているものを先に見て、なければ相談の進み具合で決める", () => {
    const state = fresh();
    expect(currentSection(state)).toBe("candidates");
    expect(currentSection({ ...state, session: { ...state.session, stage: "itinerary" } })).toBe(
      "guide",
    );
    expect(currentSection({ ...state, session: { ...state.session, stage: "verifying" } })).toBe(
      "confirm",
    );
    expect(currentSection({ ...state, session: { ...state.session, stage: "shiori" } })).toBe(
      "shiori",
    );
    expect(
      currentSection({ ...state, ui: { ...state.ui, drawerOpen: true, tab: "sources" } }),
    ).toBe("confirm");
    expect(
      currentSection({
        ...state,
        session: { ...state.session, stage: "itinerary" },
        ui: { ...state.ui, candidatesOpen: true },
      }),
    ).toBe("candidates");
  });
});
