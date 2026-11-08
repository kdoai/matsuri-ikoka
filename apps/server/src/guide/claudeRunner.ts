import { setTimeout as sleep } from "node:timers/promises";
import { type Options, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { backoffMs, classifyFailure } from "@matsuri-ikoka/agent-kit";
import type { IsoDate } from "@matsuri-ikoka/schema";
import { ReplyStream } from "../agent/claudeRunner";
import { toAgentError } from "../agent/failures";
import { buildGuideOptions } from "../agent/options";
import { AgentError, type QueryFn } from "../agent/runner";
import type { FestivalStore } from "../data/festivalStore";
import type { OsmPlaceIndex } from "../domain/osmPlaces";
import type { StationPointIndex } from "../domain/travelEstimate";
import type { ItineraryStore } from "../session/sessionStore";
import { newTurnState, type ToolContext } from "../tools/context";
import type { LodgingService } from "../tools/lodging";
import type { NearbyResearcher } from "../tools/nearbyResearch";
import type { PlanEvaluator } from "../tools/planEvaluator";
import type { RouteResearcher } from "../tools/routeResearch";
import type { FestivalVerifier } from "../tools/verifier";
import type { WeatherService } from "../tools/weather";
import { createGuideHooks } from "./hooks";
import { GUIDE_NO_RESULT_COST_USD } from "./limits";
import { createGuideMcpServer } from "./mcpServer";
import { guideTurnPrompt } from "./prompt";
import { isLivePendingProposal } from "./proposal";
import { type EmitGuideEvent, type GuideRunner, type GuideTurnInput, turnSources } from "./runner";
import type { GuideToolContext, GuideWebResearcher } from "./tools";

// live：Agent SDK でガイドを動かす。接客エージェントと同じように開発環境から切り離す（agent/options.ts）。
// 会話は Agent SDK のセッションを resume して続ける。記録はインスタンスの一時ディレクトリだけにあるので、
// 別のインスタンスに届いたら、旅の記録とコードが書いた要約から新しい会話で続ける。

export interface ClaudeGuideRunnerDeps {
  prompt: string;
  model: string;
  festivals: FestivalStore;
  itineraries: ItineraryStore;
  weather: WeatherService;
  lodging: LodgingService;
  verifier: FestivalVerifier;
  stations?: StationPointIndex | undefined;
  routes?: RouteResearcher | undefined;
  nearby?: NearbyResearcher | undefined;
  osmPlaces?: OsmPlaceIndex | undefined;
  planEvaluator?: PlanEvaluator | undefined;
  researcher?: GuideWebResearcher | undefined;
  /** 1回の発言の費用の上限（米ドル） */
  maxBudgetUsd?: number | undefined;
  cwd: string;
  env: Record<string, string>;
  today: () => IsoDate;
  now: () => string;
  query?: QueryFn;
  /** 会話の記録を消す。現在地を入れた発言のあと、次の発言で読み直さないように使う */
  forgetTranscript?: (id: string) => void;
  stderr?: (data: string) => void;
}

export class ClaudeGuideRunner implements GuideRunner {
  readonly mode = "live" as const;
  readonly #deps: ClaudeGuideRunnerDeps;
  readonly #query: QueryFn;

  constructor(deps: ClaudeGuideRunnerDeps) {
    this.#deps = deps;
    this.#query = deps.query ?? ((params) => sdkQuery(params));
  }

  get maxBudgetUsd(): number | undefined {
    return this.#deps.maxBudgetUsd;
  }

  today(): IsoDate {
    return this.#deps.today();
  }

  now(): string {
    return this.#deps.now();
  }

  /** ツールが使う文脈。旅と利用者は、この相談のものだけを閉じ込める */
  #toolContext(input: GuideTurnInput, emit: EmitGuideEvent): GuideToolContext {
    const deps = this.#deps;
    const tools: ToolContext = {
      session: input.session,
      turn: newTurnState(),
      signal: input.signal,
      festivals: deps.festivals,
      itineraries: deps.itineraries,
      weather: deps.weather,
      lodging: deps.lodging,
      verifier: deps.verifier,
      ...(deps.stations ? { stations: deps.stations } : {}),
      ...(deps.routes ? { routes: deps.routes } : {}),
      ...(deps.nearby ? { nearby: deps.nearby } : {}),
      ...(deps.osmPlaces ? { osmPlaces: deps.osmPlaces } : {}),
      ...(deps.planEvaluator ? { planEvaluator: deps.planEvaluator } : {}),
      ...(input.progress ? { progress: input.progress } : {}),
      today: deps.today,
      now: deps.now,
    };
    return {
      signal: input.signal,
      tools,
      trip: input.trip,
      message: input.message,
      turn: input.turn,
      meter: input.meter,
      researcher: deps.researcher,
      emit,
    };
  }

  async #prompt(input: GuideTurnInput): Promise<string> {
    const { itinerary, data } = input.trip;
    const now = this.now();
    const [memo, notices, proposals] = await Promise.all([
      data.memo(),
      data.notices(),
      data.proposals(),
    ]);
    const guide = input.session.guide;
    return guideTurnPrompt({
      itinerary,
      today: this.today(),
      now,
      memo,
      unreadNotices: notices.filter((notice) => notice.readAt === null).length,
      pendingProposals: proposals.filter((proposal) =>
        isLivePendingProposal(proposal, itinerary.version, now),
      ).length,
      ...(guide.agentSessionId === null ? { resume: guide.resume } : {}),
      location: input.location,
      ...(input.locale === undefined ? {} : { locale: input.locale }),
      message: input.message,
    });
  }

  async runTurn(input: GuideTurnInput, emit: EmitGuideEvent): Promise<void> {
    const deps = this.#deps;
    const { session, signal, progress, turn, meter } = input;
    const guide = session.guide;
    let emitted = 0;
    const counted: EmitGuideEvent = (event) => {
      emitted += 1;
      emit(event);
    };
    const started = Date.now();
    let reply: ReplyStream | null = null;
    /** 直前の試みで、Agent SDK がセッションを名乗ったか（続きの会話を読めたか） */
    let initSeen = false;

    const attempt = async () => {
      const resume = guide.agentSessionId ?? undefined;
      // 再開した会話の費用は累計で届くので、前の累計との差をこの発言の費用にする
      const baseCost = resume === undefined ? 0 : guide.agentCostUsd;
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      if (signal.aborted) abort();
      signal.addEventListener("abort", abort, { once: true });
      const stream = new ReplyStream(counted);
      reply = stream;
      initSeen = false;
      try {
        // 試みごとに作る。続きを読めず新しい会話でやり直すときは、要約の行が要る
        const prompt = await this.#prompt(input);
        const options: Options = buildGuideOptions({
          prompt: deps.prompt,
          model: deps.model,
          mcpServer: createGuideMcpServer(this.#toolContext(input, counted)),
          hooks: createGuideHooks({ turn, emit: counted }),
          cwd: deps.cwd,
          env: deps.env,
          maxBudgetUsd: input.budgetUsd,
          abortController: controller,
          resume,
          ...(deps.stderr ? { stderr: deps.stderr } : {}),
        });
        for await (const message of this.#query({ prompt, options })) {
          progress?.();
          stream.handle(message);
          if (stream.sessionId !== null) {
            initSeen = true;
            guide.agentSessionId = stream.sessionId;
          }
        }
        stream.finish();
      } finally {
        signal.removeEventListener("abort", abort);
        const total = stream.totalCostUsd;
        const spent = total === null ? 0 : total - baseCost;
        // 結果が届かない・費用が0のとき（切断・時間切れ・失敗）も、モデルは動いているので見積もりを足す
        meter.add(spent > 0 ? spent : GUIDE_NO_RESULT_COST_USD);
        if (total !== null) guide.agentCostUsd = total;
      }
    };

    const run = async () => {
      try {
        await attempt();
      } catch (error) {
        if (signal.aborted || error instanceof AgentError) throw error;
        throw toAgentError(classifyFailure(error));
      }
    };

    try {
      try {
        await run();
      } catch (failure) {
        // まだ何も送っていなければ、1回だけやり直す。続きの会話を読めなかったときは、旅の記録だけで新しく始める
        if (!(failure instanceof AgentError) || !failure.retryable || emitted > 0) throw failure;
        if (!initSeen) guide.agentSessionId = null;
        await sleep(backoffMs(1), undefined, { signal });
        await run();
      }
      // 調べて答えたら、出典と調べた時刻を添える。出典はツールの結果からコードが決め、モデルには書かせない
      const messageId = (reply as ReplyStream | null)?.lastMessageId ?? null;
      const attached = turnSources(turn);
      if (messageId !== null && attached !== null) {
        counted({ type: "guide.sources", data: { messageId, ...attached } });
      }
    } finally {
      // 現在地はその発言のときだけ使う。入れた会話を次の発言で読み直さないよう、記録を消して要約から続ける
      if (input.location !== undefined) {
        const id = guide.agentSessionId;
        guide.agentSessionId = null;
        guide.agentCostUsd = 0;
        if (id !== null) deps.forgetTranscript?.(id);
      }
      // 費用・トークン・所要時間・呼んだ道具を残す。会話の文は残さない
      console.info(
        JSON.stringify({
          kind: "guide_turn",
          elapsedMs: Date.now() - started,
          tools: turn.toolCalls,
          costUsd: meter.usd,
          ...((reply as ReplyStream | null)?.usage() ?? {}),
        }),
      );
    }
  }
}
