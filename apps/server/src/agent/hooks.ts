import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import {
  FestivalCandidateSchema,
  FestivalVerifiedEventSchema,
  ItineraryDiffSchema,
  SearchOutcomeSchema,
  type SseEvent,
  type StaffId,
  type ToolName,
} from "@matsuri-ikoka/schema";
import { z } from "zod";
import {
  type AgentToolName,
  ALL_TOOL_NAMES,
  isVisibleTool,
  type ToolContext,
} from "../tools/context";
import { spotPins } from "../tools/matsuriTools";
import { MCP_TOOL_PREFIX } from "../tools/mcpServer";
import { canRedoPlan, nextStepAfter } from "../tools/planReview";
import {
  isStaff,
  STAFF_NAMES,
  STAFF_TASK,
  type Staff,
  staffOf,
  staffStartBubble,
  toolEndBubble,
  toolStartBubble,
} from "./bubbles";

// フックで SSE のイベントを出す。
// - SubagentStart → staff.start（スタッフが持ち場へ歩く）。スタッフに店の記録を渡す
// - PreToolUse → tool.start。スタッフと道具の組み合わせ、スタッフを呼ぶ回数もここで守る
// - PostToolUse / PostToolUseFailure → tool.end、続けて itinerary.updated・festival.verified
// - SubagentStop → 旅程係が、評価の基準に届かないまま（回数が残っているのに）終えようとしたら、作り直しに戻す

/** スタッフが使える道具。仕様の表（docs/spec/agents.md）と同じ */
export const TOOLS_BY_STAFF: Readonly<Record<StaffId, readonly AgentToolName[]>> = {
  concierge: ["note_conditions", "update_itinerary", "verify_festival"],
  researcher: ["search_festivals"],
  scout: ["search_nearby"],
  planner: [
    "get_access",
    "research_route",
    "research_trip",
    "get_weather",
    "search_nearby",
    "search_lodging",
    "update_itinerary",
  ],
};

/** 1回の発言で1回までの道具。再確認は Web を調べるので、費用と時間がかかる */
const ONCE_PER_TURN: readonly AgentToolName[] = ["verify_festival"];

/** サブエージェントを呼ぶ組み込みの道具の名前（古い版では Task） */
const AGENT_TOOL_NAMES = new Set(["Agent", "Task"]);

export function toolNameOf(fullName: string): AgentToolName | null {
  if (!fullName.startsWith(MCP_TOOL_PREFIX)) return null;
  const name = fullName.slice(MCP_TOOL_PREFIX.length);
  return (ALL_TOOL_NAMES as readonly string[]).includes(name) ? (name as AgentToolName) : null;
}

export function deny(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

/**
 * ツールの結果（PostToolUse の tool_response）から、ツールが返した JSON を取り出す。
 * MCP の結果の形（structuredContent、content の配列、文字列）のどれでも読む。失敗なら null
 */
export function extractToolOutput(response: unknown): Record<string, unknown> | null {
  const asObject = (value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const fromText = (text: unknown) => {
    if (typeof text !== "string") return null;
    try {
      return asObject(JSON.parse(text));
    } catch {
      return null;
    }
  };
  const fromBlocks = (blocks: unknown) => {
    if (!Array.isArray(blocks)) return null;
    for (const block of blocks) {
      const parsed = fromText(asObject(block)?.text);
      if (parsed !== null) return parsed;
    }
    return null;
  };

  if (typeof response === "string") return fromText(response);
  if (Array.isArray(response)) return fromBlocks(response);
  const object = asObject(response);
  if (object === null || object.isError === true) return null;
  return asObject(object.structuredContent) ?? fromBlocks(object.content);
}

export interface HookDeps {
  ctx: ToolContext;
  emit: (event: SseEvent) => void;
  /** サブエージェントの開始時に足す文脈 */
  briefing: (staff: Staff) => string;
}

type Hooks = Partial<Record<HookEvent, HookCallbackMatcher[]>>;

export function createAgentHooks({ ctx, emit, briefing }: HookDeps): Hooks {
  const { turn } = ctx;
  /** tool.start を出したツールの呼び出しと、そのスタッフ */
  const started = new Map<string, { tool: ToolName; staff: StaffId }>();
  /** この発言で呼ぶと決めたスタッフ（同じスタッフは1回まで） */
  const requested = new Set<Staff>();
  /** この発言ですでに呼んだ、1回までの道具 */
  const usedOnce = new Set<AgentToolName>();
  const hasItinerary = () => ctx.session.itineraryId !== null;

  const preToolUse: HookCallback = async (input, toolUseId) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const staff = staffOf(input.agent_type);
    if (staff === null) return deny("この店のスタッフではありません");

    if (AGENT_TOOL_NAMES.has(input.tool_name)) {
      if (staff !== "concierge") return deny("スタッフは、ほかのスタッフを呼べません");
      const type = z.object({ subagent_type: z.string() }).safeParse(input.tool_input);
      const target = type.success ? type.data.subagent_type : undefined;
      if (!isStaff(target)) {
        return deny("呼べるのは researcher・scout・planner の3人だけです");
      }
      if (requested.has(target)) {
        return deny(
          `この発言では、もう${STAFF_NAMES[target]}に頼みました。その報告を使ってください`,
        );
      }
      requested.add(target);
      return {};
    }

    const tool = toolNameOf(input.tool_name);
    if (tool === null) return deny("この店では使えない道具です");
    if (!TOOLS_BY_STAFF[staff].includes(tool)) {
      return deny(`${STAFF_NAMES[staff]}は ${tool} を使えません`);
    }
    if (ONCE_PER_TURN.includes(tool)) {
      if (usedOnce.has(tool)) {
        return deny(`この発言では、もう ${tool} を使いました。その結果を使ってください`);
      }
      usedOnce.add(tool);
    }
    const toolCallId = input.tool_use_id || toolUseId || "";
    turn.toolCalls.push(tool);
    // 条件の書き留めは店の裏の作業なので、画面には動きを出さない
    if (toolCallId !== "" && isVisibleTool(tool)) {
      started.set(toolCallId, { tool, staff });
      emit({
        type: "tool.start",
        data: {
          toolCallId,
          tool,
          staff,
          bubble: toolStartBubble(tool, input.tool_input, {
            preferences: ctx.session.preferences,
            hasItinerary: hasItinerary(),
          }),
        },
      });
    }
    return {};
  };

  const endTool = (toolCallId: string, output: Record<string, unknown> | null) => {
    const call = started.get(toolCallId);
    if (call === undefined) return;
    started.delete(toolCallId);
    const { tool, staff } = call;
    const end = toolEndBubble(tool, output);
    const candidates =
      tool === "search_festivals" && output !== null
        ? z.array(FestivalCandidateSchema).max(3).safeParse(output.candidates)
        : null;
    const search =
      tool === "search_festivals" && output !== null
        ? SearchOutcomeSchema.safeParse(output.search)
        : null;
    emit({
      type: "tool.end",
      data: {
        toolCallId,
        tool,
        staff,
        ok: end.ok,
        bubble: end.bubble,
        ...(end.detail === undefined ? {} : { detail: end.detail }),
        count: end.count,
        ...(candidates?.success ? { candidates: candidates.data } : {}),
        ...(search?.success ? { search: search.data } : {}),
        ...(tool === "search_nearby" && output !== null ? { spots: spotPins(output) } : {}),
      },
    });

    if (output === null) return;
    if (tool === "update_itinerary" && output.saved === true) {
      const itinerary = ctx.itineraries.get(String(output.itineraryId));
      const diff = ItineraryDiffSchema.safeParse(output.diff);
      if (itinerary !== undefined && diff.success && diff.data.toVersion === itinerary.version) {
        emit({ type: "itinerary.updated", data: { itinerary, diff: diff.data } });
      }
    }
    if (tool === "verify_festival") {
      const { festivalId, result, checkedAt, sources, note } = output;
      const verified = FestivalVerifiedEventSchema.shape.data.safeParse({
        festivalId,
        result,
        checkedAt,
        sources,
        ...(note === undefined ? {} : { note }),
      });
      if (verified.success) emit({ type: "festival.verified", data: verified.data });
    }
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

  const subagentStart: HookCallback = async (input) => {
    if (input.hook_event_name !== "SubagentStart") return {};
    const staff = input.agent_type;
    if (!isStaff(staff)) return {};
    turn.startedStaff.add(staff);
    emit({
      type: "staff.start",
      data: {
        staff,
        task: STAFF_TASK[staff],
        bubble: staffStartBubble(staff, { hasItinerary: hasItinerary() }),
      },
    });
    return {
      hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: briefing(staff) },
    };
  };

  /** 旅程係を作り直しに戻した回数。評価の回数が進まないまま戻し続けないよう、上限を付ける */
  let sentBack = 0;
  const subagentStop: HookCallback = async (input) => {
    if (input.hook_event_name !== "SubagentStop" || input.agent_type !== "planner") return {};
    const evaluation = turn.lastEvaluation;
    if (evaluation === null || evaluation.passed || evaluation.round >= evaluation.maxRounds) {
      return {};
    }
    if (sentBack >= evaluation.maxRounds - 1 || ctx.signal.aborted) return {};
    // 時間の残りが少なければ、作り直しに戻さず、保存した旅程で報告してもらう
    if (!canRedoPlan(turn.startedAt)) return {};
    sentBack += 1;
    return { decision: "block", reason: nextStepAfter(evaluation) };
  };

  return {
    PreToolUse: [{ hooks: [preToolUse] }],
    PostToolUse: [{ matcher: `^${MCP_TOOL_PREFIX}`, hooks: [postToolUse] }],
    PostToolUseFailure: [{ matcher: `^${MCP_TOOL_PREFIX}`, hooks: [postToolUseFailure] }],
    SubagentStart: [{ hooks: [subagentStart] }],
    SubagentStop: [{ hooks: [subagentStop] }],
  };
}
