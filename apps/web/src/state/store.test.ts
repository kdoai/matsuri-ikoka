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
import { createMockTransport } from "../mock/replay";
import type { ChatTransport, FestivalSource } from "../transport/types";
import { TransportError } from "../transport/types";
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

/** 時間を待たずに再生するモック */
function instantMock(): ChatTransport {
  return createMockTransport(sample, { sleep: async () => {} });
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

describe("ストア：画面だけのモックで、相談からしおりまで", () => {
  it("記録の発言を順に送ると、しおりが開けるところまで進む", async () => {
    const store = makeStore(instantMock());
    const { actions } = store.getState();
    await actions.enterShop();
    await flush();
    expect(store.getState().session).toMatchObject({
      id: "mock-suzunari-day-trip",
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

  it("待ち時間の長い発言では、祭りのデータからクイズを1問出す", async () => {
    const store = makeStore(instantMock());
    const { actions } = store.getState();
    await actions.enterShop();
    await flush();
    const offered: number[] = [];
    store.subscribe((state, previous) => {
      if (state.quiz.question !== null && previous.quiz.question === null) {
        offered.push(state.session.turn);
      }
    });
    for (const turn of sample.turns) {
      await actions.send(turn.request.message);
    }
    // 周辺係と旅程係が動く発言（2つ目）と、再確認の発言（4つ目）
    expect(offered).toEqual([2, 4]);
  });

  it("記録の終わりまで再生したら、その旨のエラーを出す", async () => {
    const store = makeStore(instantMock());
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
    const store = makeStore(instantMock());
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
      kind: "server",
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
      kind: "server",
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
    const store = makeStore(instantMock());
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
      kind: "server",
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
      kind: "server",
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
