import type { HookCallbackMatcher, HookInput } from "@anthropic-ai/claude-agent-sdk";
import { GUIDE_TOOL_NAMES, type GuideSseEvent } from "@matsuri-ikoka/schema";
import { describe, expect, it } from "vitest";
import { GUIDE_MCP_TOOL_PREFIX } from "../agent/options";
import { createGuideHooks, guideToolNameOf } from "./hooks";
import { newGuideTurn } from "./runner";
import { GUIDE_TOOL_TURN_LIMITS } from "./tools";

function setup() {
  const events: GuideSseEvent[] = [];
  const turn = newGuideTurn();
  const hooks = createGuideHooks({ turn, emit: (event) => events.push(event) });
  const call = async (
    event: "PreToolUse" | "PostToolUse" | "PostToolUseFailure",
    input: Record<string, unknown>,
  ) => {
    const matchers = (hooks[event] ?? []) as HookCallbackMatcher[];
    let output: unknown = {};
    for (const matcher of matchers) {
      for (const hook of matcher.hooks) {
        output = await hook(
          {
            hook_event_name: event,
            session_id: "s",
            transcript_path: "",
            cwd: "",
            ...input,
          } as HookInput,
          input.tool_use_id as string,
          { signal: new AbortController().signal },
        );
      }
    }
    return output;
  };
  return { events, turn, call };
}

const denied = (output: unknown) =>
  (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
    ?.permissionDecision === "deny";

describe("guideToolNameOf", () => {
  it("ガイドのツールの名前だけを読む", () => {
    expect(guideToolNameOf(`${GUIDE_MCP_TOOL_PREFIX}read_trip`)).toBe("read_trip");
    expect(guideToolNameOf(`${GUIDE_MCP_TOOL_PREFIX}update_itinerary`)).toBeNull();
    expect(guideToolNameOf("mcp__matsuri__read_trip")).toBeNull();
    expect(guideToolNameOf("Bash")).toBeNull();
  });
});

describe("ガイドのフック", () => {
  it.each([
    "Bash",
    "PowerShell",
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "WebFetch",
    "WebSearch",
    "Agent",
    "Task",
    "mcp__matsuri__update_itinerary",
    "mcp__other__read_trip",
    `${GUIDE_MCP_TOOL_PREFIX}book_hotel`,
  ])("決まったツールのほかは断る：%s", async (tool) => {
    const { call, events, turn } = setup();

    const output = await call("PreToolUse", {
      tool_name: tool,
      tool_input: {},
      tool_use_id: "call-1",
    });

    expect(denied(output)).toBe(true);
    expect(events).toEqual([]);
    expect(turn.toolCalls).toEqual([]);
  });

  it("ツールの前と後に、決まった型の吹き出しを出す", async () => {
    const { call, events, turn } = setup();
    const tool = `${GUIDE_MCP_TOOL_PREFIX}list_notices`;

    await call("PreToolUse", { tool_name: tool, tool_input: {}, tool_use_id: "call-1" });
    await call("PostToolUse", {
      tool_name: tool,
      tool_input: {},
      tool_use_id: "call-1",
      tool_response: { structuredContent: { unread: 2, notices: [] } },
    });

    expect(turn.toolCalls).toEqual(["list_notices"]);
    expect(events).toEqual([
      {
        type: "guide.tool.start",
        data: { toolCallId: "call-1", tool: "list_notices", bubble: "知らせを見ています" },
      },
      {
        type: "guide.tool.end",
        data: {
          toolCallId: "call-1",
          tool: "list_notices",
          ok: true,
          bubble: "知らせが2件あります",
        },
      },
    ]);
  });

  it("失敗したら失敗の吹き出しを出す", async () => {
    const { call, events } = setup();
    const tool = `${GUIDE_MCP_TOOL_PREFIX}research_web`;

    await call("PreToolUse", { tool_name: tool, tool_input: {}, tool_use_id: "call-1" });
    await call("PostToolUseFailure", { tool_name: tool, tool_input: {}, tool_use_id: "call-1" });

    expect(events.at(-1)).toMatchObject({ type: "guide.tool.end", data: { ok: false } });
  });

  it.each(GUIDE_TOOL_NAMES)("%s は1回の発言で呼べる数を超えたら断る", async (name) => {
    const { call } = setup();
    const tool = `${GUIDE_MCP_TOOL_PREFIX}${name}`;
    for (let index = 0; index < GUIDE_TOOL_TURN_LIMITS[name]; index += 1) {
      const output = await call("PreToolUse", {
        tool_name: tool,
        tool_input: {},
        tool_use_id: `call-${index}`,
      });
      expect(denied(output)).toBe(false);
    }

    const over = await call("PreToolUse", {
      tool_name: tool,
      tool_input: {},
      tool_use_id: "call-over",
    });

    expect(denied(over)).toBe(true);
  });
});
