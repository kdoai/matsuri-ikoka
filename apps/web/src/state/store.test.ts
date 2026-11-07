import {
  type AnchorPlan,
  type ChatRequest,
  DEFAULT_PREFERENCES,
  encodeSseEvent,
  type Festival,
  FestivalSchema,
  type FestivalSearchResponse,
  type FestivalSearchResult,
  type SampleConversation,
  SampleConversationSchema,
  type SearchOutcome,
} from "@matsuri-ikoka/schema";
import { fictionalSource } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it, vi } from "vitest";
import sampleJson from "../../../../data/samples/conversations/suzunari-day-trip.json";
import kazamiJson from "../../../../data/samples/festivals/kazami-bon-odori.json";
import suzunariJson from "../../../../data/samples/festivals/suzunari-toro.json";
import { createReplayTransport } from "../testing/replayTransport";
import type { ChatTransport, FestivalSource } from "../transport/types";
import { TransportError } from "../transport/types";
import { setAnchorNights } from "./anchorTrip";
import { setStay } from "./consult";
import { setSeason, toggleArea, toggleKind } from "./festivalSearch";
import { QUIZ_BANK } from "./quizBank";
import { canReturnToFestivals } from "./selectors";
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

const noSearch: ChatTransport["searchFestivals"] = async () => ({
  results: [],
  remaining: 0,
  nearMatches: [],
  next: [],
  reading: null,
});

const noPreview: ChatTransport["previewFestivalTrip"] = async () => {
  throw new TransportError("internal");
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

  it("最初からやり直しても、音と読み上げの設定はそのまま残す", async () => {
    const store = makeStore(instantReplay());
    const { actions } = store.getState();
    expect(store.getState().ui.readAloud).toBe(false);
    actions.setSound(true);
    actions.setReadAloud(true);
    await actions.enterShop();
    await actions.restart();
    expect(store.getState().ui).toMatchObject({ soundOn: true, readAloud: true });
    actions.setReadAloud(false, true);
    expect(store.getState().ui).toMatchObject({ readAloud: false, readAloudNotice: true });
    actions.setReadAloud(false);
    expect(store.getState().ui.readAloudNotice).toBe(false);
  });
});

describe("ストア：通信のエラー", () => {
  function failing(chat: ChatTransport["chat"]): ChatTransport {
    return {
      startSession: async () => "s-1",
      chat,
      updatePreferences: async () => {},
      searchFestivals: noSearch,
      previewFestivalTrip: noPreview,
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
      searchFestivals: noSearch,
      previewFestivalTrip: noPreview,
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
      searchFestivals: noSearch,
      previewFestivalTrip: noPreview,
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
      searchFestivals: noSearch,
      previewFestivalTrip: noPreview,
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

function festivalResult(index: number): FestivalSearchResult {
  const id = `kasou-matsuri-${index}`;
  return {
    candidate: {
      festivalId: id,
      name: `架空の祭り${index}`,
      date: "2030-08-16",
      start: null,
      end: null,
      venueName: "架空の広場",
      place: "架空県架空町",
      daysFromWish: 0,
      confidence: "official",
      confirmed: true,
      highlight: "灯籠が川を流れる",
      source: fictionalSource("kasou"),
    },
    matchedKinds: ["traditional"],
    reasons: ["伝統的な祭りです"],
    wishFit: null,
  };
}

function searchReply(overrides: Partial<FestivalSearchResponse> = {}): FestivalSearchResponse {
  return { results: [], remaining: 0, nearMatches: [], next: [], reading: null, ...overrides };
}

describe("ストア：祭りから探す相談", () => {
  async function ready(searchFestivals: ChatTransport["searchFestivals"]) {
    const store = makeStore({ ...instantReplay(), searchFestivals });
    await store.getState().actions.enterShop();
    await flush();
    const { actions } = store.getState();
    actions.chooseConsultEntry("festival");
    actions.editFestivalAnswers((answers) =>
      toggleArea(setSeason(toggleKind(answers, "traditional"), "summer"), "shikoku"),
    );
    return { store, actions };
  }

  it("答えた条件で探し、見せた祭りを除いて続きを足し、見終えたら閉じる", async () => {
    const search = vi
      .fn<ChatTransport["searchFestivals"]>()
      .mockResolvedValueOnce(
        searchReply({ results: [festivalResult(1), festivalResult(2)], remaining: 1 }),
      )
      .mockResolvedValueOnce(searchReply({ results: [festivalResult(3)] }));
    const { store, actions } = await ready(search);

    await actions.searchFestivals();
    expect(search.mock.calls[0]?.[0]).toEqual({
      sessionId: "replay-suzunari-day-trip",
      kinds: ["traditional"],
      season: "summer",
      prefectures: ["徳島県", "香川県", "愛媛県", "高知県"],
      excludeIds: [],
    });
    expect(store.getState().festivalSearch).toMatchObject({
      phase: "results",
      resultsOpen: true,
      remaining: 1,
    });

    await actions.moreFestivals();
    expect(search.mock.calls[1]?.[0].excludeIds).toEqual(["kasou-matsuri-1", "kasou-matsuri-2"]);
    expect(store.getState().festivalSearch.results).toHaveLength(3);
    expect(store.getState().festivalSearch.remaining).toBe(0);

    // 見終えたら、もう送らない
    await actions.moreFestivals();
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("相談を始める前は送らない", async () => {
    const search = vi.fn<ChatTransport["searchFestivals"]>(noSearch);
    const store = makeStore({ ...instantReplay(), searchFestivals: search });
    await store.getState().actions.searchFestivals();
    expect(search).not.toHaveBeenCalled();
    expect(store.getState().festivalSearch.phase).toBe("asking");
  });

  it("次の手は変えた条件で探し、見せた祭りは残す。条件を選び直す手は聞き取りに戻る", async () => {
    const search = vi
      .fn<ChatTransport["searchFestivals"]>()
      .mockResolvedValueOnce(searchReply({ results: [festivalResult(1)] }))
      .mockResolvedValueOnce(searchReply({ results: [festivalResult(2)] }));
    const { store, actions } = await ready(search);
    await actions.searchFestivals();
    await actions.chooseFestivalNext({
      kind: "any_season",
      label: "季節を問わない",
      conditions: { kinds: ["traditional"], season: null, prefectures: ["徳島県"] },
      found: 1,
    });
    expect(search.mock.calls[1]?.[0]).toMatchObject({
      season: null,
      prefectures: ["徳島県"],
      excludeIds: ["kasou-matsuri-1"],
    });
    expect(store.getState().festivalSearch.results).toHaveLength(2);

    await actions.chooseFestivalNext({
      kind: "edit_conditions",
      label: "条件を選び直す",
      conditions: null,
      found: null,
    });
    expect(search).toHaveBeenCalledTimes(2);
    expect(store.getState().festivalSearch).toMatchObject({ phase: "asking", step: "kinds" });
    // 変えた条件が答えに残っている
    expect(store.getState().festivalSearch.answers.season).toBe("auto");
  });

  it("探すのに失敗したら最後の段階へ戻してエラーを持ち、続きの失敗では結果を残す", async () => {
    const search = vi
      .fn<ChatTransport["searchFestivals"]>()
      .mockRejectedValueOnce(new TransportError("rate_limited", { status: 429 }))
      .mockResolvedValueOnce(searchReply({ results: [festivalResult(1)], remaining: 3 }))
      .mockRejectedValueOnce(new TransportError("internal", { status: 500 }));
    const { store, actions } = await ready(search);
    await actions.searchFestivals();
    expect(store.getState().festivalSearch).toMatchObject({
      phase: "asking",
      step: "wish",
      error: { code: "rate_limited" },
    });

    await actions.searchFestivals();
    expect(store.getState().festivalSearch.error).toBeNull();
    await actions.moreFestivals();
    expect(store.getState().festivalSearch).toMatchObject({
      phase: "results",
      loadingMore: false,
      error: { code: "internal" },
    });
    expect(store.getState().festivalSearch.results).toHaveLength(1);
    // 会話の記録には積まない（「もう一度送る」は前の発言を送り直す口なので）
    expect(store.getState().messages.some((entry) => entry.kind === "error")).toBe(false);
  });

  it("相談が切れていたら、始め直して一度だけ送り直す", async () => {
    const search = vi
      .fn<ChatTransport["searchFestivals"]>()
      .mockRejectedValueOnce(new TransportError("session_lost", { status: 404 }))
      .mockResolvedValueOnce(searchReply({ results: [festivalResult(1)] }));
    const { store, actions } = await ready(search);
    await actions.searchFestivals();
    expect(search).toHaveBeenCalledTimes(2);
    expect(store.getState().festivalSearch.phase).toBe("results");
  });

  it("合言葉で断られたら聞き直し、入れたら探し直す", async () => {
    const search = vi
      .fn<ChatTransport["searchFestivals"]>()
      .mockRejectedValueOnce(new TransportError("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(searchReply({ results: [festivalResult(1)] }));
    const { store, actions } = await ready(search);
    await actions.searchFestivals();
    expect(store.getState().auth.needed).toBe(true);

    await actions.submitPasscode("matsuri");
    expect(store.getState().auth.needed).toBe(false);
    expect(store.getState().festivalSearch).toMatchObject({ phase: "results", error: null });
  });

  it("旅行計画を作成すると、祭りと行く日を残して聞き取りへ進み、＜ で決めるところへ戻る", async () => {
    const { store, actions } = await ready(async () =>
      searchReply({ results: [festivalResult(1)] }),
    );
    await actions.searchFestivals();
    const chosen = store.getState().festivalSearch.results[0];
    if (chosen === undefined) throw new Error("結果がありません");
    actions.chooseFestival(chosen);
    expect(store.getState().festivalSearch).toMatchObject({ phase: "decide", resultsOpen: false });

    actions.planFestivalTrip();
    expect(store.getState().consult).toMatchObject({
      active: true,
      entry: "trip",
      step: "party",
      anchor: { festivalId: "kasou-matsuri-1", date: "2030-08-16" },
    });

    actions.leaveHearing();
    expect(store.getState().consult).toMatchObject({ entry: "festival", anchor: null });
    expect(store.getState().festivalSearch.phase).toBe("decide");
  });

  describe("祭りを固定した聞き取り", () => {
    const plan: AnchorPlan = {
      anchor: { festivalId: "kasou-matsuri-1", date: "2030-08-16" },
      festivalName: "架空の祭り1",
      mustPrefectures: ["香川県"],
      visits: [],
      order: ["みなと中央駅", "架空の祭り1", "みなと中央駅"],
      startDate: "2030-08-16",
      endDate: "2030-08-17",
      minNights: 1,
      warnings: [],
    };

    /** 祭りを決め、泊数と出発地まで答えた状態にする */
    async function anchored(overrides: Partial<ChatTransport> = {}) {
      const chat = vi.fn<ChatTransport["chat"]>(async (_request, onMessage) => {
        onMessage(
          encodeSseEvent({
            type: "done",
            data: {
              stage: "candidates",
              conditions: {},
              preferences: DEFAULT_PREFERENCES,
            },
          }),
        );
      });
      const preview = vi.fn<ChatTransport["previewFestivalTrip"]>(async () => plan);
      const store = makeStore({
        ...instantReplay(),
        chat,
        previewFestivalTrip: preview,
        searchFestivals: async () =>
          searchReply({ results: [festivalResult(1), festivalResult(2)] }),
        ...overrides,
      });
      await store.getState().actions.enterShop();
      await flush();
      const { actions } = store.getState();
      actions.chooseConsultEntry("festival");
      await actions.searchFestivals();
      const chosen = store.getState().festivalSearch.results[0];
      if (chosen === undefined) throw new Error("結果がありません");
      actions.chooseFestival(chosen);
      actions.planFestivalTrip();
      actions.editAnchoredHearing((consult) => setAnchorNights(consult, 1));
      actions.setConsultText("origin", "みなと中央駅");
      return { store, actions, chat, preview };
    }

    it("組み立てを確かめ、同じ答えでは読み直さず、答えを変えると確かめ直す", async () => {
      const { store, actions, preview } = await anchored();
      const loading = actions.loadAnchorPreview();
      expect(store.getState().consult.preview.status).toBe("loading");
      await loading;
      expect(store.getState().consult.preview).toMatchObject({ status: "ready", plan });
      expect(preview.mock.calls[0]?.[0]).toMatchObject({
        anchor: { festivalId: "kasou-matsuri-1", date: "2030-08-16" },
        origin: "みなと中央駅",
        nights: 1,
        wishes: [],
      });

      await actions.loadAnchorPreview();
      expect(preview).toHaveBeenCalledTimes(1);

      actions.editAnchoredHearing((consult) => setAnchorNights(consult, 2));
      await actions.loadAnchorPreview();
      expect(preview).toHaveBeenCalledTimes(2);
    });

    it("確かめられなくても送れる。確かめ直すこともできる", async () => {
      const failing = vi
        .fn<ChatTransport["previewFestivalTrip"]>()
        .mockRejectedValueOnce(new TransportError("internal", { message: "確かめられません" }))
        .mockResolvedValueOnce(plan);
      const { store, actions, chat } = await anchored({ previewFestivalTrip: failing });
      await actions.loadAnchorPreview();
      expect(store.getState().consult.preview).toMatchObject({
        status: "failed",
        plan: null,
        error: { code: "internal", message: "確かめられません" },
      });
      await actions.loadAnchorPreview();
      expect(store.getState().consult.preview.status).toBe("ready");
      expect(failing).toHaveBeenCalledTimes(2);

      await actions.submitConsult();
      expect(chat).toHaveBeenCalledTimes(1);
    });

    it("送るときに祭りと行く日を添え、送り直しでも落とさない", async () => {
      const chat = vi
        .fn<ChatTransport["chat"]>()
        .mockRejectedValueOnce(new TransportError("internal", { retryable: true }))
        .mockImplementationOnce(async (_request, onMessage) => {
          onMessage(
            encodeSseEvent({
              type: "done",
              data: { stage: "itinerary", conditions: {}, preferences: DEFAULT_PREFERENCES },
            }),
          );
        });
      const { store, actions } = await anchored({ chat });
      await actions.submitConsult();
      const anchor = { festivalId: "kasou-matsuri-1", date: "2030-08-16" };
      const first = chat.mock.calls[0]?.[0] as ChatRequest;
      expect(first.anchor).toEqual(anchor);
      expect(first.message).toContain("必ず行く");
      expect(first.message).toContain("祭りは探し直さず");
      expect(store.getState().session.lastRequest?.anchor).toEqual(anchor);
      expect(store.getState().consult.active).toBe(false);

      await actions.retry();
      const second = chat.mock.calls[1]?.[0] as ChatRequest;
      expect(second.anchor).toEqual(anchor);
      expect(second.message).toBe(first.message);
    });

    it("相談が切れても、送り直しで祭りを落とさず、結果へ戻れる", async () => {
      const chat = vi
        .fn<ChatTransport["chat"]>()
        .mockRejectedValueOnce(new TransportError("session_lost", { status: 404 }))
        .mockImplementationOnce(async () => {});
      const { store, actions } = await anchored({ chat });
      await actions.submitConsult();
      expect(store.getState().consult.anchor).not.toBeNull();
      expect(store.getState().festivalSearch.chosen).not.toBeNull();
      await flush();
      await actions.retry();
      expect(chat.mock.calls[1]?.[0]?.anchor).toBeDefined();
    });

    it("組み立てがあれば、その結果の日付を一文に入れる", async () => {
      const shifted = { ...plan, startDate: "2030-08-15", endDate: "2030-08-16" };
      const { actions, chat } = await anchored({
        previewFestivalTrip: async () => shifted,
      });
      await actions.loadAnchorPreview();
      await actions.submitConsult();
      expect(chat.mock.calls[0]?.[0]?.message).toContain("2030-08-15〜2030-08-16");
    });

    it("中止と分かったら結果へ戻り、その祭りを一覧から外す", async () => {
      const chat = vi.fn<ChatTransport["chat"]>(async (_request, onMessage) => {
        onMessage(
          encodeSseEvent({
            type: "festival.verified",
            data: {
              festivalId: "kasou-matsuri-1",
              date: "2030-08-16",
              scope: "candidate",
              result: "cancelled",
              checkedAt: "2030-08-01T10:00:00+09:00",
              sources: [],
            },
          }),
        );
        onMessage(
          encodeSseEvent({
            type: "done",
            data: { stage: "candidates", conditions: {}, preferences: DEFAULT_PREFERENCES },
          }),
        );
      });
      const { store, actions } = await anchored({ chat });
      await actions.submitConsult();
      expect(store.getState().consult.anchorCancelled).toBe(true);
      expect(canReturnToFestivals(store.getState())).toBe(true);

      actions.returnToFestivalResults();
      expect(store.getState().consult).toMatchObject({
        active: true,
        entry: "festival",
        anchor: null,
        anchorCancelled: false,
      });
      const search = store.getState().festivalSearch;
      expect(search).toMatchObject({ phase: "results", resultsOpen: true, chosen: null });
      expect(search.results.map((result) => result.candidate.festivalId)).toEqual([
        "kasou-matsuri-2",
      ]);
    });

    it("中止でなくても、旅程へ進まなければ結果へ戻れる。祭りは一覧に残す", async () => {
      const { store, actions } = await anchored();
      expect(canReturnToFestivals(store.getState())).toBe(false);
      await actions.submitConsult();
      expect(store.getState().consult.anchorCancelled).toBe(false);
      expect(canReturnToFestivals(store.getState())).toBe(true);
      actions.returnToFestivalResults();
      expect(store.getState().festivalSearch.results).toHaveLength(2);
    });

    it("別の祭りの中止の知らせでは、決めた祭りを中止にしない", async () => {
      const chat = vi.fn<ChatTransport["chat"]>(async (_request, onMessage) => {
        onMessage(
          encodeSseEvent({
            type: "festival.verified",
            data: {
              festivalId: "kasou-matsuri-2",
              scope: "candidate",
              result: "cancelled",
              checkedAt: "2030-08-01T10:00:00+09:00",
              sources: [],
            },
          }),
        );
      });
      const { store, actions } = await anchored({ chat });
      await actions.submitConsult();
      expect(store.getState().consult.anchorCancelled).toBe(false);
    });

    it("旅行計画から探す相談では、anchor を添えない", async () => {
      const chat = vi.fn<ChatTransport["chat"]>(async () => {});
      const store = makeStore({ ...instantReplay(), chat });
      await store.getState().actions.enterShop();
      await flush();
      const { actions } = store.getState();
      actions.chooseConsultEntry("trip");
      actions.pickConsult("party", "solo");
      await actions.submitConsult();
      const request = chat.mock.calls[0]?.[0] as ChatRequest;
      expect(request).not.toHaveProperty("anchor");
      expect(store.getState().session.lastRequest).not.toHaveProperty("anchor");
      expect(canReturnToFestivals(store.getState())).toBe(false);
    });
  });

  it("ここで終えてもモデルを呼ばず、はじめに戻ると入口へ戻る", async () => {
    const chat = vi.fn<ChatTransport["chat"]>(async () => {});
    const store = makeStore({
      ...instantReplay(),
      chat,
      searchFestivals: async () => searchReply({ results: [festivalResult(1)] }),
    });
    const { actions } = store.getState();
    await actions.enterShop();
    await flush();
    actions.chooseConsultEntry("festival");
    await actions.searchFestivals();
    const chosen = store.getState().festivalSearch.results[0];
    if (chosen === undefined) throw new Error("結果がありません");
    actions.chooseFestival(chosen);
    actions.finishFestivalSearch();
    expect(store.getState().festivalSearch.phase).toBe("finished");
    expect(chat).not.toHaveBeenCalled();

    actions.startConsultOver();
    expect(store.getState().consult).toMatchObject({ active: true, entry: null, anchor: null });
    expect(store.getState().festivalSearch.phase).toBe("asking");
    expect(store.getState().festivalSearch.results).toEqual([]);
  });

  it("「最初から」でも入口へ戻る", async () => {
    const { store, actions } = await ready(noSearch);
    await actions.restart();
    expect(store.getState().consult.entry).toBeNull();
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
    expect(store.getState().consult).toMatchObject({ active: true, entry: null });

    actions.chooseConsultEntry("trip");
    expect(store.getState().consult).toMatchObject({ entry: "trip", step: "party" });
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
    expect(store.getState().consult).toMatchObject({ active: true, entry: "trip", step: "party" });
    expect(store.getState().consult.answers.party?.picks).toEqual(["family"]);
  });

  it("入口を選ばずに書いて送ると、今までの相談として受ける。選び直すと旅行計画の聞き取りを開く", async () => {
    const chat = vi.fn<ChatTransport["chat"]>(async () => {});
    const store = makeStore({ ...instantReplay(), chat });
    const { actions } = store.getState();
    await actions.enterShop();
    await flush();
    await actions.send("来週末に、みなと中央駅から日帰りで");
    expect(chat).toHaveBeenCalledTimes(1);
    expect(store.getState().consult).toMatchObject({ active: false, entry: null });
    actions.reopenConsult();
    expect(store.getState().consult).toMatchObject({ active: true, entry: "trip" });
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

describe("ストア：条件に合う祭りが見つからないとき", () => {
  const retry = { when: { kind: "range" as const, from: "2026-08-22", to: "2026-08-23" } };
  const outcome: SearchOutcome = {
    status: "none",
    excluded: { date: 1, travel: 0, area: 0 },
    nearMisses: [],
    suggestions: [
      {
        kind: "later_dates",
        label: "次の週末（8月22日〜8月23日）で探す",
        retry,
        message: "日程を8月22日〜8月23日に変えて、もう一度祭りを探してください。",
        found: 1,
      },
      { kind: "edit_conditions", label: "条件を選び直す", retry: null, message: null, found: null },
    ],
    attempts: 3,
  };
  const searched = (search: SearchOutcome) =>
    encodeSseEvent({
      type: "tool.end",
      data: {
        toolCallId: "call-1",
        tool: "search_festivals",
        staff: "researcher",
        ok: true,
        bubble: "見つかりませんでした",
        count: 0,
        candidates: [],
        search,
      },
    });
  const done = encodeSseEvent({
    type: "done",
    data: { stage: "candidates", conditions: {}, preferences: { ...DEFAULT_PREFERENCES } },
  });

  function recording(): ChatTransport & { requests: ChatRequest[] } {
    const requests: ChatRequest[] = [];
    return {
      requests,
      startSession: async () => "s-1",
      async chat(request, onMessage) {
        requests.push(request);
        onMessage(searched(outcome));
        onMessage(done);
      },
      updatePreferences: async () => {},
      searchFestivals: noSearch,
      previewFestivalTrip: noPreview,
    };
  }

  it("候補が0件でも窓を開き、次の手を押すと変えた条件を添えて探し直す", async () => {
    const transport = recording();
    const store = makeStore(transport);
    await store.getState().actions.enterShop();
    await store.getState().actions.send("8月16日に日帰りで行ける祭りは？");

    expect(store.getState().candidates).toEqual([]);
    expect(store.getState().search?.status).toBe("none");
    expect(store.getState().ui.candidatesOpen).toBe(true);

    await store.getState().actions.chooseSuggestion(outcome.suggestions[0]!);
    expect(transport.requests[1]).toMatchObject({
      message: "日程を8月22日〜8月23日に変えて、もう一度祭りを探してください。",
      search: retry,
    });
    expect(store.getState().session.lastRequest?.search).toEqual(retry);
  });

  it("「条件を選び直す」は送らずに、選んで進める聞き取りに戻る", async () => {
    const transport = recording();
    const store = makeStore(transport);
    await store.getState().actions.enterShop();
    await store.getState().actions.send("8月16日に日帰りで行ける祭りは？");

    await store.getState().actions.chooseSuggestion(outcome.suggestions[1]!);
    expect(transport.requests).toHaveLength(1);
    expect(store.getState().ui.candidatesOpen).toBe(false);
    expect(store.getState().consult.active).toBe(true);
  });
});
