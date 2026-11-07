import { existsSync } from "node:fs";
import path from "node:path";
import type { AgentModels } from "./agent/options";
import type { AgentMode } from "./agent/runner";
import {
  DEFAULT_GUIDE_LIMITS,
  DEFAULT_TRIAL_GUIDE_COST_USD,
  type GuideLimits,
} from "./guide/limits";

/** お試し用のアカウントの、1日の相談の回数の上限（全体）の既定 */
export const DEFAULT_DAILY_TRIAL_CHAT_LIMIT = 100;

// 接客サーバーの設定。値は環境変数から読む（.env.example に名前と説明がある）。

export interface ServerConfig {
  port: number;
  mode: AgentMode;
  production: boolean;
  /** リポジトリの根（data/ を探す起点） */
  repoRoot: string;
  /** 祭りのデータを読む場所（MATSURI_FESTIVALS_DIR）。なければ既定の場所 */
  festivalsDir: string | undefined;
  /** 役割ごとのモデル。旅程係と再確認は、指定がなければスタッフのモデルを使う */
  models: AgentModels;
  /** 公開している URL の合言葉。なければ確かめない */
  accessPasscode: string | null;
  /** 1日の相談の回数の上限。なければ上限なし */
  dailyChatLimit: number | null;
  /** 1日の相談の回数の、利用者ごと（ログインしていなければ IP ごと）の上限。なければ上限なし */
  dailyChatLimitPerIp: number | null;
  /** お試し用のアカウントの、1日の相談の回数の上限（全体） */
  dailyTrialChatLimit: number;
  /** live で同時に返事を作る数の上限 */
  maxConcurrentTurns: number;
  /** live で同時に返事を作る数の、利用者ごと（ログインしていなければ IP ごと）の上限 */
  maxConcurrentTurnsPerClient: number;
  /** 利用者との間に置いたプロキシの数。X-Forwarded-For の右から数えて利用者の IP を決める */
  trustedProxyHops: number;
  /** mock の再生の速さ（1 で記録どおり） */
  replaySpeed: number;
  /** live の1回の発言の費用の上限（米ドル）。なければ上限なし */
  maxBudgetUsd: number | undefined;
  /** 同じオリジンから配る画面のビルドの場所。本番では apps/web/dist、それ以外は MATSURI_WEB_DIST があるときだけ */
  webDist: string | null;
  /** ガイドの1日の費用と回数の上限（利用者と旅ごと） */
  guideLimits: GuideLimits;
}

/** pnpm-workspace.yaml のあるディレクトリを、start から上にたどって探す */
export function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function positiveNumber(name: string, value: string | undefined): number | null {
  const text = nonEmpty(value);
  if (text === undefined) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} は0以上の数にしてください`);
  return n;
}

/** 自由記述の読み取りのモデルの既定（別名）。短い文を決まった形に直すだけなので、軽いモデルで足りる */
export const DEFAULT_WISH_READER_MODEL = "haiku";

/** live で同時に返事を作る数の上限の既定 */
export const DEFAULT_MAX_CONCURRENT_TURNS = 4;

/** 1人が同時に使える枠の既定。全体の半分（切り上げ）で、1人が枠を使い切らないようにする */
export function defaultConcurrentTurnsPerClient(maxConcurrentTurns: number): number {
  return Math.max(1, Math.ceil(maxConcurrentTurns / 2));
}

/** 0 や空は「上限なし」 */
function limitOf(name: string, value: string | undefined): number | null {
  const n = positiveNumber(name, value);
  return n === null || n === 0 ? null : Math.floor(n);
}

/**
 * 本番の live（API キーで、公開している URL）では、使いすぎを防ぐ設定が欠けていたら起動しない（ADR 0004）。
 * 保存先も Firestore に限る。メモリのままだと、デプロイや停止のたびに相談の途中の状態と共有のしおりが消える
 */
export function checkProductionConfig(config: ServerConfig, env: NodeJS.ProcessEnv): void {
  if (!config.production || config.mode !== "live") return;
  const missing = [
    config.accessPasscode === null ? "ACCESS_PASSCODE" : null,
    config.dailyChatLimit === null ? "DAILY_CHAT_LIMIT" : null,
    config.maxBudgetUsd === undefined ? "AGENT_MAX_BUDGET_USD" : null,
    nonEmpty(env.ANTHROPIC_API_KEY) === undefined ? "ANTHROPIC_API_KEY" : null,
    nonEmpty(env.MATSURI_STORAGE) === "firestore" ? null : "MATSURI_STORAGE=firestore",
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    throw new Error(`本番の live では、次の設定が要ります：${missing.join("、")}`);
  }
}

/** 本番の live で、欠けていると起動しない設定（checkProductionConfig）。scripts/lib/production-env.json と同じ */
export const REQUIRED_PRODUCTION_ENV = [
  "ACCESS_PASSCODE",
  "DAILY_CHAT_LIMIT",
  "AGENT_MAX_BUDGET_USD",
  "ANTHROPIC_API_KEY",
  "MATSURI_STORAGE",
] as const;

/**
 * 本番の live で、欠けていても起動するが、黙って効かなくなる設定。scripts/lib/production-env.json と同じ。
 * - MODEL_CONCIERGE・MODEL_STAFF：省くと、Agent SDK の既定のモデルで動く
 * - MODEL_GUIDE：省くと、コンシェルジュのモデル（MODEL_CONCIERGE）で動く。どちらもなければ、ガイドの入口が断る
 * - DAILY_CHAT_LIMIT_PER_IP：省くと、1人の回数の上限がなく、1人で全体の枠を使い切れる
 * - TRUSTED_PROXY_HOPS：省くと、Cloud Run では全員が同じ IP になり、IP ごとの上限と同時の数が全員にまとめて効く
 */
export const RECOMMENDED_PRODUCTION_ENV = [
  "MODEL_CONCIERGE",
  "MODEL_STAFF",
  "MODEL_GUIDE",
  "DAILY_CHAT_LIMIT_PER_IP",
  "TRUSTED_PROXY_HOPS",
] as const;

/**
 * 本番の live で欠けている、勧める設定の名前（起動のログに出す。値は出さない）。
 * 起動は止めない。止めると、今動いている版のまま新しい版が出せなくなるため
 */
export function missingRecommendedConfig(config: ServerConfig, env: NodeJS.ProcessEnv): string[] {
  if (!config.production || config.mode !== "live") return [];
  return RECOMMENDED_PRODUCTION_ENV.filter((name) => nonEmpty(env[name]) === undefined);
}

export function readConfig(env: NodeJS.ProcessEnv, cwd: string = process.cwd()): ServerConfig {
  const mode = nonEmpty(env.MATSURI_AGENT_MODE) ?? "mock";
  if (mode !== "mock" && mode !== "live") {
    throw new Error("MATSURI_AGENT_MODE は mock か live にしてください");
  }
  const repoRoot = findRepoRoot(cwd);
  const production = env.NODE_ENV === "production";
  const maxConcurrentTurns =
    limitOf("MAX_CONCURRENT_TURNS", env.MAX_CONCURRENT_TURNS) ?? DEFAULT_MAX_CONCURRENT_TURNS;
  const config: ServerConfig = {
    port: positiveNumber("PORT", env.PORT) ?? 8787,
    mode,
    production,
    repoRoot,
    festivalsDir: nonEmpty(env.MATSURI_FESTIVALS_DIR),
    models: {
      concierge: nonEmpty(env.MODEL_CONCIERGE),
      staff: nonEmpty(env.MODEL_STAFF),
      planner: nonEmpty(env.MODEL_PLANNER) ?? nonEmpty(env.MODEL_STAFF),
      verifier: nonEmpty(env.MODEL_VERIFIER) ?? nonEmpty(env.MODEL_STAFF),
      evaluator:
        nonEmpty(env.MODEL_EVALUATOR) ?? nonEmpty(env.MODEL_PLANNER) ?? nonEmpty(env.MODEL_STAFF),
      wishReader: nonEmpty(env.MODEL_WISH_READER) ?? DEFAULT_WISH_READER_MODEL,
      // ガイドは店のコンシェルジュと同じ人。指定がなければ、コンシェルジュのモデルで動かす
      guide: nonEmpty(env.MODEL_GUIDE) ?? nonEmpty(env.MODEL_CONCIERGE),
    },
    accessPasscode: nonEmpty(env.ACCESS_PASSCODE) ?? null,
    dailyChatLimit: limitOf("DAILY_CHAT_LIMIT", env.DAILY_CHAT_LIMIT),
    dailyChatLimitPerIp: limitOf("DAILY_CHAT_LIMIT_PER_IP", env.DAILY_CHAT_LIMIT_PER_IP),
    dailyTrialChatLimit:
      limitOf("DAILY_TRIAL_CHAT_LIMIT", env.DAILY_TRIAL_CHAT_LIMIT) ??
      DEFAULT_DAILY_TRIAL_CHAT_LIMIT,
    maxConcurrentTurns,
    maxConcurrentTurnsPerClient:
      limitOf("MAX_CONCURRENT_TURNS_PER_CLIENT", env.MAX_CONCURRENT_TURNS_PER_CLIENT) ??
      defaultConcurrentTurnsPerClient(maxConcurrentTurns),
    trustedProxyHops: Math.floor(positiveNumber("TRUSTED_PROXY_HOPS", env.TRUSTED_PROXY_HOPS) ?? 0),
    replaySpeed: positiveNumber("MATSURI_REPLAY_SPEED", env.MATSURI_REPLAY_SPEED) ?? 1,
    maxBudgetUsd: positiveNumber("AGENT_MAX_BUDGET_USD", env.AGENT_MAX_BUDGET_USD) || undefined,
    webDist:
      nonEmpty(env.MATSURI_WEB_DIST) ??
      (production ? path.join(repoRoot, "apps", "web", "dist") : null),
    // 空なら既定の上限を使う（上限なしにはしない）
    guideLimits: {
      turnsPerUser:
        positiveNumber("GUIDE_DAILY_TURNS_PER_USER", env.GUIDE_DAILY_TURNS_PER_USER) ??
        DEFAULT_GUIDE_LIMITS.turnsPerUser,
      turnsPerTrip:
        positiveNumber("GUIDE_DAILY_TURNS_PER_TRIP", env.GUIDE_DAILY_TURNS_PER_TRIP) ??
        DEFAULT_GUIDE_LIMITS.turnsPerTrip,
      costUsdPerUser:
        positiveNumber("GUIDE_DAILY_COST_USD_PER_USER", env.GUIDE_DAILY_COST_USD_PER_USER) ??
        DEFAULT_GUIDE_LIMITS.costUsdPerUser,
      costUsdPerTrip:
        positiveNumber("GUIDE_DAILY_COST_USD_PER_TRIP", env.GUIDE_DAILY_COST_USD_PER_TRIP) ??
        DEFAULT_GUIDE_LIMITS.costUsdPerTrip,
      costUsdTrialTotal:
        positiveNumber("GUIDE_DAILY_COST_USD_TRIAL_TOTAL", env.GUIDE_DAILY_COST_USD_TRIAL_TOTAL) ??
        DEFAULT_TRIAL_GUIDE_COST_USD,
    },
  };
  checkProductionConfig(config, env);
  return config;
}

/** 起動のときに、どちらのモードで動いているかと、読み込んだ祭りの件数を知らせる */
export function startupNotice(input: {
  mode: AgentMode;
  port: number;
  festivals: number;
  festivalDirs: readonly string[];
  /** mock で再生する見本の相談の名前 */
  samples: readonly string[];
}): { log: Record<string, unknown>; message: string } {
  const dirs = input.festivalDirs.join("、");
  const log = {
    kind: "server_started",
    mode: input.mode,
    port: input.port,
    festivals: input.festivals,
    festivalDirs: input.festivalDirs,
    ...(input.mode === "mock" ? { samples: input.samples } : {}),
  };
  const message =
    input.mode === "live"
      ? `[mode] live：Claude が返事を作ります。祭りのデータ ${input.festivals}件（${dirs}）から探します`
      : `[mode] mock：見本の相談（${input.samples.join("、")}）を再生しています。` +
        `送った内容にかかわらず、記録した返答を流します（祭りのデータ ${input.festivals}件、${dirs}）。` +
        "Claude で返事を作るには MATSURI_AGENT_MODE=live で起動してください";
  return { log, message };
}

/**
 * ポートがふさがっていて起動できないときの知らせ。別の pnpm dev が動いていることが多いので、
 * 止めるか、ポートを変えて起動し直す方法を示す（画面の開発サーバーは同じ PORT へ中継する）
 */
export function portInUseMessage(port: number): string {
  return (
    `[server] ポート ${port} はほかのプロセスが使っています。` +
    "別の pnpm dev が動いていれば止めてください。並べて動かすときは、" +
    `PORT=${port + 1} MATSURI_WEB_PORT=5174 pnpm dev のように、ポートを変えて起動してください`
  );
}
