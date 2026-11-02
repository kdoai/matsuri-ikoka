import {
  type FestivalCandidate,
  type SampleConversation,
  SampleConversationSchema,
  type SseEvent,
} from "@matsuri-ikoka/schema";
import { fictionalItinerary, fictionalSource } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import sampleJson from "../../../../data/samples/conversations/suzunari-day-trip.json";
import { applyEvent } from "./events";
import { initialData } from "./initial";
import { allQuestsDone, itemChange, shioriReady } from "./selectors";
import { beginTurn, endTurn, settleStaff } from "./transitions";
import type { AppData } from "./types";

const sample: SampleConversation = SampleConversationSchema.parse(sampleJson);

function fresh(): AppData {
  const state = initialData({ transport: "mock" });
  return { ...state, session: { ...state.session, id: "s-1", status: "ready" } };
}

function apply(state: AppData, events: readonly SseEvent[]): AppData {
  return events.reduce(applyEvent, state);
}

/** 記録した相談の発言を、送る → イベント → 閉じる の順に通す */
function playTurns(count: number): AppData {
  let state = fresh();
  for (const turn of sample.turns.slice(0, count)) {
    state = beginTurn(state, { kind: "chat", ...turn.request });
    state = apply(
      state,
      turn.events.map((recorded) => recorded.event),
    );
    state = endTurn(state, null);
  }
  return state;
}

const candidate: FestivalCandidate = {
  festivalId: "suzunari-toro",
  name: "鈴鳴灯籠まつり",
  date: "2026-08-16",
  start: "18:30",
  end: "21:00",
  venueName: "鈴鳴川の河原",
  place: "滋賀県鈴鳴町",
  daysFromWish: 0,
  confidence: "official",
  confirmed: true,
  highlight: "川面に浮かぶ千の灯籠",
  source: fictionalSource("2026"),
};

describe("記録した相談を通す", () => {
  it("候補を出すと、条件・こだわり・候補カードが更新される", () => {
    const state = playTurns(1);
    expect(state.session.stage).toBe("candidates");
    expect(state.session.conditions.origin).toBe("みなと中央駅");
    // 会話で「人の少ないところ」「地元のごはん」と言ったので、こだわりが切り替わる
    expect(state.preferences).toEqual({
      party: "adults",
      spot: "hidden",
      food: "local",
      move: "train",
    });
    expect(state.candidates.map((c) => c.festivalId)).toEqual([
      "suzunari-toro",
      "kazami-bon-odori",
    ]);
    expect(state.ui.candidatesOpen).toBe(true);
    expect(state.quests.festivals).toMatchObject({ status: "done", completions: 1 });
    expect(state.quests.nearby.status).toBe("todo");
  });

  it("返答の続きは1つの吹き出しにつながり、done で閉じる", () => {
    const state = playTurns(1);
    const replies = state.messages.filter((entry) => entry.kind === "concierge");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ streaming: false });
    expect(replies[0]?.kind === "concierge" && replies[0].text).toContain("どちらにしますか。");
  });

  it("作業の記録は、ツールの開始と終了で1行になる", () => {
    const state = playTurns(1);
    const work = state.messages.filter((entry) => entry.kind === "work");
    expect(work).toEqual([
      {
        kind: "work",
        id: "w-call-1",
        staff: "researcher",
        tool: "search_festivals",
        status: "ok",
        bubble: "8月16日に、みなと中央駅から日帰りで行ける祭りを探しています",
        result: "2件見つかりました",
      },
    ]);
  });

  it("初版の旅程では、どの予定にも色を付けない", () => {
    const state = playTurns(2);
    const itinerary = state.itinerary.current!;
    expect(itinerary.version).toBe(1);
    expect(itinerary.items.map((item) => itemChange(state, item))).toEqual(
      itinerary.items.map(() => null),
    );
    expect(state.spots).toHaveLength(4);
    expect(state.ui.candidatesOpen).toBe(false);
    expect(state.quests.nearby.status).toBe("done");
    expect(state.quests.route).toMatchObject({ status: "done", completions: 1 });
    expect(state.quests.route.finished).toEqual(["get_access", "get_weather", "update_itinerary"]);
  });

  it("修正すると、差分に載った予定だけに色が付く", () => {
    const state = playTurns(3);
    const itinerary = state.itinerary.current!;
    expect(itinerary.version).toBe(2);
    expect(state.itinerary.previous?.version).toBe(1);
    const changes = Object.fromEntries(
      itinerary.items.map((item) => [item.id, itemChange(state, item)]),
    );
    expect(changes).toMatchObject({
      "craft-hall": "added",
      riverside: "changed",
      apply: "changed",
      go: null,
      festival: null,
    });
    expect(state.quests.route.completions).toBe(2);
  });

  it("再確認が通ると、しおりが開けるようになり、完成の演出が始まる", () => {
    const state = playTurns(4);
    expect(state.verify).toMatchObject({
      status: "done",
      result: "as_planned",
      festivalId: "suzunari-toro",
    });
    expect(state.session.stage).toBe("shiori");
    expect(shioriReady(state)).toBe(true);
    expect(allQuestsDone(state)).toBe(true);
    expect(state.ui.celebrating).toBe(true);
  });
});

describe("スタッフの動き", () => {
  it("持ち場へ歩く → 作業 → うなずく → ほかの人が動くと戻る → 待機", () => {
    let state = beginTurn(fresh(), {
      kind: "chat",
      message: "鈴鳴灯籠まつりにします。",
      preferences: fresh().preferences,
    });
    state = applyEvent(state, {
      type: "staff.start",
      data: { staff: "scout", task: "find_nearby", bubble: "寄り道を探してきます" },
    });
    expect(state.staff.scout).toMatchObject({
      phase: "walking",
      motion: "walk",
      task: "find_nearby",
      bubble: "寄り道を探してきます",
    });

    state = applyEvent(state, {
      type: "tool.start",
      data: { toolCallId: "c-1", tool: "search_nearby", staff: "scout", bubble: "探しています" },
    });
    expect(state.staff.scout).toMatchObject({
      phase: "working",
      motion: "point",
      tool: "search_nearby",
    });
    expect(state.quests.nearby.status).toBe("active");

    const seqBeforeNod = state.staff.scout.seq;
    state = applyEvent(state, {
      type: "tool.end",
      data: {
        toolCallId: "c-1",
        tool: "search_nearby",
        staff: "scout",
        ok: true,
        bubble: "4か所見つかりました",
        count: 4,
      },
    });
    expect(state.staff.scout).toMatchObject({ phase: "working", motion: "nod", tool: null });
    expect(state.staff.scout.seq).toBeGreaterThan(seqBeforeNod);

    state = applyEvent(state, {
      type: "staff.start",
      data: { staff: "planner", task: "plan_route", bubble: "道のりを調べます" },
    });
    expect(state.staff.scout.phase).toBe("returning");
    expect(state.staff.planner.phase).toBe("walking");

    state = applyEvent(state, {
      type: "done",
      data: { stage: "itinerary", conditions: {}, preferences: fresh().preferences },
    });
    expect(state.staff.planner.phase).toBe("returning");
    expect(state.staff.concierge.phase).toBe("idle");

    state = settleStaff(state);
    expect(state.staff.scout).toMatchObject({ phase: "idle", motion: "idle", bubble: null });
    expect(state.staff.planner.phase).toBe("idle");
  });

  it("返答を話している間、コンシェルジュは話す動きになる", () => {
    const state = applyEvent(fresh(), {
      type: "message.delta",
      data: { messageId: "m-1", text: "こんにちは" },
    });
    expect(state.staff.concierge.motion).toBe("talk");
  });

  it("再確認ではコンシェルジュがはんこを押す", () => {
    let state = applyEvent(fresh(), {
      type: "tool.start",
      data: { toolCallId: "v", tool: "verify_festival", staff: "concierge", bubble: "確かめます" },
    });
    expect(state.verify.status).toBe("checking");
    state = applyEvent(state, {
      type: "festival.verified",
      data: {
        festivalId: "suzunari-toro",
        result: "as_planned",
        checkedAt: "2026-08-03T10:00:00+09:00",
        sources: [fictionalSource("2026")],
      },
    });
    expect(state.staff.concierge.motion).toBe("stamp");
  });
});

describe("旅程", () => {
  it("旅程が持っている再確認の結果を、再確認の状態にする（同じ祭り・同じ日なら引き継がれる）", () => {
    const verified = {
      ...fictionalItinerary(),
      version: 2,
      verification: {
        status: "as_planned" as const,
        checkedAt: "2026-08-03T10:00:00+09:00",
        sources: [fictionalSource("2026")],
      },
    };
    let state = applyEvent(fresh(), {
      type: "itinerary.updated",
      data: {
        itinerary: verified,
        diff: { fromVersion: 1, toVersion: 2, added: [], changed: ["go"], removed: [] },
      },
    });
    expect(state.verify).toMatchObject({
      status: "done",
      result: "as_planned",
      festivalId: verified.mainFestivalId,
      checkedAt: "2026-08-03T10:00:00+09:00",
    });

    state = applyEvent(state, {
      type: "itinerary.updated",
      data: {
        itinerary: { ...verified, version: 3, verification: { status: "pending" } },
        diff: { fromVersion: 2, toVersion: 3, added: [], changed: [], removed: [] },
      },
    });
    expect(state.verify).toMatchObject({ status: "idle", result: null });
  });

  it("再確認の済んでいない旅程が届いたら、前の再確認は使わない", () => {
    let state = fresh();
    state = {
      ...state,
      verify: { ...state.verify, status: "done", result: "as_planned" },
    };
    const itinerary = fictionalItinerary();
    state = applyEvent(state, {
      type: "itinerary.updated",
      data: {
        itinerary,
        diff: { fromVersion: 0, toVersion: 1, added: ["go"], changed: [], removed: [] },
      },
    });
    expect(state.verify.status).toBe("idle");
    expect(state.verify.result).toBeNull();
    expect(state.ui.tab).toBe("itinerary");
    expect(state.staff.planner.motion).toBe("carry");
  });

  it("2版目が届いても、開いているタブは変えない", () => {
    const itinerary = fictionalItinerary();
    let state = applyEvent(fresh(), {
      type: "itinerary.updated",
      data: {
        itinerary,
        diff: { fromVersion: 0, toVersion: 1, added: [], changed: [], removed: [] },
      },
    });
    state = { ...state, ui: { ...state.ui, tab: "map" } };
    state = applyEvent(state, {
      type: "itinerary.updated",
      data: {
        itinerary: { ...itinerary, version: 2 },
        diff: {
          fromVersion: 1,
          toVersion: 2,
          added: [],
          changed: ["go"],
          removed: [{ id: "x", name: "消えた予定" }],
        },
      },
    });
    expect(state.ui.tab).toBe("map");
    expect(state.itinerary.diff?.removed).toEqual([{ id: "x", name: "消えた予定" }]);
  });
});

describe("候補", () => {
  it("新しい検索の結果で候補を置き換える", () => {
    const first = applyEvent(fresh(), {
      type: "tool.end",
      data: {
        toolCallId: "a",
        tool: "search_festivals",
        staff: "researcher",
        ok: true,
        bubble: "1件見つかりました",
        count: 1,
        candidates: [candidate],
      },
    });
    expect(first.candidates).toHaveLength(1);
    const second = applyEvent(first, {
      type: "tool.end",
      data: {
        toolCallId: "b",
        tool: "search_festivals",
        staff: "researcher",
        ok: true,
        bubble: "見つかりませんでした",
        count: 0,
        candidates: [],
      },
    });
    expect(second.candidates).toEqual([]);
    expect(second.ui.candidatesOpen).toBe(false);
  });

  it("ツールが失敗したら、作業の記録を失敗にし、クエストを戻す", () => {
    let state = applyEvent(fresh(), {
      type: "tool.start",
      data: { toolCallId: "a", tool: "search_festivals", staff: "researcher", bubble: "探します" },
    });
    state = applyEvent(state, {
      type: "tool.end",
      data: {
        toolCallId: "a",
        tool: "search_festivals",
        staff: "researcher",
        ok: false,
        bubble: "うまくいきませんでした",
        count: null,
      },
    });
    expect(state.quests.festivals.status).toBe("todo");
    expect(state.messages.at(-1)).toMatchObject({ kind: "work", status: "failed" });
  });
});

describe("候補カードの開け閉め", () => {
  it("返答の途中で利用者が候補を閉じたら、done で開き直さない", () => {
    let state = beginTurn(fresh(), {
      kind: "chat",
      message: "8月16日に行ける祭り",
      preferences: fresh().preferences,
    });
    state = applyEvent(state, {
      type: "tool.end",
      data: {
        toolCallId: "a",
        tool: "search_festivals",
        staff: "researcher",
        ok: true,
        bubble: "1件見つかりました",
        count: 1,
        candidates: [candidate],
      },
    });
    expect(state.ui.candidatesOpen).toBe(true);
    state = { ...state, ui: { ...state.ui, candidatesOpen: false } };
    state = applyEvent(state, {
      type: "done",
      data: { stage: "candidates", conditions: {}, preferences: state.preferences },
    });
    expect(state.ui.candidatesOpen).toBe(false);
    expect(state.candidates).toHaveLength(1);
  });
});

describe("エラーと送り直し", () => {
  it("サーバーのエラーは、その一文を会話欄に出す", () => {
    const state = applyEvent(fresh(), {
      type: "error",
      data: { code: "timeout", message: "時間がかかりすぎました", retryable: true },
    });
    expect(state.messages.at(-1)).toMatchObject({
      kind: "error",
      code: "timeout",
      message: "時間がかかりすぎました",
      retryable: true,
      resolved: false,
    });
  });

  it("done の前に接続が閉じたら、「もう一度送る」を出し、動いていた作業を止める", () => {
    let state = beginTurn(fresh(), {
      kind: "chat",
      message: "8月16日に行ける祭り",
      preferences: fresh().preferences,
    });
    state = apply(state, [
      {
        type: "staff.start",
        data: { staff: "researcher", task: "find_festivals", bubble: "調べてきますね" },
      },
      {
        type: "tool.start",
        data: {
          toolCallId: "a",
          tool: "search_festivals",
          staff: "researcher",
          bubble: "探します",
        },
      },
      { type: "message.delta", data: { messageId: "m", text: "少々" } },
    ]);
    state = endTurn(state, null);
    expect(state.session.streaming).toBe(false);
    expect(state.messages.at(-1)).toMatchObject({
      kind: "error",
      code: "connection_lost",
      retryable: true,
    });
    expect(state.messages.find((entry) => entry.kind === "work")).toMatchObject({
      status: "failed",
    });
    expect(state.messages.find((entry) => entry.kind === "concierge")).toMatchObject({
      streaming: false,
    });
    expect(state.staff.researcher.phase).toBe("returning");
  });

  it("送り直しでは同じ発言を会話欄に足さず、前のエラーを片づける", () => {
    let state = beginTurn(fresh(), {
      kind: "chat",
      message: "8月16日に行ける祭り",
      preferences: fresh().preferences,
    });
    state = endTurn(state, "upstream_unavailable");
    state = beginTurn(state, {
      kind: "chat",
      message: "8月16日に行ける祭り",
      preferences: fresh().preferences,
      retry: true,
    });
    expect(state.messages.filter((entry) => entry.kind === "user")).toHaveLength(1);
    expect(state.messages.find((entry) => entry.kind === "error")).toMatchObject({
      resolved: true,
    });
    expect(state.session.turn).toBe(2);
  });

  it("合言葉の誤りや回数の上限は、送り直しても直らない", () => {
    const state = endTurn(
      beginTurn(fresh(), { kind: "chat", message: "こんにちは", preferences: fresh().preferences }),
      "rate_limited",
    );
    expect(state.messages.at(-1)).toMatchObject({ code: "rate_limited", retryable: false });
  });
});

describe("時間切れのあと（終わっていないツールの tool.end が来ない）", () => {
  it("error と done が来たら、作業中の記録・再確認・クエスト・クイズを片付ける", () => {
    let state = beginTurn(fresh(), {
      kind: "chat",
      message: "これで決定します。",
      preferences: fresh().preferences,
    });
    state = apply(state, [
      {
        type: "staff.start",
        data: { staff: "planner", task: "plan_route", bubble: "道のりを調べます" },
      },
      {
        type: "tool.start",
        data: { toolCallId: "a", tool: "get_access", staff: "planner", bubble: "確かめます" },
      },
      {
        type: "tool.start",
        data: {
          toolCallId: "v",
          tool: "verify_festival",
          staff: "concierge",
          bubble: "確かめます",
        },
      },
    ]);
    state = {
      ...state,
      quiz: {
        offeredTurn: state.session.turn,
        question: {
          kind: "category",
          festivalId: "suzunari-toro",
          festivalName: "鈴鳴灯籠まつり",
          choices: ["lantern", "dance"],
          correct: 0,
          source: fictionalSource("about"),
        },
        answer: null,
      },
    };
    expect(state.quests.route.status).toBe("active");
    expect(state.verify.status).toBe("checking");

    state = apply(state, [
      { type: "error", data: { code: "timeout", message: "時間切れです", retryable: true } },
      {
        type: "done",
        data: { stage: "itinerary", conditions: {}, preferences: state.preferences },
      },
    ]);
    state = endTurn(state, null);

    expect(state.messages.filter((entry) => entry.kind === "work")).toEqual([
      expect.objectContaining({ id: "w-a", status: "failed" }),
      expect.objectContaining({ id: "w-v", status: "failed" }),
    ]);
    expect(state.verify.status).toBe("idle");
    expect(state.quests.route.status).toBe("todo");
    expect(state.quiz.question).toBeNull();
    // done は届いているので「接続が切れました」は出さない
    expect(state.messages.filter((entry) => entry.kind === "error")).toHaveLength(1);
  });

  it("前に達成したクエストは、途中で止まっても達成のまま", () => {
    let state = fresh();
    state = {
      ...state,
      quests: { ...state.quests, route: { status: "active", finished: [], completions: 1 } },
    };
    state = applyEvent(state, {
      type: "done",
      data: { stage: "itinerary", conditions: {}, preferences: state.preferences },
    });
    expect(state.quests.route.status).toBe("done");
  });
});
