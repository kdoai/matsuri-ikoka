import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type SDKMessage,
  type SDKResultMessage,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import { backoffMs, classifyFailure } from "@matsuri-ikoka/agent-kit";
import type { IsoDate } from "@matsuri-ikoka/schema";
import type { FestivalStore } from "../data/festivalStore";
import type { StationPointIndex } from "../domain/travelEstimate";
import type { ItineraryStore } from "../session/sessionStore";
import type { CandidateChecker } from "../tools/candidateCheck";
import { newTurnState, type ToolContext } from "../tools/context";
import type { LodgingService } from "../tools/lodging";
import { createMatsuriMcpServer } from "../tools/mcpServer";
import type { RouteResearcher } from "../tools/routeResearch";
import type { FestivalVerifier } from "../tools/verifier";
import type { WeatherService } from "../tools/weather";
import { staffBriefing, turnPrompt } from "./briefing";
import { failureFromResult, toAgentError } from "./failures";
import { createAgentHooks } from "./hooks";
import { type AgentModels, buildAgentOptions } from "./options";
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
  lodging: LodgingService;
  verifier: FestivalVerifier;
  /** 候補を出す前の開催の確かめ */
  candidateChecks?: CandidateChecker;
  /** 駅の位置（出発の駅からの所要時間の見積もり） */
  stations?: StationPointIndex;
  /** 出発の駅から会場の最寄り駅までの行き方の調べ */
  routes?: RouteResearcher;
  prompts: AgentPrompts;
  models: AgentModels;
  /** 1回の発言の費用の上限（米ドル） */
  maxBudgetUsd?: number | undefined;
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

  /** 費用と使用量（ログ用）。費用は SDK の推定で、トークンはサブエージェントの分を含む */
  usage(): Record<string, number> | null {
    const result = this.#result;
    if (result === null) return null;
    const models = Object.values(result.modelUsage ?? {});
    const sum = (
      key: "inputTokens" | "outputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens",
    ) => models.reduce((total, usage) => total + (usage[key] ?? 0), 0);
    return {
      totalCostUsd: result.total_cost_usd,
      durationMs: result.duration_ms,
      apiMs: result.duration_api_ms,
      numTurns: result.num_turns,
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      cacheReadInputTokens: sum("cacheReadInputTokens"),
      cacheCreationInputTokens: sum("cacheCreationInputTokens"),
    };
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
    const failure = failureFromResult(this.#result, this.#assistantError);
    if (failure !== null) throw toAgentError(failure);
  }
}

export class ClaudeAgentRunner implements AgentRunner {
  readonly mode = "live" as const;
  readonly #deps: ClaudeRunnerDeps;
  readonly #query: QueryFn;

  constructor(deps: ClaudeRunnerDeps) {
    this.#deps = deps;
    this.#query = deps.query ?? ((params) => sdkQuery(params));
  }

  async runTurn({ session, message, signal, progress }: TurnInput, emit: EmitEvent): Promise<void> {
    const deps = this.#deps;
    const turn = newTurnState();
    const ctx: ToolContext = {
      session,
      turn,
      signal,
      festivals: deps.festivals,
      itineraries: deps.itineraries,
      weather: deps.weather,
      lodging: deps.lodging,
      verifier: deps.verifier,
      ...(deps.candidateChecks ? { candidateChecks: deps.candidateChecks } : {}),
      ...(deps.stations ? { stations: deps.stations } : {}),
      ...(deps.routes ? { routes: deps.routes } : {}),
      today: deps.today,
      now: deps.now,
    };
    let emitted = 0;
    const counted: EmitEvent = (event) => {
      emitted += 1;
      emit(event);
    };
    ctx.emit = counted;
    const prompt = turnPrompt(ctx, message);
    /** 直前の試みで、Agent SDK がセッションを名乗ったか（続きの会話を読めたか） */
    let initSeen = false;
    let usage: Record<string, number> | null = null;
    const started = Date.now();
    /** Agent SDK が起動を終える（init を受け取る）までの時間。遅れが起動か API かを分ける */
    let initMs: number | null = null;

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
          maxBudgetUsd: deps.maxBudgetUsd,
          abortController: controller,
          resume,
          ...(deps.stderr ? { stderr: deps.stderr } : {}),
        });
        for await (const msg of this.#query({ prompt, options })) {
          // スタッフが考えている間も、Agent SDK の知らせが届いていれば進みがある
          progress?.();
          reply.handle(msg);
          if (reply.sessionId !== null) {
            initMs ??= Date.now() - started;
            initSeen = true;
            session.agentSessionId = reply.sessionId;
          }
        }
        usage = reply.usage();
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
        if (signal.aborted || error instanceof AgentError) throw error;
        throw toAgentError(classifyFailure(error));
      }
    };

    try {
      await run();
    } catch (failure) {
      // まだ何も送っていなければ、1回だけやり直す。続きの会話を読めなかったときは、店の記録だけで新しく始める
      if (!(failure instanceof AgentError) || !failure.retryable || emitted > 0) throw failure;
      if (!initSeen) session.agentSessionId = null;
      await sleep(backoffMs(1), undefined, { signal });
      await run();
    } finally {
      session.stage = nextStage(session.stage, turn, session.itineraryId !== null);
      // 相談ごとの費用・トークン・所要時間・呼んだ道具を残す。会話の文は残さない
      console.info(
        JSON.stringify({
          kind: "turn",
          stage: session.stage,
          elapsedMs: Date.now() - started,
          staff: [...turn.startedStaff],
          tools: turn.toolCalls,
          ...(initMs === null ? {} : { initMs }),
          ...(usage ?? {}),
        }),
      );
    }
  }
}
