import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ToolContext } from "./context";
import { MATSURI_TOOLS, type MatsuriTool, ToolError } from "./matsuriTools";

/** プロセス内の MCP サーバーの名前。ツールは mcp__matsuri__<ツール名> で呼ばれる */
export const MCP_SERVER_NAME = "matsuri";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

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
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ToolError(`時間の上限（${def.timeoutMs / 1000}秒）を超えました`));
    }, def.timeoutMs);
  });
  try {
    const output = await Promise.race([def.run(args, ctx, controller.signal), timeout]);
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
      console.error(`[tool] ${def.name} failed`, error);
    }
    return { content: [{ type: "text", text: message }], isError: true };
  } finally {
    clearTimeout(timer);
  }
}

function log(name: string, started: number, ok: boolean) {
  console.info(JSON.stringify({ kind: "tool", tool: name, ok, durationMs: Date.now() - started }));
}

/** 6つのツールを、相談ごとの文脈を閉じ込めたプロセス内の MCP サーバーにする */
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
    // ツールごとの上限（最大20秒）は runTool で守る。これはその外側の安全網
    timeout: 30_000,
  });
}
