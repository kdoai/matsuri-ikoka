import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { errorForLog } from "../log";
import { TOOL_TIMEOUT_MS, type ToolContext } from "./context";
import { MATSURI_TOOLS, type MatsuriTool, ToolError } from "./matsuriTools";

/** プロセス内の MCP サーバーの名前。ツールは mcp__matsuri__<ツール名> で呼ばれる */
export const MCP_SERVER_NAME = "matsuri";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/**
 * SDK がツールの呼び出しを打ち切る外側の安全網（ミリ秒）。ツールごとの上限は runTool で守り、
 * 上限で止めたときの短い文がエージェントに届くよう、いちばん長いツールの上限より余裕を持たせる
 */
export const MCP_TOOL_CALL_TIMEOUT_MS = Math.max(...Object.values(TOOL_TIMEOUT_MS)) + 15_000;

export type ToolCallResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * ツールを1回動かす。時間の上限を超えたら打ち切り、失敗はエージェントが読める短い文で返す。
 * ログにはツール名と所要時間と成否だけを残す（入力の文は残さない）。
 */
export async function runTool(
  def: MatsuriTool,
  args: unknown,
  ctx: ToolContext,
): Promise<ToolCallResult> {
  const started = Date.now();
  if (ctx.signal.aborted) {
    log(def.name, started, false);
    return { content: [{ type: "text", text: "この発言の返答は止められました" }], isError: true };
  }
  const controller = new AbortController();
  // 発言が止まったとき（時間切れ・接続の切断）も、ツールの時間の上限と同じように止める
  const signal = AbortSignal.any([ctx.signal, controller.signal]);
  let timer: NodeJS.Timeout | undefined;
  let onTurnAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ToolError(`時間の上限（${def.timeoutMs / 1000}秒）を超えました`));
    }, def.timeoutMs);
    onTurnAbort = () => reject(new ToolError("この発言の返答は止められました"));
    ctx.signal.addEventListener("abort", onTurnAbort, { once: true });
  });
  try {
    const output = await Promise.race([def.run(args, ctx, signal), stopped]);
    log(def.name, started, true);
    return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
  } catch (error) {
    log(def.name, started, false);
    const message =
      error instanceof ToolError
        ? error.message
        : error instanceof z.ZodError
          ? `入力の形が正しくありません：${error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("、")}`
          : "ツールの中でエラーが起きました";
    if (!(error instanceof ToolError || error instanceof z.ZodError)) {
      console.error(JSON.stringify({ kind: "tool_failed", tool: def.name, ...errorForLog(error) }));
    }
    return { content: [{ type: "text", text: message }], isError: true };
  } finally {
    clearTimeout(timer);
    if (onTurnAbort) ctx.signal.removeEventListener("abort", onTurnAbort);
  }
}

function log(name: string, started: number, ok: boolean) {
  console.info(JSON.stringify({ kind: "tool", tool: name, ok, durationMs: Date.now() - started }));
}

/** 7つのツールを、相談ごとの文脈を閉じ込めたプロセス内の MCP サーバーにする */
export function createMatsuriMcpServer(ctx: ToolContext) {
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "1.0.0",
    tools: MATSURI_TOOLS.map((def) =>
      tool(def.name, def.description, def.input, (args) => runTool(def, args, ctx), {
        alwaysLoad: true,
      }),
    ),
    alwaysLoad: true,
    timeout: MCP_TOOL_CALL_TIMEOUT_MS,
  });
}
