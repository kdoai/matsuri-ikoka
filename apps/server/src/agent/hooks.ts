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
// - SubagentStop → 旅程係が、保存しないまま、または評価の基準に届かないまま（回数が残っているのに）終えようとしたら、作り直しに戻す

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
/** 1回の発言で、同じスタッフを呼べる回数の上限（呼び出しが失敗したときの呼び直しを含む） */
export const MAX_STAFF_CALLS = 2;

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

/** 旅程係を、保存しないまま終えようとしたときに戻す回数の上限 */
const MAX_UNSAVED_SEND_BACKS = 2;
/** 差し戻しの文の終わりに必ず添える */
const UNSAVED_TAIL =
  "調べられなかった区間や時刻は、推測で埋めず、書かないまま保存できます（足りないものは gaps に残ります）";
const UNSAVED_NEXT_STEP = `まだ旅程を保存できていません。失敗の理由（errors や入力の形の指摘）を読んで直し、update_itinerary を呼び直してください。${UNSAVED_TAIL}`;

/** 保存できなかった理由の種類ごとに、直し方を伝える */
const SAVE_ERROR_ADVICE: Readonly<Record<string, readonly string[]>> = {
  "予定の時刻を並べ直してください（移動の時間・祭りの会場に着く余裕・帰りの最終に合わせる）": [
    "out_of_order",
    "overlap",
    "not_enough_move_time",
    "festival_time_conflict",
    "arrival_buffer",
    "after_last_return",
  ],
  "行く日に休みか営業時間の外の場所は、時刻をずらすか、調べた別の場所に替えてください": [
    "closed_day",
    "outside_hours",
    "after_last_entry",
  ],
  "場所と祭りは、調べた結果にある ID と、開催する日だけを使ってください": [
    "unknown_spot",
    "unknown_festival",
    "festival_not_on_date",
  ],
  "1日目の最初の予定を出発の駅からの移動にし、所要時間は research_route の結果か見積もりをそのまま使ってください":
    ["start_not_origin", "origin_move_too_short", "over_travel_limit"],
  "主役の祭りを、選んだ日の旅程に入れてください": [
    "anchor_visit_missing",
    "anchor_date_missing",
    "anchor_outside_dates",
    "anchor_festival_changed",
  ],
};
/** 保存を断る点検の種類（サーバーが決めた名前だけ。これ以外の文字列は reason に入れない） */
const SAVE_ERROR_CODES: readonly string[] = Object.values(SAVE_ERROR_ADVICE).flat();
/** 入力の形の検査で断られたことを示す印（Zod の種類と、MCP の入力の検査の文） */
const SHAPE_FAILURE_MARKERS =
  /\b(?:invalid_type|invalid_value|invalid_union|too_small|too_big|unrecognized_keys)\b|Invalid arguments|入力の(?:形|検査)/;

/** この発言で、旅程の保存がどう断られたか（サーバーが受け取ったツールの結果から） */
export interface SaveFailure {
  shape: boolean;
  codes: string[];
}

/**
 * 保存しないまま終えようとした旅程係に返す、差し戻しの文。
 * 理由は、ツールの結果（saveFailure）と、旅程係の最後の文（lastMessage）から種類だけを読む。
 * 最後の文は信用しない入力として、決めた種類の名前と印があるかだけを見て、文は写さない
 */
export function unsavedNextStep(input: {
  lastMessage: string | undefined;
  saveFailure: SaveFailure | null;
  triedSave: boolean;
}): string {
  const message = typeof input.lastMessage === "string" ? input.lastMessage.slice(0, 4000) : "";
  const named = SAVE_ERROR_CODES.filter((code) => new RegExp(`\\b${code}\\b`).test(message));
  const codes = SAVE_ERROR_CODES.filter(
    (code) => input.saveFailure?.codes.includes(code) || named.includes(code),
  );
  const shape = input.saveFailure?.shape === true || SHAPE_FAILURE_MARKERS.test(message);
  const steps: string[] = [];
  if (shape) {
    steps.push(
      "update_itinerary が入力の形の検査で断られました。指摘の場所（path）と種類（code）が指す項目だけを直し、ほかは変えずに呼び直してください",
    );
  }
  if (codes.length > 0) {
    const advice = Object.entries(SAVE_ERROR_ADVICE)
      .filter(([, group]) => group.some((code) => codes.includes(code)))
      .map(([text]) => text);
    steps.push(
      `update_itinerary が点検で断られました（${codes.join("・")}）。${advice.join("。")}。直したら update_itinerary を呼び直してください`,
    );
  }
  if (steps.length === 0 && !input.triedSave && input.saveFailure === null) {
    steps.push(
      "まだ update_itinerary を呼んでいません。調べた結果で旅程を組み、update_itinerary で保存してください",
    );
  }
  if (steps.length === 0) return UNSAVED_NEXT_STEP;
  return `${steps.join("。")}。${UNSAVED_TAIL}`;
}

/** ログに残す、入力の検査の指摘の数の上限 */
const MAX_LOGGED_ISSUES = 8;

/**
 * ツールの失敗の文から、入力の検査の指摘の場所と種類だけを取り出す（ログ用）。
 * 文には入力の値が混ざることがあるので、場所（添字は # にする）と種類のほかは残さない。読めなければ空
 */
export function inputIssues(error: unknown): string[] {
  if (typeof error !== "string") return [];
  const start = error.indexOf("[");
  const end = error.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(error.slice(start, end + 1));
  } catch {
    return [];
  }
  const issues = z
    .array(
      z.looseObject({
        code: z.string().regex(/^[a-z_]+$/),
        path: z.array(z.union([z.string(), z.number()])),
      }),
    )
    .safeParse(parsed);
  if (!issues.success) return [];
  return issues.data
    .slice(0, MAX_LOGGED_ISSUES)
    .map(
      ({ code, path }) =>
        `${path.map((part) => (typeof part === "number" ? "#" : part)).join(".")}:${code}`,
    );
}

export interface HookDeps {
  ctx: ToolContext;
  emit: (event: SseEvent) => void;
  /** サブエージェントの開始時に足す文脈 */
  briefing: (staff: Staff) => string | Promise<string>;
}

type Hooks = Partial<Record<HookEvent, HookCallbackMatcher[]>>;

export function createAgentHooks({ ctx, emit, briefing }: HookDeps): Hooks {
  const { turn } = ctx;
  /** tool.start を出したツールの呼び出しと、そのスタッフ */
  const started = new Map<string, { tool: ToolName; staff: StaffId }>();
  /** この発言で呼ぶと決め、まだ失敗していないスタッフ（同じスタッフは報告を使い、呼び直さない） */
  const requested = new Set<Staff>();
  /** この発言でスタッフを呼んだ回数（失敗して呼び直した分も数える） */
  const staffCalls = new Map<Staff, number>();
  /** スタッフを呼んだ Agent の呼び出しと、呼んだスタッフ（失敗したときに呼び直せるようにする） */
  const agentCalls = new Map<string, Staff>();
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
      const calls = staffCalls.get(target) ?? 0;
      if (calls >= MAX_STAFF_CALLS) {
        return deny(
          `この発言では、${STAFF_NAMES[target]}にもう${MAX_STAFF_CALLS}回頼みました。ここまでに分かったことで続けてください`,
        );
      }
      requested.add(target);
      staffCalls.set(target, calls + 1);
      const callId = input.tool_use_id || toolUseId || "";
      if (callId !== "") agentCalls.set(callId, target);
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

  /**
   * スタッフを呼ぶ Agent の呼び出しそのものが失敗した。呼んだことを取り消し、同じスタッフを呼び直せるようにする
   * （呼べる回数の上限は MAX_STAFF_CALLS で残る）
   */
  const agentFailure: HookCallback = async (input, toolUseId) => {
    if (input.hook_event_name !== "PostToolUseFailure") return {};
    const callId = input.tool_use_id || toolUseId || "";
    const type = z.object({ subagent_type: z.string() }).safeParse(input.tool_input);
    const fromInput =
      type.success && isStaff(type.data.subagent_type) ? type.data.subagent_type : null;
    const staff = agentCalls.get(callId) ?? fromInput;
    agentCalls.delete(callId);
    if (staff === null) return {};
    requested.delete(staff);
    // 失敗の文は残さない。どのスタッフの呼び出しが何回目で失敗したかだけを残す
    console.info(
      JSON.stringify({ kind: "staff_call_failed", staff, calls: staffCalls.get(staff) ?? 0 }),
    );
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

  /** この発言で、旅程の保存がどう断られたか。保存できたら消す */
  let saveFailure: SaveFailure | null = null;

  const postToolUse: HookCallback = async (input, toolUseId) => {
    if (input.hook_event_name !== "PostToolUse") return {};
    const output = extractToolOutput(input.tool_response);
    if (toolNameOf(input.tool_name) === "update_itinerary" && output !== null) {
      if (output.saved === true) {
        saveFailure = null;
      } else {
        const errors = z.array(z.looseObject({ code: z.string() })).safeParse(output.errors);
        saveFailure = {
          shape: false,
          codes: errors.success ? errors.data.map((error) => error.code) : [],
        };
      }
    }
    endTool(input.tool_use_id || toolUseId || "", output);
    return {};
  };

  const postToolUseFailure: HookCallback = async (input, toolUseId) => {
    if (input.hook_event_name !== "PostToolUseFailure") return {};
    if (toolNameOf(input.tool_name) === "update_itinerary")
      saveFailure = { shape: true, codes: [] };
    // 書き直しの多い項目をつかむため、入力の検査の指摘の場所と種類だけを残す（値は残さない）
    console.info(
      JSON.stringify({
        kind: "tool_failure",
        tool: toolNameOf(input.tool_name) ?? "unknown",
        issues: inputIssues(input.error),
      }),
    );
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
      hookSpecificOutput: {
        hookEventName: "SubagentStart",
        additionalContext: await briefing(staff),
      },
    };
  };

  /** 旅程係を作り直しに戻した回数。評価の回数が進まないまま戻し続けないよう、上限を付ける */
  let sentBack = 0;
  /** 旅程係を、保存しないまま終えようとしたので戻した回数 */
  let unsavedSentBack = 0;
  /**
   * 頼まれた旅程を保存しないまま終えようとしている。まだ旅程がない相談か、この発言で保存を試して失敗したまま。
   * 中止と分かった祭りの旅程は保存しないので、戻さない。旅程についての質問に答えただけのときも戻さない
   */
  const leavingUnsaved = () =>
    !turn.savedItinerary &&
    turn.lastEvaluation === null &&
    ctx.session.cancelledAnchor === null &&
    (ctx.session.itineraryId === null || turn.toolCalls.includes("update_itinerary"));

  const subagentStop: HookCallback = async (input) => {
    if (input.hook_event_name !== "SubagentStop" || input.agent_type !== "planner") return {};
    // 時間の残りが少なければ、作り直しに戻さず、そこまでの結果で報告してもらう
    if (ctx.signal.aborted || !canRedoPlan(turn.startedAt)) return {};
    if (leavingUnsaved()) {
      if (unsavedSentBack >= MAX_UNSAVED_SEND_BACKS) return {};
      unsavedSentBack += 1;
      return {
        decision: "block",
        reason: unsavedNextStep({
          lastMessage: input.last_assistant_message,
          saveFailure,
          triedSave: turn.toolCalls.includes("update_itinerary"),
        }),
      };
    }
    const evaluation = turn.lastEvaluation;
    if (evaluation === null || evaluation.passed || evaluation.round >= evaluation.maxRounds) {
      return {};
    }
    if (sentBack >= evaluation.maxRounds - 1) return {};
    sentBack += 1;
    return { decision: "block", reason: nextStepAfter(evaluation) };
  };

  return {
    PreToolUse: [{ hooks: [preToolUse] }],
    PostToolUse: [{ matcher: `^${MCP_TOOL_PREFIX}`, hooks: [postToolUse] }],
    PostToolUseFailure: [
      { matcher: `^${MCP_TOOL_PREFIX}`, hooks: [postToolUseFailure] },
      { matcher: "^(?:Agent|Task)$", hooks: [agentFailure] },
    ],
    // 旅程係の前に先の調べを待つことがあるので、時間の枠を広げる（秒）
    SubagentStart: [{ hooks: [subagentStart], timeout: 90 }],
    SubagentStop: [{ hooks: [subagentStop] }],
  };
}
