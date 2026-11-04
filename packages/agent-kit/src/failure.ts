// Claude の呼び出しの失敗を分類し、もう一度試すか、画面にどのエラーとして出すかを決める。
// もう一度試すのは、混雑・通信・時間切れ・一時的な異常終了のように、時間をおけば直りうるものだけにする。
// 画面に出す種類は SSE の error イベントの code（packages/schema の ERROR_CODES）に合わせる。
import type { ErrorCode } from "@matsuri-ikoka/schema";

export type FailureKind =
  | "rate_limited"
  | "overloaded"
  | "network"
  | "timeout"
  | "process"
  | "auth"
  | "budget"
  | "max_turns"
  | "unknown";

export interface Failure {
  kind: FailureKind;
  /** 時間をおいてもう一度試す価値があるか */
  retryable: boolean;
  /** 利用者に見せるエラーの種類 */
  errorCode: ErrorCode;
}

const FAILURES: Record<FailureKind, Omit<Failure, "kind">> = {
  // Claude 側の混雑。利用者の回数の上限（rate_limited）とは別なので、外のサービスの不調として出す
  rate_limited: { retryable: true, errorCode: "upstream_unavailable" },
  overloaded: { retryable: true, errorCode: "upstream_unavailable" },
  network: { retryable: true, errorCode: "upstream_unavailable" },
  timeout: { retryable: true, errorCode: "timeout" },
  process: { retryable: true, errorCode: "internal" },
  // 認証や費用の上限は、利用者のせいではなくサーバーの設定の問題
  auth: { retryable: false, errorCode: "internal" },
  budget: { retryable: false, errorCode: "internal" },
  max_turns: { retryable: false, errorCode: "timeout" },
  unknown: { retryable: false, errorCode: "internal" },
};

function failure(kind: FailureKind): Failure {
  return { kind, ...FAILURES[kind] };
}

/** 本文に含まれる語での分類。上から順に当てはめる */
const MESSAGE_PATTERNS: Array<[RegExp, FailureKind]> = [
  [/overloaded|\b529\b/i, "overloaded"],
  [/rate[ _-]?limit|too many requests|\b429\b/i, "rate_limited"],
  [/timed? ?out|timeout|etimedout|\b408\b/i, "timeout"],
  [
    /econnreset|econnrefused|enotfound|eai_again|socket hang up|fetch failed|connection (?:reset|refused|aborted)/i,
    "network",
  ],
  [/\b50[0234]\b|service unavailable|bad gateway/i, "overloaded"],
  [
    /invalid.{0,20}api[ _-]?key|unauthori[sz]ed|authenticat|oauth|\b401\b|\b403\b|credit balance/i,
    "auth",
  ],
  [/exit(?:ed)? (?:with )?code|process (?:exited|did not exit)/i, "process"],
];

/** 投げられた例外を分類する。HTTP の状態コードがあればそれを、なければ名前と本文を見る */
export function classifyFailure(error: unknown): Failure {
  const status = statusOf(error);
  if (status !== undefined) {
    if (status === 401 || status === 403) return failure("auth");
    if (status === 408) return failure("timeout");
    if (status === 429) return failure("rate_limited");
    if (status === 409 || status >= 500) return failure("overloaded");
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError") return failure("timeout");

  const message = error instanceof Error ? error.message : String(error);
  for (const [pattern, kind] of MESSAGE_PATTERNS) {
    if (pattern.test(message)) return failure(kind);
  }
  return failure("unknown");
}

/** 結果のメッセージ（type: "result"）の subtype を分類する。成功なら null */
export function classifyResultSubtype(subtype: string): Failure | null {
  switch (subtype) {
    case "success":
      return null;
    case "error_max_turns":
      return failure("max_turns");
    case "error_max_budget_usd":
      return failure("budget");
    case "error_during_execution":
      return failure("process");
    default:
      return failure("unknown");
  }
}

/**
 * もう一度試すまでの待ち時間（ミリ秒）。1秒から倍々にし、上限で止める。
 * 待ち時間の半分をランダムにずらし、同時に失敗した呼び出しが一斉に試し直さないようにする。
 */
export function backoffMs(
  attempt: number,
  options: { baseMs?: number; maxMs?: number; random?: () => number } = {},
): number {
  const { baseMs = 1_000, maxMs = 30_000, random = Math.random } = options;
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + (ceiling / 2) * random());
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  for (const key of ["status", "statusCode", "api_error_status"]) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === "number") return value;
  }
  return undefined;
}

/** 待ち時間（ミリ秒）だけ待つ。signal が止まったら、待ちをやめて止まった理由を投げる */
function waitMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface RetryOnceOptions {
  /** 止められたら、やり直さない */
  signal?: AbortSignal;
  /** 待ち方（テストで差し替える）。省略すると setTimeout で待つ */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** やり直す前に呼ぶ（ログに失敗の種類を残すため） */
  onRetry?: (failure: Failure) => void;
}

/**
 * 処理を動かし、時間をおけば直りうる失敗（混雑・通信・時間切れ・一時的な異常終了）のときだけ、
 * 少し待ってから1回だけやり直す。やり直しても失敗したら、その失敗を投げる
 */
export async function retryOnce<T>(
  task: () => Promise<T>,
  options: RetryOnceOptions = {},
): Promise<T> {
  const { signal, wait = waitMs, onRetry } = options;
  try {
    return await task();
  } catch (error) {
    if (signal?.aborted) throw error;
    const failure = classifyFailure(error);
    if (!failure.retryable) throw error;
    onRetry?.(failure);
    await wait(backoffMs(1), signal);
    return task();
  }
}
