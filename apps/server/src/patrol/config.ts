import { MAX_PATROL_TARGETS } from "@matsuri-ikoka/schema";

// 見回りの設定。どれも省略でき、なければ見回りの入口だけが断る。サーバーは起動し、相談はそのまま動く。
// 費用は、セッションの予算（list cost の上限）と、1回に調べる対象の数の上限で抑える。

/** managed-agents/ の定義の名前。ID は ant apply が管理するので、コードには持たない */
export const PATROL_NAMES = {
  agent: "matsuri-patrol-reader",
  environment: "matsuri-patrol",
} as const;

/** セッションの予算の既定（米ドル） */
const DEFAULT_SESSION_BUDGET_USD = 2;
/** セッションの予算の上限（米ドル）。設定を間違えても、これより使わない */
const MAX_SESSION_BUDGET_USD = 10;
const DEFAULT_CHECK_INTERVAL_HOURS = 6;
/** 同じ対象を調べる間隔の下限（時間）。短くしすぎて、祭りのサイトに負担をかけない */
const MIN_CHECK_INTERVAL_HOURS = 1;
/** 1回の起動で宿の空きを調べる数の上限。空室検索の呼び出しの間隔を空けるので、多くすると時間内に終わらない */
const DEFAULT_MAX_LODGING_CHECKS = 10;

export interface PatrolConfig {
  /** 見回りの Managed Agents を置いたワークスペースの API キー */
  apiKey: string;
  /** セッションの予算（セント）。Managed Agents の budget に渡す */
  sessionBudgetCents: number;
  /** 1回の起動で調べる対象（祭りと開催日）の数の上限 */
  maxTargetsPerRun: number;
  maxLodgingChecksPerRun: number;
  /** 同じ対象を調べる間隔（ミリ秒） */
  checkIntervalMs: number;
}

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value?.trim());
  return value !== undefined && value.trim() !== "" && Number.isFinite(parsed) && parsed > 0
    ? parsed
    : fallback;
}

/** 読めない値は既定にし、上限を超える値は上限にする。設定の誤りでサーバーを止めない */
export function readPatrolConfig(env: NodeJS.ProcessEnv): PatrolConfig | null {
  const apiKey = env.PATROL_ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  const budgetUsd = Math.min(
    positive(env.PATROL_SESSION_BUDGET_USD, DEFAULT_SESSION_BUDGET_USD),
    MAX_SESSION_BUDGET_USD,
  );
  return {
    apiKey,
    sessionBudgetCents: Math.max(1, Math.round(budgetUsd * 100)),
    maxTargetsPerRun: Math.min(
      Math.floor(positive(env.PATROL_MAX_TARGETS, MAX_PATROL_TARGETS)) || 1,
      MAX_PATROL_TARGETS,
    ),
    maxLodgingChecksPerRun: DEFAULT_MAX_LODGING_CHECKS,
    checkIntervalMs:
      Math.max(
        MIN_CHECK_INTERVAL_HOURS,
        positive(env.PATROL_CHECK_INTERVAL_HOURS, DEFAULT_CHECK_INTERVAL_HOURS),
      ) *
      60 *
      60 *
      1000,
  };
}
