import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AgentDefinition,
  McpSdkServerConfigWithInstance,
  Options,
} from "@anthropic-ai/claude-agent-sdk";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "../tools/mcpServer";
import type { Staff } from "./bubbles";
import { TOOLS_BY_STAFF } from "./hooks";
import type { AgentPrompts } from "./prompts";

// 接客エージェントを開発環境から切り離して動かすためのオプション（docs/architecture.md）。
// - ファイルの設定（user・project・local）を読まない：settingSources: []
// - 組み込みの道具はサブエージェントを呼ぶ Agent だけ。ファイル操作・シェル・Web は渡さない
// - 渡した MCP サーバー（matsuri）だけを使う：strictMcpConfig
// - 自動のメモリ・バックグラウンドの作業・フォーク・組み込みのエージェントを止める
// - 作業ディレクトリは空の一時ディレクトリ
// - エージェントのプロセスに渡す環境変数は、動かすのに要るものだけにする（合言葉などは渡さない）

/** 接客エージェントのプロセスに渡す環境変数の名前（大文字・小文字は問わない） */
const PASS_THROUGH_ENV = [
  // 動かすのに要るもの
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
  "USERNAME",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TZ",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  // 通信
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  // Claude への認証（API キー、またはログイン済みの資格情報の場所）
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

/** 切り離しのために必ず付ける環境変数 */
export const ISOLATION_ENV = {
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  // サブエージェントの報告を待ってから返答させる
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  CLAUDE_CODE_FORK_SUBAGENT: "0",
  CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1",
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  CLAUDE_AGENT_SDK_CLIENT_APP: "matsuri-ikoka-server",
} as const;

/** 環境変数を、渡してよいものだけに絞り、切り離しの変数を足す */
export function agentEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const allowed = new Set<string>(PASS_THROUGH_ENV);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && allowed.has(key.toUpperCase())) env[key] = value;
  }
  return { ...env, ...ISOLATION_ENV };
}

/** 空の一時ディレクトリを作る。エージェントの作業ディレクトリにする */
export function createAgentWorkdir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "matsuri-agent-"));
  if (readdirSync(dir).length > 0) throw new Error("作業ディレクトリが空ではありません");
  return dir;
}

const STAFF_DESCRIPTIONS: Record<Staff, string> = {
  researcher:
    "祭り調査係。希望日・出発地・日帰りか宿泊かがそろったら、条件に合う祭りの候補を search_festivals で探して報告する。",
  scout:
    "周辺係。利用者が選んだ祭りの前後に寄れる観光・食・休憩の場所を search_nearby で探して報告する。",
  planner:
    "旅程係。移動の目安と天気を確かめ、時刻つきの旅程を組んで update_itinerary で保存する。旅程の修正とこだわりの切り替えも受け持つ。",
};

const STAFF_MAX_TURNS: Record<Staff, number> = { researcher: 4, scout: 4, planner: 10 };

export interface AgentOptionsInput {
  prompts: AgentPrompts;
  models: { concierge?: string | undefined; staff?: string | undefined };
  mcpServer: McpSdkServerConfigWithInstance;
  hooks: Options["hooks"];
  cwd: string;
  env: Record<string, string>;
  abortController: AbortController;
  resume?: string | undefined;
  stderr?: (data: string) => void;
}

function staffAgent(staff: Staff, input: AgentOptionsInput): AgentDefinition {
  return {
    description: STAFF_DESCRIPTIONS[staff],
    prompt: input.prompts[staff],
    tools: TOOLS_BY_STAFF[staff].map((tool) => `${MCP_TOOL_PREFIX}${tool}`),
    model: input.models.staff ?? "inherit",
    maxTurns: STAFF_MAX_TURNS[staff],
    background: false,
  };
}

/** コンシェルジュ（本体）と3人のスタッフ（サブエージェント）のオプション */
export function buildAgentOptions(input: AgentOptionsInput): Options {
  return {
    systemPrompt: input.prompts.concierge,
    ...(input.models.concierge ? { model: input.models.concierge } : {}),
    agents: {
      researcher: staffAgent("researcher", input),
      scout: staffAgent("scout", input),
      planner: staffAgent("planner", input),
    },
    // 組み込みの道具は Agent だけ。MCP の道具はこの指定に関係なく mcpServers から入る
    tools: ["Agent"],
    allowedTools: ["Agent", `${MCP_TOOL_PREFIX}*`],
    disallowedTools: ["Agent(fork)"],
    permissionMode: "dontAsk",
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: { [MCP_SERVER_NAME]: input.mcpServer },
    plugins: [],
    cwd: input.cwd,
    env: input.env,
    hooks: input.hooks,
    includePartialMessages: true,
    maxTurns: 12,
    abortController: input.abortController,
    ...(input.resume ? { resume: input.resume } : {}),
    ...(input.stderr ? { stderr: input.stderr } : {}),
  };
}
