import { randomBytes } from "node:crypto";
import {
  type SDKMessage,
  type SDKResultMessage,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import type { IsoDate } from "@matsuri-ikoka/schema";
import type { FestivalStore } from "../data/festivalStore";
import type { ItineraryStore } from "../session/sessionStore";
import { newTurnState, type ToolContext } from "../tools/context";
import { createMatsuriMcpServer } from "../tools/mcpServer";
import type { FestivalVerifier } from "../tools/verifier";
import type { WeatherService } from "../tools/weather";
import { staffBriefing, turnPrompt } from "./briefing";
import { createAgentHooks } from "./hooks";
import { buildAgentOptions } from "./options";
import type { AgentPrompts } from "./prompts";
import {
  AgentError,
  type AgentRunner,
  type EmitEvent,
  nextStage,
  type QueryFn,
  type TurnInput,
} from "./runner";

// live：Agent SDK でコンシェルジュと3人のスタッフを動かす。
// 会話は Agent SDK のセッションを resume して続ける。フックから出たイベントと、
// コンシェルジュの返答の文（message.delta）を SSE に流す。

export interface ClaudeRunnerDeps {
  festivals: FestivalStore;
  itineraries: ItineraryStore;
  weather: WeatherService;
  verifier: FestivalVerifier;
  prompts: AgentPrompts;
  models: { concierge?: string | undefined; staff?: string | undefined };
  /** エージェントの作業ディレクトリ（空の一時ディレクトリ） */
  cwd: string;
  /** エージェントのプロセスに渡す環境変数（agentEnv で絞ったもの） */
  env: Record<string, string>;
  today: () => IsoDate;
  now: () => string;
  query?: QueryFn;
  /** ツールの MCP サーバーを作る関数（テストで差し替える） */
  createToolServer?: typeof createMatsuriMcpServer;
  stderr?: (data: string) => void;
}

/** 文の切れ目。返答の文は、ここまでたまったら1つの message.delta にして送る */
const SENTENCE_END = /[。！？!?\n]/g;

/** コンシェルジュの返答の文を、文の切れ目ごとに message.delta にする */
export class ReplyStream {
  readonly #emit: EmitEvent;
  readonly #prefix = `m-${randomBytes(4).toString("hex")}`;
  #messages = 0;
  #messageId: string | null = null;
  #buffer = "";
  #result: SDKResultMessage | null = null;
  #assistantError: string | null = null;
  sessionId: string | null = null;

  constructor(emit: EmitEvent) {
    this.#emit = emit;
  }

  handle(message: SDKMessage): void {
    switch (message.type) {
      case "system":
        if (message.subtype === "init") this.sessionId = message.session_id;
        break;
      case "stream_event":
        // コンシェルジュ（本体）の返答だけを流す。スタッフの文は報告としてコンシェルジュに渡る
        if (message.parent_tool_use_id === null) this.#onStreamEvent(message.event);
        break;
      case "assistant":
        if (message.parent_tool_use_id === null && message.error !== undefined) {
          this.#assistantError = message.error;
        }
        break;
      case "result":
        this.#result = message;
        break;
      default:
        break;
    }
  }

  #onStreamEvent(event: Extract<SDKMessage, { type: "stream_event" }>["event"]): void {
    switch (event.type) {
      case "message_start":
        this.#flush(true);
        this.#messageId = null;
        break;
      case "content_block_delta":
        if (event.delta.type === "text_delta") {
          this.#buffer += event.delta.text;
          this.#flush(false);
        }
        break;
      case "content_block_stop":
      case "message_stop":
        this.#flush(true);
        break;
      default:
        break;
    }
  }

  #flush(all: boolean): void {
    let text: string;
    if (all) {
      text = this.#buffer;
      this.#buffer = "";
    } else {
      const ends = [...this.#buffer.matchAll(SENTENCE_END)];
      const last = ends.at(-1);
      if (last?.index === undefined) return;
      text = this.#buffer.slice(0, last.index + 1);
      this.#buffer = this.#buffer.slice(last.index + 1);
    }
    if (text.trim() === "") return;
    this.#messageId ??= `${this.#prefix}-${++this.#messages}`;
    this.#emit({ type: "message.delta", data: { messageId: this.#messageId, text } });
  }

  /** 最後まで受け取ったあと、残りの文を流し、失敗なら AgentError を投げる */
  finish(): void {
    this.#flush(true);
    const result = this.#result;
    if (result === null) {
      throw new AgentError(
        "upstream_unavailable",
        "返答を最後まで受け取れませんでした。もう一度送ってください。",
        true,
      );
    }
    if (result.subtype === "error_max_turns") {
      throw new AgentError(
        "internal",
        "考えがまとまりきりませんでした。もう一度送ってください。",
        true,
      );
    }
    if (result.subtype !== "success" || result.is_error) {
      throw errorFromAssistant(this.#assistantError);
    }
  }
}

/** Claude からの失敗の種類を、利用者に見せるエラーに変える */
export function errorFromAssistant(kind: string | null): AgentError {
  switch (kind) {
    case "rate_limit":
    case "overloaded":
    case "server_error":
      return new AgentError(
        "upstream_unavailable",
        "いま混み合っています。少し待ってから、もう一度送ってください。",
        true,
      );
    case "authentication_failed":
    case "oauth_org_not_allowed":
    case "account_on_hold":
    case "billing_error":
    case "cloud_credential_error":
      console.error(JSON.stringify({ kind: "agent_unavailable", reason: kind }));
      return new AgentError(
        "upstream_unavailable",
        "いまは接客の準備ができていません。時間をおいて試してください。",
        false,
      );
    default:
      return new AgentError(
        "internal",
        "うまく返事を作れませんでした。もう一度送ってください。",
        true,
      );
  }
}

/** query が投げた例外を、利用者に見せるエラーに変える。認証の失敗はやり直さない */
export function errorFromException(error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  const text = error instanceof Error ? error.message : String(error);
  if (/authenticat|oauth|api key|credential|\b40[13]\b/i.test(text)) {
    return errorFromAssistant("authentication_failed");
  }
  if (/overloaded|rate.?limit|\b429\b|\b5\d\d\b/i.test(text))
    return errorFromAssistant("overloaded");
  console.error("[agent] query failed", error);
  return new AgentError(
    "upstream_unavailable",
    "接客の担当とつながりませんでした。もう一度送ってください。",
    true,
  );
}

export class ClaudeAgentRunner implements AgentRunner {
  readonly mode = "live" as const;
  readonly #deps: ClaudeRunnerDeps;
  readonly #query: QueryFn;

  constructor(deps: ClaudeRunnerDeps) {
    this.#deps = deps;
    this.#query = deps.query ?? ((params) => sdkQuery(params));
  }

  async runTurn({ session, message, signal }: TurnInput, emit: EmitEvent): Promise<void> {
    const deps = this.#deps;
    const turn = newTurnState();
    const ctx: ToolContext = {
      session,
      turn,
      festivals: deps.festivals,
      itineraries: deps.itineraries,
      weather: deps.weather,
      verifier: deps.verifier,
      today: deps.today,
      now: deps.now,
    };
    let emitted = 0;
    const counted: EmitEvent = (event) => {
      emitted += 1;
      emit(event);
    };
    const prompt = turnPrompt(ctx, message);
    /** 直前の試みで、Agent SDK がセッションを名乗ったか（続きの会話を読めたか） */
    let initSeen = false;

    const attempt = async (resume: string | undefined) => {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      if (signal.aborted) abort();
      signal.addEventListener("abort", abort, { once: true });
      const reply = new ReplyStream(counted);
      try {
        const options = buildAgentOptions({
          prompts: deps.prompts,
          models: deps.models,
          mcpServer: (deps.createToolServer ?? createMatsuriMcpServer)(ctx),
          hooks: createAgentHooks({
            ctx,
            emit: counted,
            briefing: (staff) => staffBriefing(ctx, staff),
          }),
          cwd: deps.cwd,
          env: deps.env,
          abortController: controller,
          resume,
          ...(deps.stderr ? { stderr: deps.stderr } : {}),
        });
        for await (const msg of this.#query({ prompt, options })) {
          reply.handle(msg);
          if (reply.sessionId !== null) {
            initSeen = true;
            session.agentSessionId = reply.sessionId;
          }
        }
        reply.finish();
      } finally {
        signal.removeEventListener("abort", abort);
      }
    };

    const run = async () => {
      initSeen = false;
      try {
        await attempt(session.agentSessionId ?? undefined);
      } catch (error) {
        throw signal.aborted ? error : errorFromException(error);
      }
    };

    try {
      await run();
    } catch (failure) {
      // まだ何も送っていなければ、1回だけやり直す。続きの会話を読めなかったときは、店の記録だけで新しく始める
      if (!(failure instanceof AgentError) || !failure.retryable || emitted > 0) throw failure;
      if (!initSeen) session.agentSessionId = null;
      await run();
    } finally {
      session.stage = nextStage(session.stage, turn, session.itineraryId !== null);
    }
  }
}
