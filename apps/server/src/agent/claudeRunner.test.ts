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
import { TURN_MAX_MS } from "../routes/turnStream";
import { ItineraryStore, type Session, SessionStore } from "../session/sessionStore";
import type { ToolContext } from "../tools/context";
import { createUnavailableLodging } from "../tools/lodging";
import { searchFestivals } from "../tools/matsuriTools";
import { createMatsuriMcpServer, runTool } from "../tools/mcpServer";
import { unavailableVerifier } from "../tools/verifier";
import { ClaudeAgentRunner, CONTINUE_PROMPT, RESUME_MIN_REMAINING_MS } from "./claudeRunner";
import type { AgentPrompts } from "./prompts";
import { AgentError, type QueryFn } from "./runner";

// Agent SDK の代わりに、決まったメッセージを流し、フックを呼ぶ偽物の query で確かめる

const prompts: AgentPrompts = {
  concierge: "c",
  common: "共通",
  researcher: "r",
  scout: "s",
  planner: "p",
  verifier: "v",
  route: "rt",
  nearby: "nb",
  lodging: "lg",
  evaluator: "ev",
  "wish-reader": "wr",
  guide: "ガイド",
  "guide-research": "ガイドの調べ役",
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
    lodging: createUnavailableLodging(),
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
  const sessions = new SessionStore();
  const session = sessions.create();
  const runIn = async (target: Session, message: string, locale?: "ja" | "en") => {
    const events: SseEvent[] = [];
    await runner.runTurn(
      {
        session: target,
        message,
        preferences: DEFAULT_PREFERENCES,
        ...(locale === undefined ? {} : { locale }),
        signal: new AbortController().signal,
      },
      (e) => events.push(e),
    );
    return events;
  };
  const run = (message: string, locale?: "ja" | "en") => runIn(session, message, locale);
  return { calls, session, sessions, run, runIn };
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
      nights: 0,
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

  it("英語の画面から送られたら、プロンプトの店の記録で英語の返事を頼む", async () => {
    const reply: Script = async function* () {
      yield init();
      yield text("Sure.");
      yield blockStop();
      yield success();
    };
    const { calls, run } = setup([reply, reply]);

    await run("Hello", "en");
    await run("こんにちは");

    expect(calls[0]?.prompt).toContain("画面の言語：英語");
    expect(calls[1]?.prompt).not.toContain("画面の言語");
  });

  it("会話の記録は、その相談が名乗った記録だけから続け、別の相談の記録からは続けない", async () => {
    const replying = (sdkSession: string, reply: string): Script =>
      async function* () {
        yield init(sdkSession);
        yield text(reply);
        yield blockStop();
        yield success();
      };
    const { calls, sessions, runIn } = setup([
      replying("sdk-a", "A への返事。"),
      replying("sdk-b", "B への返事。"),
      replying("sdk-a", "A への続きの返事。"),
      replying("sdk-b", "B への続きの返事。"),
    ]);
    const a = sessions.create();
    const b = sessions.create();

    const firstA = await runIn(a, "A の発言");
    const firstB = await runIn(b, "B の発言");
    await runIn(a, "A の続きの発言");
    await runIn(b, "B の続きの発言");

    expect(calls.map((call) => call.options.resume)).toEqual([
      undefined,
      undefined,
      "sdk-a",
      "sdk-b",
    ]);
    expect(a.agentSessionId).toBe("sdk-a");
    expect(b.agentSessionId).toBe("sdk-b");
    expect(JSON.stringify(firstA)).not.toContain("B への返事");
    expect(JSON.stringify(firstB)).not.toContain("A への返事");
    expect(calls[1]?.prompt).not.toContain("A の発言");
  });

  it("同時に返事を作っても、相談どうしで返答の文が混ざらない", async () => {
    let arrived = 0;
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const overlapping = (sdkSession: string, reply: string): Script =>
      async function* () {
        yield init(sdkSession);
        yield text(`${reply}のはじめ。`);
        yield blockStop();
        arrived += 1;
        if (arrived === 2) open();
        await gate;
        yield text(`${reply}のおわり。`);
        yield blockStop();
        yield success();
      };
    const { sessions, runIn } = setup([overlapping("sdk-a", "A"), overlapping("sdk-b", "B")]);
    const a = sessions.create();
    const b = sessions.create();

    const [eventsA, eventsB] = await Promise.all([runIn(a, "発言"), runIn(b, "発言")]);

    const texts = (events: SseEvent[]) =>
      events.flatMap((event) => (event.type === "message.delta" ? [event.data.text] : []));
    expect(texts(eventsA)).toEqual(["Aのはじめ。", "Aのおわり。"]);
    expect(texts(eventsB)).toEqual(["Bのはじめ。", "Bのおわり。"]);
    expect(a.agentSessionId).toBe("sdk-a");
    expect(b.agentSessionId).toBe("sdk-b");
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

  it("返事の途中で失敗したら、時間の残りがあれば、止まったところから resume で続ける", async () => {
    const { calls, session, run } = setup([
      async function* ({ hook }) {
        yield init("sdk-7");
        await hook("PreToolUse", {
          tool_name: "Agent",
          tool_input: { subagent_type: "researcher" },
          tool_use_id: "a1",
        });
        await hook("SubagentStart", { agent_id: "x", agent_type: "researcher" });
        yield text("ええと。");
        yield blockStop();
        throw new Error("connection reset");
      },
      async function* ({ hook }) {
        yield init("sdk-7");
        // 続きでは、失敗した試みで呼んだスタッフをもう一度呼べる
        const again = await hook("PreToolUse", {
          tool_name: "Agent",
          tool_input: { subagent_type: "researcher" },
          tool_use_id: "a2",
        });
        expect(JSON.stringify(again)).not.toContain("deny");
        yield text("続きです。");
        yield blockStop();
        yield success();
      },
    ]);

    const events = await run("こんにちは");

    expect(calls).toHaveLength(2);
    expect(calls[1]?.options.resume).toBe("sdk-7");
    expect(calls[1]?.prompt).toBe(CONTINUE_PROMPT);
    expect(session.agentSessionId).toBe("sdk-7");
    const deltas = events.flatMap((e) => (e.type === "message.delta" ? [e.data] : []));
    expect(deltas.map((d) => d.text)).toEqual(["ええと。", "続きです。"]);
    // 続きの返答は、別の返答として新しい ID で流す
    expect(deltas[0]?.messageId).not.toBe(deltas[1]?.messageId);
  });

  it("返事の途中で失敗し、セッションを名乗っていなければ、店の記録で新しく始める", async () => {
    const { calls, run } = setup([
      // biome-ignore lint/correctness/useYield: イベントを送ってから、セッションを名乗る前に失敗する台本
      async function* ({ hook }) {
        await hook("SubagentStart", { agent_id: "x", agent_type: "researcher" });
        throw new Error("connection reset");
      },
      async function* () {
        yield init();
        yield text("お待たせしました。");
        yield blockStop();
        yield success();
      },
    ]);

    await run("こんにちは");

    expect(calls).toHaveLength(2);
    expect(calls[1]?.options.resume).toBeUndefined();
    expect(calls[1]?.prompt).toContain("<お客さまの発言>");
  });

  it("返事の途中で失敗し、相談の時間の残りが少なければ、続けずにエラーにする", async () => {
    const { calls, run } = setup([
      async function* ({ ctx }) {
        yield init();
        yield text("ええと。");
        ctx.turn.startedAt = Date.now() - (TURN_MAX_MS - RESUME_MIN_REMAINING_MS) - 1;
        throw new Error("process exited");
      },
    ]);

    await expect(run("こんにちは")).rejects.toMatchObject({ code: "internal", retryable: true });
    expect(calls).toHaveLength(1);
  });

  it("返事の途中でも、やり直しても直らない失敗は続けない", async () => {
    const { calls, run } = setup([
      async function* () {
        yield init();
        yield text("ええと。");
        throw new Error("Failed to authenticate: invalid api key");
      },
    ]);

    await expect(run("こんにちは")).rejects.toMatchObject({ retryable: false });
    expect(calls).toHaveLength(1);
  });
});
