import {
  type SampleConversation,
  SampleConversationSchema,
  type SseEvent,
} from "@matsuri-ikoka/schema";
import { fictionalItinerary } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import sampleJson from "../../../../data/samples/conversations/suzunari-day-trip.json";
import { applyEvent } from "./events";
import { initialData } from "./initial";
import { RELAY_LOG_LIMIT, staffActivity, turnRelays } from "./relay";
import { beginTurn, endTurn } from "./transitions";
import type { AppData, RelayEntry } from "./types";

const sample: SampleConversation = SampleConversationSchema.parse(sampleJson);

function fresh(): AppData {
  const state = initialData();
  return { ...state, session: { ...state.session, id: "s-1", status: "ready" } };
}

function apply(state: AppData, events: readonly SseEvent[]): AppData {
  return events.reduce(applyEvent, state);
}

function started(state: AppData = fresh()): AppData {
  return beginTurn(state, {
    kind: "chat",
    message: "8月の週末に日帰りで",
    preferences: state.preferences,
  });
}

/** 比べやすいよう、通し番号と発言の番号を外す */
function lines(entries: readonly RelayEntry[]) {
  return entries.map(({ kind, from, to, task }) => ({ kind, from, to, task }));
}

const staffStart = (staff: "researcher" | "scout" | "planner"): SseEvent => ({
  type: "staff.start",
  data: {
    staff,
    task:
      staff === "researcher" ? "find_festivals" : staff === "scout" ? "find_nearby" : "plan_route",
    bubble: "調べてきますね",
  },
});

const toolStart = (id: string, staff: "researcher" | "scout" | "planner"): SseEvent => ({
  type: "tool.start",
  data: {
    toolCallId: id,
    tool:
      staff === "researcher"
        ? "search_festivals"
        : staff === "scout"
          ? "search_nearby"
          : "update_itinerary",
    staff,
    bubble: "探しています",
  },
});

const toolEnd = (id: string, staff: "researcher" | "scout" | "planner", ok = true): SseEvent => ({
  type: "tool.end",
  data: {
    toolCallId: id,
    tool:
      staff === "researcher"
        ? "search_festivals"
        : staff === "scout"
          ? "search_nearby"
          : "update_itinerary",
    staff,
    ok,
    bubble: ok ? "見つかりました" : "もう少し調べています",
    count: null,
  },
});

const delta: SseEvent = {
  type: "message.delta",
  data: { messageId: "m1", text: "お待たせしました" },
};

describe("頼み", () => {
  it("スタッフが作業を始めると、コンシェルジュがその人に頼み、向いて吹き出しを出す", () => {
    const state = apply(started(), [staffStart("researcher")]);
    expect(lines(turnRelays(state))).toEqual([
      { kind: "request", from: "concierge", to: "researcher", task: "find_festivals" },
    ]);
    expect(state.relay.asking).toEqual({ to: "researcher", task: "find_festivals" });
    expect(state.relay.focus).toBe("researcher");
    expect(staffActivity("concierge", state.staff.concierge, state.relay)).toBe("asking");
  });

  it("頼んだ人がツールを使い終えるか、コンシェルジュが話し始めたら、頼みの吹き出しを下ろす", () => {
    let state = apply(started(), [staffStart("researcher"), toolStart("t1", "researcher")]);
    expect(state.relay.asking).not.toBeNull();
    state = apply(state, [toolEnd("t1", "researcher")]);
    expect(state.relay.asking).toBeNull();

    state = apply(started(state), [staffStart("scout"), delta]);
    expect(state.relay.asking).toBeNull();
  });
});

describe("受け渡し", () => {
  it("周辺係の結果は、旅程係が動き出したら旅程係へ渡る", () => {
    const state = apply(started(), [
      staffStart("scout"),
      toolStart("t1", "scout"),
      toolEnd("t1", "scout"),
      staffStart("planner"),
    ]);
    expect(lines(turnRelays(state))).toEqual([
      { kind: "request", from: "concierge", to: "scout", task: "find_nearby" },
      { kind: "handoff", from: "scout", to: "planner", task: "find_nearby" },
      { kind: "request", from: "concierge", to: "planner", task: "plan_route" },
    ]);
    expect(state.relay.holding).toEqual([]);
  });

  it("祭り調査係の結果は、ほかの人が動き出したらコンシェルジュへ渡る", () => {
    const state = apply(started(), [
      staffStart("researcher"),
      toolStart("t1", "researcher"),
      toolEnd("t1", "researcher"),
      staffStart("scout"),
    ]);
    expect(lines(turnRelays(state))[1]).toEqual({
      kind: "handoff",
      from: "researcher",
      to: "concierge",
      task: "find_festivals",
    });
  });

  it("コンシェルジュが話し始めたら、持っている結果を受け取り、渡した人の方を向く", () => {
    const state = apply(started(), [
      staffStart("researcher"),
      toolStart("t1", "researcher"),
      toolEnd("t1", "researcher"),
      delta,
    ]);
    expect(lines(turnRelays(state)).at(-1)).toEqual({
      kind: "handoff",
      from: "researcher",
      to: "concierge",
      task: "find_festivals",
    });
    expect(state.relay.focus).toBe("researcher");
    expect(state.relay.holding).toEqual([]);
  });

  it("旅程ができたら、旅程係が旅程をコンシェルジュへ運ぶ", () => {
    const itinerary = fictionalItinerary();
    const state = apply(started(), [
      staffStart("planner"),
      toolStart("t1", "planner"),
      toolEnd("t1", "planner"),
      {
        type: "itinerary.updated",
        data: {
          itinerary,
          diff: {
            fromVersion: 0,
            toVersion: itinerary.version,
            added: [],
            changed: [],
            removed: [],
          },
        },
      },
    ]);
    expect(lines(turnRelays(state)).at(-1)).toEqual({
      kind: "handoff",
      from: "planner",
      to: "concierge",
      task: "plan_route",
    });
    expect(staffActivity("planner", state.staff.planner, state.relay)).toBe("delivering");
  });

  it("ツールが失敗したスタッフは、渡すものがない", () => {
    const state = apply(started(), [
      staffStart("scout"),
      toolStart("t1", "scout"),
      toolEnd("t1", "scout", false),
      staffStart("planner"),
    ]);
    expect(turnRelays(state).filter((entry) => entry.kind === "handoff")).toEqual([]);
  });

  it("返答が終わったら、残りの結果をコンシェルジュへ渡し、頼みと向きを片付ける", () => {
    let state = apply(started(), [
      staffStart("scout"),
      toolStart("t1", "scout"),
      toolEnd("t1", "scout"),
    ]);
    state = endTurn(state, null);
    expect(lines(turnRelays(state)).at(-1)).toEqual({
      kind: "handoff",
      from: "scout",
      to: "concierge",
      task: "find_nearby",
    });
    expect(state.relay).toMatchObject({ asking: null, focus: null, holding: [] });
  });

  it("記録した相談を通すと、頼みと受け渡しが発言ごとに残る", () => {
    let state = fresh();
    for (const turn of sample.turns) {
      state = beginTurn(state, { kind: "chat", ...turn.request });
      state = apply(
        state,
        turn.events.map((recorded) => recorded.event),
      );
      state = endTurn(state, null);
      // どの発言でも、作業を頼んだ人には頼みが1件ずつある
      const requests = turnRelays(state).filter((entry) => entry.kind === "request");
      expect([...new Set(requests.map((entry) => entry.task))]).toEqual(state.session.turnTasks);
    }
    const ids = state.relay.log.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(state.relay.log.some((entry) => entry.kind === "handoff")).toBe(true);
  });

  it("記録は上限の数まで残し、古いものから捨てる", () => {
    let state = fresh();
    for (let index = 0; index < RELAY_LOG_LIMIT; index += 1) {
      state = endTurn(apply(started(state), [staffStart("researcher")]), null);
    }
    expect(state.relay.log).toHaveLength(RELAY_LOG_LIMIT);
    expect(state.relay.log.at(-1)?.id).toBe(RELAY_LOG_LIMIT);
  });
});

describe("頭の上のようす", () => {
  it("ツールの種類で、調べている・確かめている・まとめているを分ける", () => {
    const base = fresh().staff.researcher;
    const working = { ...base, phase: "working" as const };
    const relay = { asking: null };
    expect(staffActivity("researcher", { ...base, phase: "walking" }, relay)).toBe("heading");
    expect(staffActivity("researcher", { ...working, tool: "search_festivals" }, relay)).toBe(
      "researching",
    );
    expect(staffActivity("planner", { ...working, tool: "get_access" }, relay)).toBe("checking");
    expect(staffActivity("concierge", { ...working, tool: "verify_festival" }, relay)).toBe(
      "checking",
    );
    expect(staffActivity("planner", { ...working, tool: "update_itinerary" }, relay)).toBe(
      "summarizing",
    );
    // ツールを使い終えて持ち場にいる間は、結果をまとめている
    expect(staffActivity("scout", working, relay)).toBe("summarizing");
    expect(staffActivity("scout", base, relay)).toBeNull();
    expect(staffActivity("scout", { ...base, phase: "returning" }, relay)).toBeNull();
  });
});
