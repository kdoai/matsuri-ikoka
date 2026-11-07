import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { GUIDE_MCP_SERVER_NAME } from "../agent/options";
import { runTool } from "../tools/mcpServer";
import { GUIDE_TOOLS, type GuideToolContext } from "./tools";

/**
 * SDK がツールの呼び出しを打ち切る外側の安全網（ミリ秒）。上限で止めたときの短い文がエージェントに届くよう、
 * いちばん長いツールの上限より余裕を持たせる
 */
export const GUIDE_MCP_TOOL_CALL_TIMEOUT_MS =
  Math.max(...GUIDE_TOOLS.map((def) => def.timeoutMs)) + 15_000;

/** ガイドのツールを、発言ごとの文脈を閉じ込めたプロセス内の MCP サーバーにする */
export function createGuideMcpServer(ctx: GuideToolContext) {
  return createSdkMcpServer({
    name: GUIDE_MCP_SERVER_NAME,
    version: "1.0.0",
    tools: GUIDE_TOOLS.map((def) =>
      tool(def.name, def.description, def.input, (args) => runTool(def, args, ctx), {
        alwaysLoad: true,
      }),
    ),
    alwaysLoad: true,
    timeout: GUIDE_MCP_TOOL_CALL_TIMEOUT_MS,
  });
}
