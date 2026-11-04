import type { HookCallbackMatcher, HookEvent, HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { Itinerary, SseEvent } from "@matsuri-ikoka/schema";
import { decodeSseEvent, encodeSseEvent } from "@matsuri-ikoka/schema";
import { fictionalItinerary } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { testFestival } from "../domain/testFestivals";
import { searchFestivals, updateItinerary } from "../tools/matsuriTools";
import { runTool } from "../tools/mcpServer";
import { testToolContext } from "../tools/testContext";
import { createAgentHooks, extractToolOutput } from "./hooks";

const base = { session_id: "s", transcript_path: "/tmp/t", cwd: "/tmp" };

function setup() {
  const ctx = testToolContext([testFestival({ id: "suzunari-toro" })]);
  const events: SseEvent[] = [];
  const hooks = createAgentHooks({
    ctx,
    // 送る前の検証（encodeSseEvent）を通ることも確かめる
    emit: (event) => events.push(decodeSseEvent(encodeSseEvent(event))),
    briefing: (staff) => `記録：${staff}`,
  });
  const call = async (event: HookEvent, input: Record<string, unknown>) => {
    const matchers = (hooks[event] ?? []) as HookCallbackMatcher[];
    const toolName = input.tool_name as string | undefined;
    let output = {};
    for (const matcher of matchers) {
      if (matcher.matcher && toolName && !new RegExp(matcher.matcher).test(toolName)) continue;
      for (const hook of matcher.hooks) {
        output = await hook(
          { ...base, hook_event_name: event, ...input } as HookInput,
          input.tool_use_id as string,
          {
            signal: new AbortController().signal,
          },
        );
      }
    }
    return output;
  };
  return { ctx, events, call };
}

const denied = (output: unknown) =>
  (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
    ?.permissionDecision === "deny";

describe("createAgentHooks", () => {
  it("サブエージェントの開始で staff.start を出し、店の記録を渡す", async () => {
    const { ctx, events, call } = setup();

    const output = await call("SubagentStart", { agent_id: "a1", agent_type: "researcher" });

    expect(events).toEqual([
      {
        type: "staff.start",
        data: { staff: "researcher", task: "find_festivals", bubble: "調べてきますね" },
      },
    ]);
    expect(output).toEqual({
      hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: "記録：researcher" },
    });
    expect(ctx.turn.startedStaff.has("researcher")).toBe(true);
  });

  it("ツールの前後で tool.start・tool.end を出し、search_festivals の候補を載せる", async () => {
    const { ctx, events, call } = setup();
    const input = {
      when: { kind: "date", date: "2026-08-16" },
      origin: "みなと中央駅",
      nights: 0,
    };

    await call("PreToolUse", {
      agent_type: "researcher",
      tool_name: "mcp__matsuri__search_festivals",
      tool_input: input,
      tool_use_id: "call-1",
    });
    const result = await runTool(searchFestivals, input, ctx);
    await call("PostToolUse", {
      agent_type: "researcher",
      tool_name: "mcp__matsuri__search_festivals",
      tool_input: input,
      tool_response: result,
      tool_use_id: "call-1",
    });

    expect(events.map((e) => e.type)).toEqual(["tool.start", "tool.end"]);
    expect(events[0]).toMatchObject({
      data: {
        toolCallId: "call-1",
        tool: "search_festivals",
        staff: "researcher",
        bubble: "8月16日に、みなと中央駅から日帰りで行ける祭りを探しています",
      },
    });
    expect(events[1]).toMatchObject({
      data: {
        toolCallId: "call-1",
        ok: true,
        bubble: expect.stringMatching(/^1件見つかりました。いちばん上は「.+」$/),
        detail: expect.stringContaining("いちばん上は"),
        count: 1,
        candidates: [{ festivalId: "suzunari-toro" }],
      },
    });
  });

  it("update_itinerary の保存のあとに itinerary.updated を出す", async () => {
    const { ctx, events, call } = setup();
    const { id: _i, version: _v, verification: _r, days, ...rest } = fictionalItinerary();
    const input = {
      itinerary: {
        ...rest,
        days: days.map(({ weather: _w, items, ...day }) => ({
          ...day,
          items: items.map(({ changedInVersion: _c, ...item }) => item),
        })),
      },
    };

    await call("PreToolUse", {
      agent_type: "planner",
      tool_name: "mcp__matsuri__update_itinerary",
      tool_input: input,
      tool_use_id: "call-5",
    });
    const result = await runTool(updateItinerary, input, ctx);
    await call("PostToolUse", {
      agent_type: "planner",
      tool_name: "mcp__matsuri__update_itinerary",
      tool_input: input,
      tool_response: result,
      tool_use_id: "call-5",
    });

    expect(events.map((e) => e.type)).toEqual(["tool.start", "tool.end", "itinerary.updated"]);
    const updated = events[2] as Extract<SseEvent, { type: "itinerary.updated" }>;
    expect(updated.data.diff).toMatchObject({ fromVersion: 0, toVersion: 1 });
    expect((updated.data.itinerary as Itinerary).id).toBe(ctx.session.itineraryId);
  });

  it("失敗したツールは ok: false の tool.end にする", async () => {
    const { events, call } = setup();

    await call("PreToolUse", {
      agent_type: "planner",
      tool_name: "mcp__matsuri__get_access",
      tool_input: {},
      tool_use_id: "call-3",
    });
    await call("PostToolUseFailure", {
      agent_type: "planner",
      tool_name: "mcp__matsuri__get_access",
      tool_input: {},
      tool_use_id: "call-3",
      error: "x",
    });

    expect(events[1]).toMatchObject({
      type: "tool.end",
      data: { ok: false, bubble: "うまく調べられませんでした", count: null },
    });
  });

  it("スタッフと道具の組み合わせが仕様と違えば止める", async () => {
    const { events, call } = setup();

    const conciergeSearch = await call("PreToolUse", {
      tool_name: "mcp__matsuri__search_festivals",
      tool_input: {},
      tool_use_id: "x1",
    });
    const scoutItinerary = await call("PreToolUse", {
      agent_type: "scout",
      tool_name: "mcp__matsuri__update_itinerary",
      tool_input: {},
      tool_use_id: "x2",
    });
    const bash = await call("PreToolUse", {
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_use_id: "x3",
    });
    const unknownAgent = await call("PreToolUse", {
      agent_type: "general-purpose",
      tool_name: "mcp__matsuri__get_access",
      tool_input: {},
      tool_use_id: "x4",
    });

    expect([conciergeSearch, scoutItinerary, bash, unknownAgent].every(denied)).toBe(true);
    expect(events).toEqual([]);
  });

  it("同じスタッフは1回の発言で1回まで。ほかのエージェントは呼べない", async () => {
    const { call } = setup();
    const agent = (type: string, agentType?: string) =>
      call("PreToolUse", {
        tool_name: "Agent",
        tool_input: { subagent_type: type, prompt: "…" },
        tool_use_id: `a-${type}`,
        ...(agentType ? { agent_type: agentType } : {}),
      });

    expect(denied(await agent("researcher"))).toBe(false);
    expect(denied(await agent("researcher"))).toBe(true);
    expect(denied(await agent("general-purpose"))).toBe(true);
    expect(denied(await agent("planner", "scout"))).toBe(true);
  });

  it("開催の再確認は1回の発言で1回まで", async () => {
    const { events, call } = setup();
    const verify = (id: string) =>
      call("PreToolUse", {
        tool_name: "mcp__matsuri__verify_festival",
        tool_input: { festivalId: "suzunari-toro" },
        tool_use_id: id,
      });

    expect(denied(await verify("v1"))).toBe(false);
    expect(denied(await verify("v2"))).toBe(true);
    expect(events.filter((e) => e.type === "tool.start")).toHaveLength(1);
  });
});

describe("extractToolOutput", () => {
  it("MCP の結果のどの形からでも JSON を取り出す", () => {
    const value = { a: 1 };

    expect(extractToolOutput({ content: [], structuredContent: value })).toEqual(value);
    expect(extractToolOutput({ content: [{ type: "text", text: JSON.stringify(value) }] })).toEqual(
      value,
    );
    expect(extractToolOutput([{ type: "text", text: JSON.stringify(value) }])).toEqual(value);
    expect(extractToolOutput(JSON.stringify(value))).toEqual(value);
  });

  it("失敗や読めない結果は null", () => {
    expect(
      extractToolOutput({ content: [{ type: "text", text: "失敗" }], isError: true }),
    ).toBeNull();
    expect(extractToolOutput("失敗しました")).toBeNull();
    expect(extractToolOutput(undefined)).toBeNull();
  });
});

describe("評価の基準に届かないまま旅程係が終えようとしたとき", () => {
  const evaluation = (round: number, passed: boolean) => ({
    round,
    maxRounds: 3,
    threshold: 70,
    passed,
    scores: [
      { criterion: "coverage" as const, score: passed ? 100 : 65, findings: [] },
      { criterion: "specificity" as const, score: 100, findings: [] },
      { criterion: "feasibility" as const, score: 100, findings: [] },
      { criterion: "grounding" as const, score: 100, findings: [] },
    ],
    redo: passed
      ? []
      : [{ target: "nearby" as const, criterion: "coverage" as const, ask: "昼の店を調べ直す" }],
    judgedBy: "code" as const,
    evaluatedAt: "2026-08-03T10:15:00+09:00",
  });
  const stop = { agent_id: "a1", agent_type: "planner", stop_hook_active: false };

  it("回数が残っていれば、作り直しに戻す（調べ直しの頼みを添える）", async () => {
    const { ctx, call } = setup();
    ctx.turn.lastEvaluation = evaluation(1, false);

    const output = (await call("SubagentStop", stop)) as { decision?: string; reason?: string };

    expect(output.decision).toBe("block");
    expect(output.reason).toContain("research_trip");
  });

  it("合格したとき、回数を使い切ったとき、旅程係でないときは戻さない", async () => {
    const passed = setup();
    passed.ctx.turn.lastEvaluation = evaluation(1, true);
    expect(await passed.call("SubagentStop", stop)).toEqual({});

    const exhausted = setup();
    exhausted.ctx.turn.lastEvaluation = evaluation(3, false);
    expect(await exhausted.call("SubagentStop", stop)).toEqual({});

    const scout = setup();
    scout.ctx.turn.lastEvaluation = evaluation(1, false);
    expect(await scout.call("SubagentStop", { ...stop, agent_type: "scout" })).toEqual({});
  });

  it("評価の回数が進まないまま戻し続けない（戻すのは上限の回数−1まで）", async () => {
    const { ctx, call } = setup();
    ctx.turn.lastEvaluation = evaluation(1, false);
    const decisions = [];
    for (let i = 0; i < 4; i += 1) {
      decisions.push(((await call("SubagentStop", stop)) as { decision?: string }).decision);
    }
    expect(decisions).toEqual(["block", "block", undefined, undefined]);
  });
});
