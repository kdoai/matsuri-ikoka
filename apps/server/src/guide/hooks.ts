import type { HookCallback, HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { GUIDE_TOOL_NAMES, type GuideToolName } from "@matsuri-ikoka/schema";
import { deny, extractToolOutput } from "../agent/hooks";
import { GUIDE_MCP_TOOL_PREFIX } from "../agent/options";
import { guideToolEnd, guideToolStartBubble } from "./bubbles";
import type { EmitGuideEvent, GuideTurnState } from "./runner";
import { GUIDE_TOOL_TURN_LIMITS } from "./tools";

// ガイドのフック。SSE のイベントを出す場所であり、安全のための関所でもある。
// 組み込みの道具は渡していないが、決まったツールのほかは、ここでも断る。

export function guideToolNameOf(fullName: string): GuideToolName | null {
  if (!fullName.startsWith(GUIDE_MCP_TOOL_PREFIX)) return null;
  const name = fullName.slice(GUIDE_MCP_TOOL_PREFIX.length);
  return (GUIDE_TOOL_NAMES as readonly string[]).includes(name) ? (name as GuideToolName) : null;
}

export function createGuideHooks(deps: {
  turn: GuideTurnState;
  emit: EmitGuideEvent;
}): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const { turn, emit } = deps;
  /** tool.start を出したツールの呼び出し */
  const started = new Map<string, GuideToolName>();

  const preToolUse: HookCallback = async (input, toolUseId) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const tool = guideToolNameOf(input.tool_name);
    if (tool === null) return deny("ガイドでは使えない道具です");
    const used = turn.toolCalls.filter((name) => name === tool).length;
    if (used >= GUIDE_TOOL_TURN_LIMITS[tool]) {
      return deny(`この発言では ${tool} をもう呼べません。これまでの結果で答えてください`);
    }
    turn.toolCalls.push(tool);
    const toolCallId = input.tool_use_id || toolUseId || "";
    if (toolCallId !== "") {
      started.set(toolCallId, tool);
      emit({
        type: "guide.tool.start",
        data: { toolCallId, tool, bubble: guideToolStartBubble(tool) },
      });
    }
    return {};
  };

  const endTool = (toolCallId: string, output: Record<string, unknown> | null) => {
    const tool = started.get(toolCallId);
    if (tool === undefined) return;
    started.delete(toolCallId);
    emit({ type: "guide.tool.end", data: { toolCallId, tool, ...guideToolEnd(tool, output) } });
  };

  const postToolUse: HookCallback = async (input, toolUseId) => {
    if (input.hook_event_name !== "PostToolUse") return {};
    endTool(input.tool_use_id || toolUseId || "", extractToolOutput(input.tool_response));
    return {};
  };

  const postToolUseFailure: HookCallback = async (input, toolUseId) => {
    if (input.hook_event_name !== "PostToolUseFailure") return {};
    endTool(input.tool_use_id || toolUseId || "", null);
    return {};
  };

  return {
    PreToolUse: [{ hooks: [preToolUse] }],
    PostToolUse: [{ matcher: `^${GUIDE_MCP_TOOL_PREFIX}`, hooks: [postToolUse] }],
    PostToolUseFailure: [{ matcher: `^${GUIDE_MCP_TOOL_PREFIX}`, hooks: [postToolUseFailure] }],
  };
}
