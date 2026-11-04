import {
  type Festival,
  FestivalSchema,
  type SampleConversation,
  SampleConversationSchema,
} from "@matsuri-ikoka/schema";
import { describe, expect, it, vi } from "vitest";
import sampleJson from "../../../../data/samples/conversations/suzunari-day-trip.json";
import kazamiJson from "../../../../data/samples/festivals/kazami-bon-odori.json";
import suzunariJson from "../../../../data/samples/festivals/suzunari-toro.json";
import { createReplayTransport } from "../testing/replayTransport";
import type { ChatTransport, FestivalSource } from "../transport/types";
import { TransportError } from "../transport/types";
import { setStay } from "./consult";
import { QUIZ_BANK } from "./quizBank";
import { createAppStore, type StoreDeps } from "./store";

const sample: SampleConversation = SampleConversationSchema.parse(sampleJson);
const sampleFestivals: Festival[] = [
  FestivalSchema.parse(suzunariJson),
  FestivalSchema.parse(kazamiJson),
];

const festivalSource: FestivalSource = {
  async load(id) {
    return sampleFestivals.find((festival) => festival.id === id) ?? null;
  },
  async initial() {
    return sampleFestivals;
  },
};

/** 時間を待たずに、記録した相談を再生する通信の口 */
function instantReplay(): ChatTransport {
  return createReplayTransport(sample, { sleep: async () => {} });
}

function makeStore(transport: ChatTransport, extra: Partial<StoreDeps> = {}) {
  return createAppStore({
    transport,
    festivals: festivalSource,
    random: () => 0.1,
    setTimer: () => 0,
    clearTimer: () => {},
    ...extra,
  });
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ストア：記録した相談で、相談からしおりまで", () => {
  it("記録の発言を順に送ると、しおりが開けるところまで進む", async () => {
    const store = makeStore(instantReplay());
    const { actions } = store.getState();
    await actions.enterShop();
    await flush();
    expect(store.getState().session).toMatchObject({
      id: "replay-suzunari-day-trip",
      status: "ready",
    });
    expect(Object.keys(store.getState().festivals).sort()).toEqual([
      "kazami-bon-odori",
      "suzunari-toro",
    ]);

    await actions.send(sample.turns[0]!.request.message);
    expect(store.getState().session.stage).toBe("candidates");
    expect(store.getState().ui.candidatesOpen).toBe(true);

    await actions.chooseCandidate(store.getState().candidates[0]!);
    expect(store.getState().itinerary.current?.version).toBe(1);
    expect(
      store.getState().messages.find((entry) => entry.kind === "user" && entry.id === "u-2"),
    ).toMatchObject({ text: "「鈴鳴灯籠まつり」にします。" });

    await actions.send(sample.turns[2]!.request.message);
    expect(store.getState().itinerary.current?.version).toBe(2);

    await actions.send(sample.turns[3]!.request.message);
    const state = store.getState();
    expect(state.session.stage).toBe("shiori");
    expect(state.verify.result).toBe("as_planned");
    expect(state.messages.some((entry) => entry.kind === "error")).toBe(false);

    actions.openShiori();
    expect(store.getState().ui.view).toBe("shiori");
  });

  it("店を開くたびにクイズの順を混ぜ、答えるとスタンプが増える", async () => {
    const store = makeStore(instantReplay());
    const { deck } = store.getState().quiz;
    expect([...deck].sort()).toEqual(QUIZ_BANK.map((quiz) => quiz.id).sort());
    const quiz = QUIZ_BANK[0]!;
    store.getState().actions.answerQuiz(quiz.id, quiz.answer);
    expect(store.getState().stamps).toBe(1);
    store.getState().actions.answerQuiz("no-such-quiz", 0);
    expect(store.getState().stamps).toBe(1);
  });

  it("記録の終わりまで再生したら、その旨のエラーを出す", async () => {
    const store = makeStore(instantReplay());
    const { actions } = store.getState();
    await actions.enterShop();
    for (const turn of sample.turns) {
      await actions.send(turn.request.message);
    }
    await actions.send("もう1つ");
    expect(store.getState().messages.at(-1)).toMatchObject({ kind: "error", retryable: false });
    expect(store.getState().session.stage).toBe("shiori");
  });

  it("最初からやり直すと、記録の最初から再生し直す", async () => {
    const store = makeStore(instantReplay());
    const { actions } = store.getState();
    await actions.enterShop();
    await actions.send(sample.turns[0]!.request.message);
    await actions.restart();
    expect(store.getState().messages).toEqual([]);
    await actions.send(sample.turns[0]!.request.message);
    expect(store.getState().session.stage).toBe("candidates");
  });
});

describe("ストア：通信のエラー", () => {
  function failing(chat: ChatTransport["chat"]): ChatTransport {
    return {
      startSession: async () => "s-1",
      chat,
      updatePreferences: async () => {},
    };
  }

  it("形の違うイベントは捨てて、会話欄に知らせる", async () => {
    const store = makeStore(
      failing(async (_request, onMessage) => {
        onMessage({ event: "done", data: JSON.stringify({ stage: "nope" }) });
      }),
    );
    await store.getState().actions.enterShop();
    await store.getState().actions.send("こんにちは");
    const errors = store.getState().messages.filter((entry) => entry.kind === "error");
    expect(errors.map((entry) => entry.kind === "error" && entry.code)).toEqual([
      "invalid_event",
      "connection_lost",
    ]);
  });

  const doneMessage = {
    event: "done",
    data: JSON.stringify({
      stage: "hearing",
      conditions: {},
      preferences: { party: "adults", spot: "auto", food: "stalls", move: "train" },
    }),
  };

  it("画面の側の処理が失敗しても、接続が切れたことにせず、最後まで受け取る", async () => {
    const store = makeStore(
      failing(async (_request, onMessage) => {
        onMessage({ event: "message.delta", data: JSON.stringify({ messageId: "m", text: "は" }) });
        onMessage(doneMessage);
      }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let thrown = 0;
    // 効果音のように、ストアの変化を受けて動く処理が投げる
    const unsubscribe = store.subscribe((state, previous) => {
      const replied = (messages: typeof state.messages) =>
        messages.some((entry) => entry.kind === "concierge");
      if (replied(state.messages) && !replied(previous.messages) && thrown === 0) {
        thrown += 1;
        throw new Error("boom");
      }
    });
    try {
      await store.getState().actions.enterShop();
      await store.getState().actions.send("こんにちは");
    } finally {
      unsubscribe();
      error.mockRestore();
    }
    expect(thrown).toBe(1);
    expect(store.getState().session).toMatchObject({ streaming: false, sawDone: true });
    expect(store.getState().messages.some((entry) => entry.kind === "error")).toBe(false);
  });

  it("done が届かないまま閉じたら、サーバーが応答するかで伝え方を変える", async () => {
    const dropped = (reachable: boolean): ChatTransport => ({
      ...failing(async (_request, onMessage) => {
        onMessage({ event: "message.delta", data: JSON.stringify({ messageId: "m", text: "は" }) });
      }),
      checkServer: async () => reachable,
    });

    const alive = makeStore(dropped(true));
    await alive.getState().actions.enterShop();
    await alive.getState().actions.send("こんにちは");
    expect(alive.getState().messages.at(-1)).toMatchObject({
      kind: "error",
      code: "connection_lost",
      retryable: true,
    });

    const down = makeStore(dropped(false));
    await down.getState().actions.enterShop();
    await down.getState().actions.send("こんにちは");
    expect(down.getState().messages.at(-1)).toMatchObject({
      kind: "error",
      code: "server_unreachable",
      retryable: true,
    });
    expect(down.getState().session.streaming).toBe(false);
  });

  it("通信のエラーで切れたときも、サーバーが止まっていればそう伝える", async () => {
    const store = makeStore({
      ...failing(async () => {
        throw new TransportError("connection_lost");
      }),
      checkServer: async () => false,
    });
    await store.getState().actions.enterShop();
    await store.getState().actions.send("こんにちは");
    expect(store.getState().messages.at(-1)).toMatchObject({ code: "server_unreachable" });
  });

  it("相談を始めたら、サーバーが知らせた動き方を持つ", async () => {
    const store = makeStore({ ...failing(async () => {}), agentMode: () => "mock" });
    expect(store.getState().session.mode).toBeNull();
    await store.getState().actions.enterShop();
    expect(store.getState().session).toMatchObject({ status: "ready", mode: "mock" });
  });

  it("接続が切れたら「もう一度送る」で同じ発言を送り直す", async () => {
    const chat = vi
      .fn<ChatTransport["chat"]>()
      .mockRejectedValueOnce(new TransportError("connection_lost"))
      .mockImplementationOnce(async (_request, onMessage) => {
        onMessage({
          event: "done",
          data: JSON.stringify({
            stage: "hearing",
            conditions: {},
            preferences: { party: "adults", spot: "auto", food: "stalls", move: "train" },
          }),
        });
      });
    const store = makeStore(failing(chat));
    const { actions } = store.getState();
    await actions.enterShop();
    await actions.send("8月16日に行ける祭り");
    expect(store.getState().messages.at(-1)).toMatchObject({
      kind: "error",
      code: "connection_lost",
      retryable: true,
    });

    await actions.retry();
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[1]?.[0]).toMatchObject({ message: "8月16日に行ける祭り" });
    const users = store.getState().messages.filter((entry) => entry.kind === "user");
    expect(users).toHaveLength(1);
    expect(
      store.getState().messages.some((entry) => entry.kind === "error" && !entry.resolved),
    ).toBe(false);
  });

  it("相談を始められなければ、送り直しでもう一度始める", async () => {
    const startSession = vi
      .fn<ChatTransport["startSession"]>()
      .mockRejectedValueOnce(new TransportError("upstream_unavailable", { status: 503 }))
      .mockResolvedValueOnce("s-2");
    const store = makeStore({
      startSession,
      chat: async () => {},
      updatePreferences: async () => {},
    });
    await store.getState().actions.enterShop();
    expect(store.getState().session.status).toBe("failed");
    await store.getState().actions.retry();
    expect(store.getState().session).toMatchObject({ status: "ready", id: "s-2" });
  });

  it("旅程があるときにこだわりを切り替えると、組み直しを頼む", async () => {
    const store = makeStore(instantReplay());
    const { actions } = store.getState();
    await actions.enterShop();
    await actions.send(sample.turns[0]!.request.message);
    await actions.send(sample.turns[1]!.request.message);
    await actions.setPreference("party", "kids");
    const state = store.getState();
    expect(state.preferences.party).toBe("kids");
    expect(state.session.lastWasPreferences).toBe(true);
    expect(state.messages.at(-1)).toMatchObject({
      kind: "preference",
      key: "party",
      value: "kids",
    });
    expect(state.session.streaming).toBe(false);
  });

  it("SSE の前に断られたら、サーバーの一文と送り直せるかを会話欄に出す", async () => {
    const store = makeStore(
      failing(async () => {
        throw new TransportError("bad_request", {
          status: 409,
          message: "前の返事を作っています。終わってから送ってください。",
          retryable: true,
        });
      }),
    );
    await store.getState().actions.enterShop();
    await store.getState().actions.send("こんにちは");
    expect(store.getState().messages.at(-1)).toMatchObject({
      kind: "error",
      code: "bad_request",
      message: "前の返事を作っています。終わってから送ってください。",
      retryable: true,
    });
  });

  it("相談が見つからない（404）ときは、新しい相談を自動で始め、送り直すと新しい相談に送る", async () => {
    const startSession = vi
      .fn<ChatTransport["startSession"]>()
      .mockResolvedValueOnce("s-old")
      .mockResolvedValueOnce("s-new");
    const chat = vi
      .fn<ChatTransport["chat"]>()
      .mockRejectedValueOnce(new TransportError("session_lost", { status: 404, retryable: true }))
      .mockImplementationOnce(async (_request, onMessage) => {
        onMessage({
          event: "done",
          data: JSON.stringify({
            stage: "hearing",
            conditions: {},
            preferences: { party: "adults", spot: "auto", food: "stalls", move: "train" },
          }),
        });
      });
    const store = makeStore({
      startSession,
      chat,
      updatePreferences: async () => {},
    });
    const { actions } = store.getState();
    await actions.enterShop();
    await actions.send("8月16日に行ける祭り");
    expect(startSession).toHaveBeenCalledTimes(2);
    expect(store.getState().session).toMatchObject({ id: "s-new", status: "ready" });
    expect(store.getState().messages.at(-1)).toMatchObject({
      code: "session_lost",
      retryable: true,
    });

    await actions.retry();
    expect(chat.mock.calls[1]?.[0]).toMatchObject({
      sessionId: "s-new",
      message: "8月16日に行ける祭り",
    });
    expect(store.getState().messages.filter((entry) => entry.kind === "user")).toHaveLength(1);
  });
});

describe("ストア：合言葉", () => {
  function guarded(options: { chat?: ChatTransport["chat"] } = {}) {
    let passcode: string | null = null;
    const setPasscode = vi.fn((value: string) => {
      passcode = value;
    });
    const transport: ChatTransport = {
      async startSession() {
        if (passcode !== "matsuri") {
          throw new TransportError("unauthorized", {
            status: 401,
            message: "合言葉が違います。",
            retryable: false,
          });
        }
        return "s-1";
      },
      chat: options.chat ?? (async () => {}),
      updatePreferences: async () => {},
      setPasscode,
      hasPasscode: () => passcode !== null,
    };
    return { transport, setPasscode };
  }

  it("相談を始める前に断られたら、店の入口で合言葉を聞き、入れたら始める", async () => {
    const { transport, setPasscode } = guarded();
    const store = makeStore(transport);
    const { actions } = store.getState();
    await actions.enterShop();
    expect(store.getState().ui.view).toBe("storefront");
    expect(store.getState().auth).toEqual({ needed: true, rejected: false });
    expect(store.getState().messages).toEqual([]);

    // ヘッダーで送れない合言葉は、送らない
    await actions.submitPasscode("まつり");
    expect(setPasscode).not.toHaveBeenCalled();

    await actions.submitPasscode("wrong");
    expect(store.getState().auth).toEqual({ needed: true, rejected: true });

    await actions.submitPasscode(" matsuri ");
    expect(setPasscode).toHaveBeenLastCalledWith("matsuri");
    expect(store.getState().ui.view).toBe("shop");
    expect(store.getState().session).toMatchObject({ id: "s-1", status: "ready" });
    expect(store.getState().auth).toEqual({ needed: false, rejected: false });
  });

  it("相談の途中で断られたら合言葉を聞き直し、入れ直すと同じ発言を送り直す", async () => {
    const chat = vi
      .fn<ChatTransport["chat"]>()
      .mockRejectedValueOnce(
        new TransportError("unauthorized", { status: 401, message: "合言葉が違います。" }),
      )
      .mockImplementationOnce(async (_request, onMessage) => {
        onMessage({
          event: "done",
          data: JSON.stringify({
            stage: "hearing",
            conditions: {},
            preferences: { party: "adults", spot: "auto", food: "stalls", move: "train" },
          }),
        });
      });
    const { transport } = guarded({ chat });
    const store = makeStore(transport);
    const { actions } = store.getState();
    await actions.enterShop();
    await actions.submitPasscode("matsuri");
    await actions.send("こんにちは");
    expect(store.getState().auth).toEqual({ needed: true, rejected: true });

    await actions.submitPasscode("matsuri");
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[1]?.[0]).toMatchObject({ message: "こんにちは" });
    expect(store.getState().auth.needed).toBe(false);
    expect(store.getState().session.sawDone).toBe(true);
  });
});

describe("ストア：選んで進める相談", () => {
  it("選んだ内容を1つの発言にまとめて送り、聞き取りをしまう", async () => {
    const chat = vi.fn<ChatTransport["chat"]>(async () => {});
    const transport: ChatTransport = { ...instantReplay(), chat };
    const store = makeStore(transport, { today: () => "2030-06-05" });
    const { actions } = store.getState();
    await actions.enterShop();
    await flush();
    expect(store.getState().consult.active).toBe(true);

    actions.pickConsult("party", "family");
    actions.setConsultText("origin", "みなと中央駅");
    actions.pickConsult("schedule", "nextWeekend");
    actions.editConsult((answers) => setStay(answers, "oneNight"));
    actions.setConsultStep("confirm");
    await actions.submitConsult();

    expect(chat).toHaveBeenCalledTimes(1);
    const message = chat.mock.calls[0]?.[0].message ?? "";
    expect(message).toContain("・だれと：家族で（大人2人、計2人）");
    expect(message).toContain("・日程：来週末（2030-06-15〜2030-06-16）、1泊");
    expect(message).toContain("・出発する駅：みなと中央駅");
    expect(store.getState().consult.active).toBe(false);
    expect(store.getState().ui.dialogueOpen).toBe(true);

    // 選び直すと、最初の段階から開き、選んだ内容は残る
    actions.reopenConsult();
    expect(store.getState().consult).toMatchObject({ active: true, step: "party" });
    expect(store.getState().consult.answers.party?.picks).toEqual(["family"]);
  });

  it("何も選んでいなければ送らない。自分の言葉で送ったら聞き取りをしまう", async () => {
    const chat = vi.fn<ChatTransport["chat"]>(async () => {});
    const store = makeStore({ ...instantReplay(), chat });
    const { actions } = store.getState();
    await actions.enterShop();
    await flush();
    await actions.submitConsult();
    expect(chat).not.toHaveBeenCalled();

    await actions.send("来週末に、みなと中央駅から日帰りで");
    expect(chat).toHaveBeenCalledTimes(1);
    expect(store.getState().consult.active).toBe(false);
  });

  it("話しかけると、はじめての操作の案内を見終えたことにする。やり直しても戻さない", async () => {
    const store = makeStore(instantReplay());
    const { actions } = store.getState();
    expect(store.getState().ui.tutorialSeen).toBe(false);
    actions.setDialogue(true);
    expect(store.getState().ui.tutorialSeen).toBe(true);
    await actions.restart();
    expect(store.getState().ui.tutorialSeen).toBe(true);
    expect(makeStore(instantReplay(), { tutorialSeen: true }).getState().ui.tutorialSeen).toBe(
      true,
    );
  });
});
