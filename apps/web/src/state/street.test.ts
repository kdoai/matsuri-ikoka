import {
  encodeGuideSseEvent,
  FestivalSchema,
  type GuideChatRequest,
  type GuideSseEvent,
  type GuideStateResponse,
  type Itinerary,
  ItinerarySchema,
} from "@matsuri-ikoka/schema";
import {
  fictionalFestival,
  fictionalItinerary,
  fictionalSource,
} from "@matsuri-ikoka/schema/testing";
import { describe, expect, it, vi } from "vitest";
import { createReplayTransport } from "../testing/replayTransport";
import type { ChatTransport, OnSseMessage } from "../transport/types";
import { TransportError } from "../transport/types";
import { clearTripWithoutSession } from "../ui/AccountWatch";
import { shioriReady } from "./selectors";
import { createAppStore, LEAD_OUT_MS } from "./store";

// 縁日の通りの流れ。通信の口の代わりを渡して、ストアの状態だけを確かめる。

const itinerary: Itinerary = ItinerarySchema.parse(fictionalItinerary());
const festival = FestivalSchema.parse(fictionalFestival());

function makeStore(overrides: Partial<ChatTransport> = {}) {
  const base = createReplayTransport(
    {
      id: "empty",
      title: "架空",
      description: "架空",
      today: "2026-08-03",
      turns: [],
    },
    { speed: 0 },
  );
  const transport: ChatTransport = {
    ...base,
    startSession: async () => "session-1",
    guideState: async () => ({
      tripId: itinerary.id,
      version: itinerary.version,
      phase: "before",
      watch: null,
      watchAvailable: true,
      notices: [],
      proposals: [],
      memo: [],
    }),
    ...overrides,
  };
  const timers: (() => void)[] = [];
  const store = createAppStore({
    transport,
    festivals: { load: async () => festival, initial: async () => [] },
    setTimer: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimer: () => undefined,
  });
  store.setState((state) => ({
    ...state,
    session: { ...state.session, id: "session-1", status: "ready", stage: "shiori" },
    itinerary: { current: itinerary, previous: null, diff: null },
    verify: { ...state.verify, status: "done", result: "as_planned" },
    ui: { ...state.ui, view: "shop" },
  }));
  return { store, timers };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function streaming(events: GuideSseEvent[]) {
  return vi.fn(async (_request: GuideChatRequest, onMessage: OnSseMessage) => {
    for (const event of events) onMessage(encodeGuideSseEvent(event));
  });
}

describe("店の外へ出る", () => {
  it("先導の動きのあとに通りへ出て、祭りのデータとガイドの通知を読む", async () => {
    const { store, timers } = makeStore();
    expect(LEAD_OUT_MS).toBeGreaterThan(0);
    store.getState().actions.leaveWithGuide(true);
    expect(store.getState().ui.leadingOut).toBe(true);
    expect(store.getState().ui.view).toBe("shop");
    for (const timer of timers.splice(0)) timer();
    await flush();
    const state = store.getState();
    expect(state.ui.view).toBe("street");
    expect(state.ui.leadingOut).toBe(false);
    expect(state.guide.availability).toBe("ready");
    expect(state.festivalLoad[itinerary.mainFestivalId]).toBe("loaded");
  });

  it("2D では待たずに通りへ出る", async () => {
    const { store } = makeStore();
    store.getState().actions.leaveWithGuide();
    await flush();
    expect(store.getState().ui.view).toBe("street");
  });

  it("のれんをくぐっても、しおりのあとなら通りへ出る。しおりの前は店の外観のまま", async () => {
    const { store } = makeStore();
    store.getState().actions.leaveShop();
    await flush();
    expect(store.getState().ui.view).toBe("street");

    const before = makeStore();
    before.store.setState((state) => ({ ...state, verify: { ...state.verify, result: null } }));
    before.store.getState().actions.leaveShop();
    expect(before.store.getState().ui.view).toBe("storefront");
  });

  it("店内へ戻れて、相談はそのまま残る", async () => {
    const { store } = makeStore();
    store.getState().actions.leaveWithGuide();
    await flush();
    await store.getState().actions.returnToShop();
    expect(store.getState().ui.view).toBe("shop");
    expect(store.getState().session.id).toBe("session-1");
    expect(store.getState().itinerary.current?.id).toBe(itinerary.id);
  });

  it("通りで開いたしおりを閉じると、通りへ戻る", async () => {
    const { store } = makeStore();
    store.getState().actions.leaveWithGuide();
    await flush();
    store.getState().actions.openShiori();
    expect(store.getState().ui.view).toBe("shiori");
    store.getState().actions.closeShiori();
    expect(store.getState().ui.view).toBe("street");
  });
});

describe("読み直しと、遅れた応答", () => {
  const empty = {
    tripId: itinerary.id,
    version: 1,
    phase: "before" as const,
    watch: null,
    watchAvailable: true,
    notices: [],
    proposals: [],
    memo: [],
  };

  it("通りへ出るたびに読み直す", async () => {
    const guideState = vi.fn(async () => empty);
    const { store } = makeStore({ guideState });
    store.getState().actions.leaveWithGuide();
    await flush();
    await store.getState().actions.returnToShop();
    store.getState().actions.leaveWithGuide();
    await flush();
    expect(guideState).toHaveBeenCalledTimes(2);
  });

  it("別の相談に変わったあとに届いた応答を入れない", async () => {
    const pending: ((value: GuideStateResponse) => void)[] = [];
    const { store } = makeStore({
      guideState: () => new Promise((resolve) => pending.push(resolve)),
    });
    store.getState().actions.leaveWithGuide();
    await flush();
    store.setState((state) => ({ ...state, session: { ...state.session, id: "session-new" } }));
    pending[0]?.({ ...empty, phase: "after" });
    await flush();
    expect(store.getState().guide.phase).toBeNull();
  });

  it("先導の間にしおりを開いたら、残ったタイマーで通りへ移らない", async () => {
    const { store, timers } = makeStore();
    store.getState().actions.leaveWithGuide(true);
    store.getState().actions.openShiori();
    for (const timer of timers.splice(0)) timer();
    await flush();
    expect(store.getState().ui.view).toBe("shiori");
    expect(store.getState().ui.leadingOut).toBe(false);
  });
});

describe("合言葉を入れ直す", () => {
  it("通りでは店内の前の発言を送らず、ガイドの知らせを読み直す", async () => {
    const chat = vi.fn(async () => undefined);
    const guideState = vi.fn(async () => {
      throw new TransportError("unauthorized", { status: 401 });
    });
    const { store } = makeStore({ chat, guideState });
    store.setState((state) => ({
      ...state,
      session: {
        ...state.session,
        lastRequest: { message: "店内の前の発言", preferences: state.preferences },
      },
    }));
    store.getState().actions.leaveWithGuide();
    await flush();
    expect(store.getState().auth.needed).toBe(true);
    await store.getState().actions.submitPasscode("example-pass");
    expect(chat).not.toHaveBeenCalled();
    expect(guideState).toHaveBeenCalledTimes(2);
  });

  it("発言の途中で断られたなら、その発言を送り直す", async () => {
    let calls = 0;
    const guideChat = vi.fn(async (_request: GuideChatRequest, onMessage: OnSseMessage) => {
      calls += 1;
      if (calls === 1) throw new TransportError("unauthorized", { status: 401 });
      onMessage(
        encodeGuideSseEvent({
          type: "guide.done",
          data: { phase: "before", unreadNotices: 0, pendingProposals: 0 },
        }),
      );
    });
    const { store } = makeStore({ guideChat });
    store.getState().actions.leaveWithGuide();
    await flush();
    await store.getState().actions.sendGuide("持ち物は");
    await store.getState().actions.submitPasscode("example-pass");
    expect(guideChat).toHaveBeenCalledTimes(2);
    expect(guideChat.mock.calls[1]?.[0].message).toBe("持ち物は");
  });
});

describe("ログアウト", () => {
  it("相談の ID がなく、前の人の旅が手元にあれば、消して新しい相談から始める", async () => {
    const { store } = makeStore({
      openSavedTrip: async () => ({ sessionId: null, itinerary }),
    });
    await store.getState().actions.openSavedTrip(itinerary.id);
    await flush();
    store.getState().actions.openStall("food");
    clearTripWithoutSession(store);
    await flush();
    const state = store.getState();
    expect(state.ui.view).toBe("shop");
    expect(state.itinerary.current).toBeNull();
    expect(state.guide.availability).toBe("idle");
    expect(state.guide.openStall).toBeNull();
  });

  it("相談の ID があるときは触らない（useRestartWhenUserLeaves が受け持つ）", async () => {
    const { store } = makeStore();
    clearTripWithoutSession(store);
    await flush();
    expect(store.getState().itinerary.current?.id).toBe(itinerary.id);
  });

  it("通りを開いていても、新しい相談から始めれば、旅と通知と会話は残らない", async () => {
    const { store } = makeStore();
    store.getState().actions.leaveWithGuide();
    await flush();
    store.getState().actions.openStall("food");
    await store.getState().actions.restart();
    const state = store.getState();
    expect(state.ui.view).toBe("shop");
    expect(state.itinerary.current).toBeNull();
    expect(state.guide.notices).toEqual([]);
    expect(state.guide.entries).toEqual([]);
    expect(state.guide.openStall).toBeNull();
  });
});

describe("ガイドがいない環境", () => {
  it("404 なら話せない状態にして、通りと屋台はそのまま使える", async () => {
    const { store } = makeStore({
      guideState: async () => {
        throw new TransportError("bad_request", { status: 404 });
      },
    });
    store.getState().actions.leaveWithGuide();
    await flush();
    const state = store.getState();
    expect(state.ui.view).toBe("street");
    expect(state.guide.availability).toBe("unavailable");
    state.actions.openStall("etiquette");
    expect(store.getState().guide.openStall).toBe("etiquette");
  });

  it("一時的な失敗は、もう一度読める", async () => {
    let calls = 0;
    const { store } = makeStore({
      guideState: async () => {
        calls += 1;
        if (calls === 1) throw new TransportError("upstream_unavailable", { status: 503 });
        return {
          tripId: itinerary.id,
          version: 1,
          phase: "before",
          watch: null,
          watchAvailable: true,
          notices: [],
          proposals: [],
          memo: [],
        };
      },
    });
    store.getState().actions.leaveWithGuide();
    await flush();
    expect(store.getState().guide.availability).toBe("failed");
    await store.getState().actions.loadGuide(true);
    expect(store.getState().guide.availability).toBe("ready");
  });
});

describe("ガイドとの相談", () => {
  async function onStreet(overrides: Partial<ChatTransport> = {}) {
    const made = makeStore(overrides);
    made.store.getState().actions.leaveWithGuide();
    await flush();
    return made;
  }

  it("返答のイベントをストアの更新に変える", async () => {
    const guideChat = streaming([
      { type: "message.delta", data: { messageId: "m", text: "持っていきましょう。" } },
      { type: "guide.done", data: { phase: "before", unreadNotices: 0, pendingProposals: 0 } },
    ]);
    const { store } = await onStreet({ guideChat });
    await store.getState().actions.sendGuide("  傘は要りますか  ");
    expect(guideChat.mock.calls[0]?.[0]).toEqual({
      sessionId: "session-1",
      message: "傘は要りますか",
    });
    const { guide } = store.getState();
    expect(guide.streaming).toBe(false);
    expect(guide.entries.map((entry) => entry.kind)).toEqual(["user", "guide"]);
  });

  it("guide.done が来ないまま閉じたら、もう一度送れるようにする", async () => {
    const { store } = await onStreet({ guideChat: streaming([]) });
    await store.getState().actions.sendGuide("持ち物は");
    const { guide } = store.getState();
    expect(guide.streaming).toBe(false);
    expect(guide.entries.at(-1)).toMatchObject({ kind: "error", retryable: true });
  });

  it("形の違うイベントは反映しない", async () => {
    const guideChat = vi.fn(async (_request: GuideChatRequest, onMessage: OnSseMessage) => {
      onMessage({ event: "message.delta", data: JSON.stringify({ text: "<b>x</b>" }) });
    });
    const { store } = await onStreet({ guideChat });
    await store.getState().actions.sendGuide("持ち物は");
    const { guide } = store.getState();
    expect(guide.entries.some((entry) => entry.kind === "guide")).toBe(false);
    expect(guide.entries.at(-1)).toMatchObject({ kind: "error", code: "invalid_event" });
  });

  it("読み込みの最中も、相談を送れる", async () => {
    const guideChat = streaming([
      { type: "guide.done", data: { phase: "during", unreadNotices: 0, pendingProposals: 0 } },
    ]);
    const { store } = await onStreet({
      guideChat,
      guideState: () => new Promise(() => undefined),
    });
    expect(store.getState().guide.availability).toBe("loading");
    await store.getState().actions.sendGuide("持ち物は");
    expect(guideChat).toHaveBeenCalledOnce();
  });

  it("発言が 404 で断られたら、話せない状態にして、続け方を案内する", async () => {
    const { store } = await onStreet({
      guideChat: async () => {
        throw new TransportError("bad_request", { status: 404, message: "相談が見つかりません。" });
      },
    });
    await store.getState().actions.sendGuide("持ち物は");
    const { guide } = store.getState();
    expect(guide.availability).toBe("unavailable");
    expect(guide.entries.at(-1)).toMatchObject({ kind: "error", code: "guide_gone" });
  });

  it("前の返事を作っている途中の 409 では、話せる状態のまま、送り直せる", async () => {
    const { store } = await onStreet({
      guideChat: async () => {
        throw new TransportError("bad_request", {
          status: 409,
          message: "前の返事を作っています。少し待ってから送ってください。",
          retryable: true,
        });
      },
    });
    await store.getState().actions.sendGuide("持ち物は");
    const { guide } = store.getState();
    expect(guide.availability).toBe("ready");
    expect(guide.entries.at(-1)).toMatchObject({ kind: "error", retryable: true });
    expect(guide.entries.at(-1)).not.toMatchObject({ code: "guide_gone" });
  });

  it("送り直せない 409 では、話せない状態にする", async () => {
    const { store } = await onStreet({
      guideChat: async () => {
        throw new TransportError("bad_request", {
          status: 409,
          message: "まだ旅程がありません。",
          retryable: false,
        });
      },
    });
    await store.getState().actions.sendGuide("持ち物は");
    expect(store.getState().guide.availability).toBe("unavailable");
  });

  it("返答の途中で店へ戻っても、受け取り中の印を残さない", async () => {
    const guideChat = vi.fn(
      (_request: GuideChatRequest, onMessage: OnSseMessage, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          onMessage(
            encodeGuideSseEvent({ type: "message.delta", data: { messageId: "m", text: "はい" } }),
          );
          signal.addEventListener("abort", () => reject(new DOMException("中止", "AbortError")));
        }),
    );
    const { store } = await onStreet({ guideChat });
    const sending = store.getState().actions.sendGuide("持ち物は");
    await flush();
    await store.getState().actions.returnToShop();
    await sending;
    const { guide } = store.getState();
    expect(guide.streaming).toBe(false);
    expect(guide.entries.at(-1)).toMatchObject({ kind: "guide", streaming: false });
  });
});

describe("通知から屋台へ", () => {
  const notice = {
    id: "n1",
    tripId: itinerary.id,
    fingerprint: "b".repeat(16),
    content: { kind: "weather", date: "2026-08-16", condition: "rain", precipitationPercent: 70 },
    sources: [
      { url: "https://example.com/weather", checkedAt: "2026-08-10", confidence: "official" },
    ],
    checkedAt: "2026-08-10T06:00:00+09:00",
    summary: "雨の予報です",
    affectedItemIds: [],
    proposalId: null,
    createdAt: "2026-08-10T06:01:00+09:00",
    readAt: null,
  } as const;
  const withNotice = {
    guideState: async () => ({
      tripId: itinerary.id,
      version: 1,
      phase: "before" as const,
      watch: null,
      watchAvailable: true,
      notices: [{ ...notice, sources: [...notice.sources], affectedItemIds: [] }],
      proposals: [],
      memo: [],
    }),
  };

  it("駆け寄って報告し、案内を頼むと旗でその屋台へ行き、着いて開くと提灯が消える", async () => {
    const markNoticesRead = vi.fn(async () => undefined);
    const { store } = makeStore({ ...withNotice, markNoticesRead });
    store.getState().actions.leaveWithGuide();
    await flush();
    expect(store.getState().guide).toMatchObject({
      report: "n1",
      spot: "player",
      dialogueOpen: true,
    });

    // 3D を描けているなら、旅人が歩いて着くまで屋台は開かない
    store.getState().actions.setStreetScene(true);
    store.getState().actions.leadToStall("weather");
    expect(store.getState().guide).toMatchObject({
      report: null,
      spot: "weather",
      openStall: null,
      lead: { stall: "weather", seq: 1, done: false },
    });
    store.getState().actions.openStall("weather");
    const { guide } = store.getState();
    expect(guide.openStall).toBe("weather");
    expect(guide.notices[0]?.readAt).not.toBeNull();
    expect(markNoticesRead).toHaveBeenCalledWith({ sessionId: "session-1", noticeIds: ["n1"] });
  });

  it("歩いている途中で 3D が描けなくなったら、屋台を開く", async () => {
    const { store } = makeStore(withNotice);
    store.getState().actions.leaveWithGuide();
    await flush();
    store.getState().actions.setStreetScene(true);
    store.getState().actions.leadToStall("weather");
    expect(store.getState().guide.openStall).toBeNull();
    store.getState().actions.setStreetScene(false);
    expect(store.getState().guide.openStall).toBe("weather");
    expect(store.getState().guide.lead?.done).toBe(true);
  });

  it("未読が2件でも、開いた屋台に次の報告を重ねず、閉じてから報告する", async () => {
    const second = {
      ...notice,
      id: "n2",
      content: {
        kind: "availability",
        lodgingName: "架空の宿",
        checkIn: "2026-08-15",
        checkOut: "2026-08-16",
        available: false,
        nightlyTotalYen: null,
        bookingUrl: null,
      },
      summary: "宿の空きがなくなりました",
    } as const;
    const { store } = makeStore({
      guideState: async () => ({
        tripId: itinerary.id,
        version: 1,
        phase: "before" as const,
        watch: null,
        watchAvailable: true,
        notices: [notice, second].map((item) => ({
          ...item,
          sources: [...item.sources],
          affectedItemIds: [],
        })),
        proposals: [],
        memo: [],
      }),
    });
    store.getState().actions.leaveWithGuide();
    await flush();
    expect(store.getState().guide.report).toBe("n1");
    store.getState().actions.leadToStall("weather");
    expect(store.getState().guide).toMatchObject({
      openStall: "weather",
      report: null,
      dialogueOpen: false,
    });
    store.getState().actions.closeStall();
    expect(store.getState().guide).toMatchObject({ report: "n2", dialogueOpen: true });
  });

  it("2D では案内を頼むとすぐに屋台を開く", async () => {
    const { store } = makeStore(withNotice);
    store.getState().actions.leaveWithGuide();
    await flush();
    store.getState().actions.leadToStall("weather");
    expect(store.getState().guide.openStall).toBe("weather");
  });

  it("読んだことを知らせられなくても、画面では読んだままにする", async () => {
    const { store } = makeStore({
      ...withNotice,
      markNoticesRead: async () => {
        throw new TransportError("bad_request", { status: 404 });
      },
    });
    store.getState().actions.leaveWithGuide();
    await flush();
    store.getState().actions.openStall("weather");
    await flush();
    expect(store.getState().guide.notices[0]?.readAt).not.toBeNull();
  });
});

describe("残した旅を開く", () => {
  it("通りに戻り、相談と旅程を入れる", async () => {
    const { store } = makeStore({
      openSavedTrip: async () => ({ sessionId: "session-2", itinerary }),
    });
    expect(await store.getState().actions.openSavedTrip(itinerary.id)).toBe(true);
    await flush();
    const state = store.getState();
    expect(state.ui.view).toBe("street");
    expect(state.session.id).toBe("session-2");
    expect(state.itinerary.current?.id).toBe(itinerary.id);
    expect(state.guide.availability).toBe("ready");
  });

  it("確認の結果を旅程から入れ、しおりを開けて、前の相談を残さない", async () => {
    const confirmed = ItinerarySchema.parse({
      ...fictionalItinerary(),
      verification: {
        status: "as_planned",
        checkedAt: "2026-08-10T06:00:00+09:00",
        sources: [fictionalSource("schedule")],
      },
    });
    const { store } = makeStore({
      openSavedTrip: async () => ({ sessionId: "session-2", itinerary: confirmed }),
    });
    store.setState((state) => ({
      ...state,
      messages: [{ kind: "user", id: "u1", text: "前の人の発言" }],
      verify: { ...state.verify, result: "changed" },
      ui: { ...state.ui, view: "storefront" },
    }));
    await store.getState().actions.openSavedTrip(confirmed.id);
    await flush();
    const state = store.getState();
    expect(state.messages).toEqual([]);
    expect(state.verify.result).toBe("as_planned");
    expect(shioriReady(state)).toBe(true);
    // のれんをくぐっても通りへ出る
    state.actions.returnToShop();
    store.getState().actions.leaveShop();
    expect(store.getState().ui.view).toBe("street");
  });

  it("店内の返答の途中でも、前の通信を止める", async () => {
    let aborted = false;
    const chat: ChatTransport["chat"] = (_request, _onMessage, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("中止", "AbortError"));
        });
      });
    const { store } = makeStore({
      chat,
      openSavedTrip: async () => ({ sessionId: "session-2", itinerary }),
    });
    void store.getState().actions.send("店内の発言");
    await flush();
    await store.getState().actions.openSavedTrip(itinerary.id);
    await flush();
    expect(aborted).toBe(true);
    expect(store.getState().session.id).toBe("session-2");
    expect(store.getState().session.streaming).toBe(false);
  });

  it("ガイドのない環境でも、屋台の情報は読める", async () => {
    const { store } = makeStore({
      openSavedTrip: async () => ({ sessionId: null, itinerary }),
    });
    await store.getState().actions.openSavedTrip(itinerary.id);
    await flush();
    expect(store.getState().guide.availability).toBe("unavailable");
    expect(store.getState().ui.view).toBe("street");
  });

  it("開けなければ false を返し、画面は変えない", async () => {
    const { store } = makeStore({
      openSavedTrip: async () => {
        throw new TransportError("bad_request", { status: 404 });
      },
    });
    expect(await store.getState().actions.openSavedTrip("trip-none")).toBe(false);
    expect(store.getState().ui.view).toBe("shop");
  });
});

describe("通知・見回り・提案の決定", () => {
  const next: Itinerary = { ...itinerary, version: itinerary.version + 1 };
  const proposal = {
    id: "proposal-1",
    tripId: itinerary.id,
    status: "pending" as const,
    noticeIds: [],
    summary: "会場に着く時間を遅らせます",
    baseVersion: itinerary.version,
    contentHash: "a".repeat(64),
    itinerary: next,
    diff: {
      fromVersion: itinerary.version,
      toVersion: next.version,
      added: [],
      changed: ["festival"],
      removed: [],
    },
    createdAt: "2026-08-10T06:06:00+09:00",
    expiresAt: "2026-08-15T00:00:00+09:00",
    decidedAt: null,
  };
  const watch = {
    tripId: itinerary.id,
    status: "active" as const,
    startedAt: "2026-08-03T10:00:00+09:00",
    endsOn: "2026-08-17",
    stoppedAt: null,
    lastCheckedAt: null,
  };
  const stateWith = (over: Partial<GuideStateResponse> = {}): GuideStateResponse => ({
    tripId: itinerary.id,
    version: itinerary.version,
    phase: "before",
    watch,
    watchAvailable: true,
    notices: [],
    proposals: [proposal],
    memo: [],
    ...over,
  });

  it("承認すると、版が増えた旅程と差分を入れ、提案を外し、前の版に戻せる", async () => {
    let current = stateWith();
    const decideProposal = vi.fn(async () => {
      current = stateWith({ version: next.version, proposals: [] });
      return { outcome: "applied" as const, change: { itinerary: next, diff: proposal.diff } };
    });
    const reverted: Itinerary = { ...itinerary, version: next.version + 1 };
    const revertTrip = vi.fn(async () => ({
      itinerary: reverted,
      diff: { ...proposal.diff, fromVersion: next.version, toVersion: reverted.version },
    }));
    const { store } = makeStore({ guideState: async () => current, decideProposal, revertTrip });
    await store.getState().actions.loadGuide(true);

    await store.getState().actions.decideProposal("proposal-1", "approve");

    expect(decideProposal).toHaveBeenCalledWith("proposal-1", {
      decision: "approve",
      sessionId: "session-1",
      baseVersion: proposal.baseVersion,
      contentHash: proposal.contentHash,
    });
    let state = store.getState();
    expect(state.itinerary.current?.version).toBe(next.version);
    expect(state.itinerary.diff).toEqual(proposal.diff);
    expect(state.guide).toMatchObject({
      version: next.version,
      proposals: [],
      busy: null,
      outcome: { kind: "applied" },
      revertTo: itinerary.version,
    });
    // 屋台の窓を閉じて結果の文が消えても、戻せる版は残る
    store.getState().actions.openStall("headquarters");
    store.getState().actions.closeStall();
    expect(store.getState().guide).toMatchObject({ outcome: null, revertTo: itinerary.version });

    await store.getState().actions.revertGuideChange();

    expect(revertTrip).toHaveBeenCalledWith({
      sessionId: "session-1",
      toVersion: itinerary.version,
    });
    state = store.getState();
    expect(state.itinerary.current?.version).toBe(reverted.version);
    expect(state.guide).toMatchObject({ outcome: { kind: "reverted" }, revertTo: null });
  });

  it("提案のあとに旅程が変わっていたら、旅程を変えずに知らせる", async () => {
    const decideProposal = vi.fn(async () => ({
      outcome: "stale" as const,
      currentVersion: itinerary.version + 1,
    }));
    const { store } = makeStore({ guideState: async () => stateWith(), decideProposal });
    await store.getState().actions.loadGuide(true);

    await store.getState().actions.decideProposal("proposal-1", "approve");

    const state = store.getState();
    expect(state.itinerary.current?.version).toBe(itinerary.version);
    expect(state.guide.outcome).toEqual({ kind: "stale" });
  });

  it("断ると提案を外し、送れなければ結果に出して、もう一度押せる", async () => {
    const decideProposal = vi
      .fn()
      .mockRejectedValueOnce(new TransportError("upstream_unavailable", { status: 503 }))
      .mockResolvedValueOnce({ outcome: "rejected" });
    const { store } = makeStore({ guideState: async () => stateWith(), decideProposal });
    await store.getState().actions.loadGuide(true);

    await store.getState().actions.decideProposal("proposal-1", "reject");
    expect(store.getState().guide).toMatchObject({
      busy: null,
      outcome: { kind: "failed" },
    });
    await flush();

    await store.getState().actions.decideProposal("proposal-1", "reject");
    expect(decideProposal).toHaveBeenLastCalledWith("proposal-1", {
      decision: "reject",
      sessionId: "session-1",
    });
    expect(store.getState().guide).toMatchObject({ proposals: [], outcome: { kind: "rejected" } });
  });

  it("送っている間に別の相談へ移ったら、届いた応答の旅程を入れない", async () => {
    let answer: (value: unknown) => void = () => undefined;
    const decideProposal = vi.fn(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    ) as unknown as NonNullable<ChatTransport["decideProposal"]>;
    const { store } = makeStore({ guideState: async () => stateWith(), decideProposal });
    await store.getState().actions.loadGuide(true);

    const pending = store.getState().actions.decideProposal("proposal-1", "approve");
    store.setState((state) => ({ ...state, session: { ...state.session, id: "session-2" } }));
    answer({ outcome: "applied", change: { itinerary: next, diff: proposal.diff } });
    await pending;

    expect(store.getState().itinerary.current?.version).toBe(itinerary.version);
  });

  it("ガイドが返事を流している間は、承認を送らない。見回りが動かない環境と分かる", async () => {
    const decideProposal = vi.fn();
    const { store } = makeStore({
      guideState: async () => stateWith({ watchAvailable: false }),
      decideProposal,
    });
    await store.getState().actions.loadGuide(true);
    expect(store.getState().guide.watchAvailable).toBe(false);
    store.setState((state) => ({ ...state, guide: { ...state.guide, streaming: true } }));

    await store.getState().actions.decideProposal("proposal-1", "approve");

    expect(decideProposal).not.toHaveBeenCalled();
    expect(store.getState().guide.busy).toBeNull();
  });

  it("見回りを止めると、依頼の状態を入れる", async () => {
    const stopped = {
      ...watch,
      status: "stopped" as const,
      stoppedAt: "2026-08-10T09:00:00+09:00",
    };
    const setTripWatch = vi.fn(async () => stopped);
    const { store } = makeStore({ guideState: async () => stateWith(), setTripWatch });
    await store.getState().actions.loadGuide(true);
    expect(store.getState().guide.watch?.status).toBe("active");

    await store.getState().actions.setGuideWatch("stop");

    expect(setTripWatch).toHaveBeenCalledWith({ sessionId: "session-1", action: "stop" });
    expect(store.getState().guide.watch).toEqual(stopped);
  });

  it("既読の応答の未読の数が手元と違えば（上限で押し出された通知がある）、読み直す", async () => {
    const notice = {
      id: "n1",
      tripId: itinerary.id,
      fingerprint: "b".repeat(16),
      content: {
        kind: "weather" as const,
        date: "2026-08-16",
        condition: "rain" as const,
        precipitationPercent: 70,
      },
      sources: [
        { url: "https://example.com/weather", checkedAt: "2026-08-10", confidence: "official" },
      ],
      checkedAt: "2026-08-10T06:00:00+09:00",
      summary: "雨の予報です",
      affectedItemIds: [],
      proposalId: null,
      createdAt: "2026-08-10T06:01:00+09:00",
      readAt: null,
    } as const;
    const guideState = vi.fn(async () =>
      stateWith({
        proposals: [],
        notices: [{ ...notice, sources: [...notice.sources], affectedItemIds: [] }],
      }),
    );
    const markNoticesRead = vi.fn(async () => ({ unread: 1 }));
    const { store } = makeStore({ guideState, markNoticesRead });
    await store.getState().actions.loadGuide(true);

    store.getState().actions.openStall("weather");
    await flush();

    expect(guideState).toHaveBeenCalledTimes(2);
  });
});
