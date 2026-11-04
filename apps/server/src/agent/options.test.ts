import { existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testFestival } from "../domain/testFestivals";
import { createMatsuriMcpServer } from "../tools/mcpServer";
import { testToolContext } from "../tools/testContext";
import {
  type AgentModels,
  agentEnv,
  buildAgentOptions,
  createAgentWorkdir,
  ISOLATION_ENV,
} from "./options";
import type { AgentPrompts } from "./prompts";
import { buildVerifierOptions } from "./webVerifier";

const prompts: AgentPrompts = {
  concierge: "コンシェルジュ",
  common: "共通の前置き",
  researcher: "祭り調査係",
  scout: "周辺係",
  planner: "旅程係",
  verifier: "再確認",
  route: "行き方の調べ",
};

function options(overrides: { models?: AgentModels; resume?: string } = {}) {
  return buildAgentOptions({
    prompts,
    models: overrides.models ?? {},
    mcpServer: createMatsuriMcpServer(testToolContext([testFestival({ id: "suzunari-toro" })])),
    hooks: {},
    cwd: "/tmp/matsuri-agent-test",
    env: agentEnv({ PATH: "/usr/bin" }),
    abortController: new AbortController(),
    ...(overrides.resume ? { resume: overrides.resume } : {}),
  });
}

/** 組み込みの道具のうち、ファイル・シェル・Web に触れるもの */
const DANGEROUS_TOOLS = [
  "Bash",
  "PowerShell",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Skill",
  "TodoWrite",
];

describe("接客エージェントを開発環境から切り離す", () => {
  it("ファイルの設定を読み込まない", () => {
    expect(options().settingSources).toEqual([]);
  });

  it("組み込みの道具は Agent だけで、ファイル操作・シェル・Web を渡さない", () => {
    const opts = options();

    expect(opts.tools).toEqual(["Agent"]);
    expect(opts.allowedTools).toEqual(["Agent", "mcp__matsuri__*"]);
    expect(opts.permissionMode).toBe("dontAsk");
    expect(opts.disallowedTools).toContain("Agent(fork)");
    for (const tool of DANGEROUS_TOOLS) {
      expect(opts.allowedTools).not.toContain(tool);
    }
  });

  it("渡した MCP サーバー（matsuri）だけを使う", () => {
    const opts = options();

    expect(opts.strictMcpConfig).toBe(true);
    expect(Object.keys(opts.mcpServers ?? {})).toEqual(["matsuri"]);
    expect(opts.plugins).toEqual([]);
  });

  it("スタッフには担当の道具だけを渡す", () => {
    const { agents } = options();

    expect(agents?.researcher?.tools).toEqual(["mcp__matsuri__search_festivals"]);
    expect(agents?.scout?.tools).toEqual(["mcp__matsuri__search_nearby"]);
    expect(agents?.planner?.tools).toEqual([
      "mcp__matsuri__get_access",
      "mcp__matsuri__research_route",
      "mcp__matsuri__get_weather",
      "mcp__matsuri__search_nearby",
      "mcp__matsuri__search_lodging",
      "mcp__matsuri__update_itinerary",
    ]);
    expect(Object.keys(agents ?? {})).toEqual(["researcher", "scout", "planner"]);
  });

  it("自動のメモリ・バックグラウンドの作業・フォーク・組み込みのエージェントを止める", () => {
    const { env } = options();

    expect(env).toMatchObject({
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      CLAUDE_CODE_FORK_SUBAGENT: "0",
      CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    });
  });

  it("モデル名は環境変数から渡したものを使い、なければ指定しない", () => {
    const withModels = options({ models: { concierge: "model-a", staff: "model-b" } });
    const withoutModels = options();

    expect(withModels.model).toBe("model-a");
    expect(withModels.agents?.planner?.model).toBe("model-b");
    expect(withoutModels.model).toBeUndefined();
    expect(withoutModels.agents?.planner?.model).toBe("inherit");
  });

  it("旅程係だけ別のモデルにでき、祭り調査係と周辺係はスタッフのモデルのまま", () => {
    const opts = options({
      models: { concierge: "model-a", staff: "model-b", planner: "model-c" },
    });

    expect(opts.agents?.planner?.model).toBe("model-c");
    expect(opts.agents?.researcher?.model).toBe("model-b");
    expect(opts.agents?.scout?.model).toBe("model-b");
  });

  it("考える深さはコンシェルジュ medium・スタッフ low。スタッフの指示は共通の前置きから始める", () => {
    const opts = options();

    expect(opts.thinking).toEqual({ type: "adaptive" });
    expect(opts.effort).toBe("medium");
    for (const staff of ["researcher", "scout", "planner"] as const) {
      expect(opts.agents?.[staff]?.effort).toBe("low");
      expect(opts.agents?.[staff]?.prompt.startsWith("共通の前置き\n\n")).toBe(true);
    }
  });

  it("費用の上限は、指定したときだけ付ける", () => {
    expect(options().maxBudgetUsd).toBeUndefined();
    expect(
      buildAgentOptions({
        prompts,
        models: {},
        maxBudgetUsd: 0.5,
        mcpServer: createMatsuriMcpServer(testToolContext([])),
        hooks: {},
        cwd: "/tmp/matsuri-agent-test",
        env: {},
        abortController: new AbortController(),
      }).maxBudgetUsd,
    ).toBe(0.5);
  });

  it("会話の続きは resume で渡す", () => {
    expect(options({ resume: "abc" }).resume).toBe("abc");
    expect(options().resume).toBeUndefined();
  });
});

describe("agentEnv", () => {
  it("動かすのに要る変数と認証だけを渡し、サーバーの秘密情報は渡さない", () => {
    const env = agentEnv({
      PATH: "/usr/bin",
      Path: "C:\\Windows",
      USERPROFILE: "C:\\Users\\someone",
      ANTHROPIC_API_KEY: "test-key",
      ACCESS_PASSCODE: "passcode",
      DAILY_CHAT_LIMIT: "100",
      GCS_BUCKET: "bucket",
      MODEL_CONCIERGE: "model-a",
      MATSURI_AGENT_MODE: "live",
    });

    expect(env).toMatchObject({
      PATH: "/usr/bin",
      Path: "C:\\Windows",
      USERPROFILE: "C:\\Users\\someone",
      ANTHROPIC_API_KEY: "test-key",
    });
    for (const key of [
      "ACCESS_PASSCODE",
      "DAILY_CHAT_LIMIT",
      "GCS_BUCKET",
      "MODEL_CONCIERGE",
      "MATSURI_AGENT_MODE",
    ]) {
      expect(env).not.toHaveProperty(key);
    }
    expect(env).toMatchObject(ISOLATION_ENV);
  });

  it("API キーの前後の改行と空白を落とす", () => {
    expect(agentEnv({ ANTHROPIC_API_KEY: " test-key\r\n" }).ANTHROPIC_API_KEY).toBe("test-key");
  });

  it("空の認証の変数は渡さない（.env に空のまま書いても、ログイン済みの資格情報で動く）", () => {
    const env = agentEnv({ ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: " \n" });
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  });
});

describe("createAgentWorkdir", () => {
  it("一時ディレクトリの中に、空のディレクトリを作る", () => {
    const dir = createAgentWorkdir();
    try {
      expect(path.dirname(dir)).toBe(path.resolve(tmpdir()));
      expect(existsSync(dir)).toBe(true);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("再確認のエージェント", () => {
  const verifierOptions = (withTools: boolean) =>
    buildVerifierOptions({
      systemPrompt: "再確認",
      cwd: "/tmp/matsuri-agent-test",
      env: agentEnv({}),
      abortController: new AbortController(),
      withTools,
    });

  it("道具は Web の検索と取得だけで、設定も MCP も読まず、会話を残さない", () => {
    const opts = verifierOptions(true);

    expect(opts.tools).toEqual(["WebSearch", "WebFetch"]);
    expect(opts.allowedTools).toEqual(["WebSearch", "WebFetch"]);
    expect(opts).toMatchObject({
      permissionMode: "dontAsk",
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      persistSession: false,
    });
  });

  it("費用の上限を渡す", () => {
    const opts = buildVerifierOptions({
      systemPrompt: "再確認",
      cwd: "/tmp/matsuri-agent-test",
      env: {},
      abortController: new AbortController(),
      withTools: true,
      maxBudgetUsd: 0.2,
    });

    expect(opts.maxBudgetUsd).toBe(0.2);
  });

  it("差し戻しでは道具を使わせない", () => {
    const opts = verifierOptions(false);

    expect(opts.tools).toEqual([]);
    expect(opts.allowedTools).toEqual([]);
    expect(opts.maxTurns).toBe(1);
  });
});
