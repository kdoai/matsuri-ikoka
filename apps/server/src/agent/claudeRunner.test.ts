import type {
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  Options,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_PREFERENCES, type SseEvent } from "@matsuri-ikoka/schema";
import { describe, expect, it } from "vitest";
import { createFestivalStore } from "../data/festivalStore";
import { testFestival } from "../domain/testFestivals";
import { ItineraryStore, SessionStore } from "../session/sessionStore";
import type { ToolContext } from "../tools/context";
import { searchFestivals } from "../tools/matsuriTools";
import { createMatsuriMcpServer, runTool } from "../tools/mcpServer";
import { unavailableVerifier } from "../tools/verifier";
import { ClaudeAgentRunner } from "./claudeRunner";
import type { AgentPrompts } from "./prompts";
import { AgentError, type QueryFn } from "./runner";

// Agent SDK の代わりに、決まったメッセージを流し、フックを呼ぶ偽物の query で確かめる

const prompts: AgentPrompts = {
  concierge: "c",
  researcher: "r",
  scout: "s",
  planner: "p",
  verifier: "v",
};

type Script = (api: {
  options: Options;
  prompt: string;
  ctx: ToolContext;
  hook: (event: HookEvent, input: Record<string, unknown>) => Promise<unknown>;
}) => AsyncGenerator<SDKMessage>;

function setup(scripts: Script[]) {
  const calls: { prompt: string; options: Options }[] = [];
  let ctx: ToolContext | undefined;
  const query: QueryFn = (params) => {
    calls.push(params);
    const script = scripts[calls.length - 1];
    if (script === undefined) throw new Error("台本がありません");
    const hook = async (event: HookEvent, input: Record<string, unknown>) => {
      let output: unknown = {};
      for (const matcher of (params.options.hooks?.[event] ?? []) as HookCallbackMatcher[]) {
        for (const fn of matcher.hooks) {
          output = await fn(
            {
              session_id: "sdk-1",
              transcript_path: "",
              cwd: "",
              hook_event_name: event,
              ...input,
            } as HookInput,
            input.tool_use_id as string | undefined,
            { signal: new AbortController().signal },
          );
        }
      }
      return output;
    };
    return script({
      options: params.options,
      prompt: params.prompt,
      ctx: ctx as ToolContext,
      hook,
    });
  };
  const itineraries = new ItineraryStore();
  const runner = new ClaudeAgentRunner({
    festivals: createFestivalStore([testFestival({ id: "suzunari-toro" })]),
    itineraries,
    weather: { forecast: async () => ({ weather: { status: "not_yet" }, area: null }) },
    verifier: unavailableVerifier,
    prompts,
    models: {},
    cwd: "/tmp/matsuri-agent-test",
    env: {},
    today: () => "2026-08-03",
    now: () => "2026-08-03T10:00:00+09:00",
    query,
    createToolServer: (context) => {
      ctx = context;
      return createMatsuriMcpServer(context);
    },
  });
  const session = new SessionStore().create();
  const run = async (message: string) => {
    const events: SseEvent[] = [];
    await runner.runTurn(
      { session, message, preferences: DEFAULT_PREFERENCES, signal: new AbortController().signal },
      (e) => events.push(e),
    );
    return events;
  };
  return { calls, session, run };
}

const init = (sessionId = "sdk-1") =>
  ({ type: "system", subtype: "init", session_id: sessionId }) as unknown as SDKMessage;
const text = (t: string) =>
  ({
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } },
  }) as unknown as SDKMessage;
const blockStop = () =>
  ({
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "content_block_stop", index: 0 },
  }) as unknown as SDKMessage;
const success = () =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "sdk-1",
  }) as unknown as SDKMessage;

describe("ClaudeAgentRunner", () => {
  it("スタッフのイベントと返答の文を流し、会話の状態を進め、次の発言では resume する", async () => {
    const searchInput = {
      when: { kind: "date", date: "2026-08-16" },
      origin: "みなと中央駅",
      stay: "day_trip",
    };
    const { calls, session, run } = setup([
      async function* ({ ctx, hook }) {
        yield init();
        await hook("PreToolUse", {
          tool_name: "Agent",
          tool_input: { subagent_type: "researcher" },
          tool_use_id: "a1",
        });
        await hook("SubagentStart", { agent_id: "x", agent_type: "researcher" });
        await hook("PreToolUse", {
          agent_type: "researcher",
          tool_name: "mcp__matsuri__search_festivals",
          tool_input: searchInput,
          tool_use_id: "t1",
        });
        const response = await runTool(searchFestivals, searchInput, ctx);
        await hook("PostToolUse", {
          agent_type: "researcher",
          tool_name: "mcp__matsuri__search_festivals",
          tool_input: searchInput,
          tool_response: response,
          tool_use_id: "t1",
        });
        // スタッフの文は流さない
        yield { ...text("（調査係の報告）"), parent_tool_use_id: "a1" } as SDKMessage;
        yield text("8月16日なら鈴鳴灯籠まつりが");
        yield text("おすすめです。どうしますか");
        yield blockStop();
        yield success();
      },
      async function* ({ prompt }) {
        expect(prompt).toContain("鈴鳴灯籠まつりにします");
        yield init();
        yield text("承知しました。");
        yield blockStop();
        yield success();
      },
    ]);

    const first = await run("8月16日に日帰りで行ける祭りは？");

    expect(first.map((e) => e.type)).toEqual([
      "staff.start",
      "tool.start",
      "tool.end",
      "message.delta",
      "message.delta",
    ]);
    expect(first.filter((e) => e.type === "message.delta").map((e) => e.data.text)).toEqual([
      "8月16日なら鈴鳴灯籠まつりがおすすめです。",
      "どうしますか",
    ]);
    expect(session.stage).toBe("candidates");
    expect(session.agentSessionId).toBe("sdk-1");
    expect(calls[0]?.options.resume).toBeUndefined();
    expect(calls[0]?.prompt).toContain("<お客さまの発言>");

    await run("鈴鳴灯籠まつりにします");
    expect(calls[1]?.options.resume).toBe("sdk-1");
  });

  it("何も送る前の一時的な失敗は、1回だけやり直す", async () => {
    const { calls, run } = setup([
      // biome-ignore lint/correctness/useYield: 失敗だけを起こす台本
      async function* () {
        throw new Error("connection reset");
      },
      async function* () {
        yield init();
        yield text("お待たせしました。");
        yield blockStop();
        yield success();
      },
    ]);

    const events = await run("こんにちは");

    expect(calls).toHaveLength(2);
    expect(events.map((e) => e.type)).toEqual(["message.delta"]);
  });

  it("混み合っているときは、もう一度送れば直るエラーにする", async () => {
    const failure = async function* () {
      yield init();
      yield {
        type: "assistant",
        parent_tool_use_id: null,
        error: "overloaded",
        message: { content: [] },
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: "sdk-1",
        errors: [],
      } as unknown as SDKMessage;
    };
    const { run } = setup([failure, failure]);

    const error = await run("こんにちは").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AgentError);
    expect(error).toMatchObject({ code: "upstream_unavailable", retryable: true });
  });

  it("認証の失敗はやり直さず、もう一度送っても直らないエラーにする", async () => {
    const { calls, run } = setup([
      async function* () {
        yield init();
        throw new Error("Failed to authenticate: OAuth session expired and could not be refreshed");
      },
    ]);

    await expect(run("こんにちは")).rejects.toMatchObject({ code: "internal", retryable: false });
    expect(calls).toHaveLength(1);
  });

  it("返事の途中で失敗したら、やり直さずにエラーにする", async () => {
    const { calls, run } = setup([
      async function* () {
        yield init();
        yield text("ええと。");
        throw new Error("process exited");
      },
    ]);

    await expect(run("こんにちは")).rejects.toMatchObject({ code: "internal", retryable: true });
    expect(calls).toHaveLength(1);
  });
});
