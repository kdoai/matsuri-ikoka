import { existsSync } from "node:fs";
import path from "node:path";
import type { AgentMode } from "./agent/runner";

// 接客サーバーの設定。値は環境変数から読む（.env.example に名前と説明がある）。

export interface ServerConfig {
  port: number;
  mode: AgentMode;
  production: boolean;
  /** リポジトリの根（data/ を探す起点） */
  repoRoot: string;
  /** 祭りのデータを読む場所（MATSURI_FESTIVALS_DIR）。なければ既定の場所 */
  festivalsDir: string | undefined;
  models: { concierge: string | undefined; staff: string | undefined };
  /** 公開している URL の合言葉。なければ確かめない */
  accessPasscode: string | null;
  /** 1日の相談の回数の上限。なければ上限なし */
  dailyChatLimit: number | null;
  /** mock の再生の速さ（1 で記録どおり） */
  replaySpeed: number;
  /** live の1回の発言の費用の上限（米ドル）。なければ上限なし */
  maxBudgetUsd: number | undefined;
  /** 同じオリジンから配る画面のビルドの場所。本番では apps/web/dist、それ以外は MATSURI_WEB_DIST があるときだけ */
  webDist: string | null;
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

export function readConfig(env: NodeJS.ProcessEnv, cwd: string = process.cwd()): ServerConfig {
  const mode = nonEmpty(env.MATSURI_AGENT_MODE) ?? "mock";
  if (mode !== "mock" && mode !== "live") {
    throw new Error("MATSURI_AGENT_MODE は mock か live にしてください");
  }
  const limit = positiveNumber("DAILY_CHAT_LIMIT", env.DAILY_CHAT_LIMIT);
  const repoRoot = findRepoRoot(cwd);
  const production = env.NODE_ENV === "production";
  return {
    port: positiveNumber("PORT", env.PORT) ?? 8787,
    mode,
    production,
    repoRoot,
    festivalsDir: nonEmpty(env.MATSURI_FESTIVALS_DIR),
    models: { concierge: nonEmpty(env.MODEL_CONCIERGE), staff: nonEmpty(env.MODEL_STAFF) },
    accessPasscode: nonEmpty(env.ACCESS_PASSCODE) ?? null,
    dailyChatLimit: limit === null || limit === 0 ? null : Math.floor(limit),
    replaySpeed: positiveNumber("MATSURI_REPLAY_SPEED", env.MATSURI_REPLAY_SPEED) ?? 1,
    maxBudgetUsd: positiveNumber("AGENT_MAX_BUDGET_USD", env.AGENT_MAX_BUDGET_USD) || undefined,
    webDist:
      nonEmpty(env.MATSURI_WEB_DIST) ??
      (production ? path.join(repoRoot, "apps", "web", "dist") : null),
  };
}
