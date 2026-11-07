import {
  encodeGuideSseEvent,
  FestivalSchema,
  type GuideChatRequest,
  type GuideSseEvent,
  type Itinerary,
  ItinerarySchema,
} from "@matsuri-ikoka/schema";
import { fictionalFestival, fictionalItinerary } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it, vi } from "vitest";
import { createReplayTransport } from "../testing/replayTransport";
import type { ChatTransport, OnSseMessage } from "../transport/types";
import { TransportError } from "../transport/types";
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

  it("話せない状態では送らない", async () => {
    const guideChat = streaming([]);
    const { store } = await onStreet({
      guideChat,
      guideState: async () => {
        throw new TransportError("bad_request", { status: 404 });
      },
    });
    await store.getState().actions.sendGuide("持ち物は");
    expect(guideChat).not.toHaveBeenCalled();
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

    // 3D では、旅人が歩いて着くまで屋台は開かない
    store.getState().actions.leadToStall("weather", true);
    expect(store.getState().guide).toMatchObject({
      report: null,
      spot: "weather",
      openStall: null,
      lead: { stall: "weather", seq: 1 },
    });
    store.getState().actions.openStall("weather");
    const { guide } = store.getState();
    expect(guide.openStall).toBe("weather");
    expect(guide.notices[0]?.readAt).not.toBeNull();
    expect(markNoticesRead).toHaveBeenCalledWith({ sessionId: "session-1", noticeIds: ["n1"] });
  });

  it("2D では案内を頼むとすぐに屋台を開く", async () => {
    const { store } = makeStore(withNotice);
    store.getState().actions.leaveWithGuide();
    await flush();
    store.getState().actions.leadToStall("weather", false);
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
