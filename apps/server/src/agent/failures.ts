import {
  classifyFailure,
  classifyResultSubtype,
  type Failure,
  type FailureKind,
} from "@matsuri-ikoka/agent-kit";
import { AgentError } from "./runner";

// Claude の呼び出しの失敗を、共通の部品（@matsuri-ikoka/agent-kit）で分類し、
// 利用者に見せる短い一文のエラーにする（docs/spec/agent-runtime.md の「失敗と再試行」）。

const USER_MESSAGES: Record<FailureKind, string> = {
  rate_limited: "いま混み合っています。少し待ってから、もう一度送ってください。",
  overloaded: "いま混み合っています。少し待ってから、もう一度送ってください。",
  network: "接客の担当とつながりませんでした。もう一度送ってください。",
  timeout: "時間がかかりすぎました。もう一度送ってください。",
  process: "うまく返事を作れませんでした。もう一度送ってください。",
  auth: "いまは接客の準備ができていません。時間をおいて試してください。",
  budget: "この相談では、これ以上調べられませんでした。条件を絞って、もう一度送ってください。",
  max_turns: "考えがまとまりきりませんでした。条件を絞って、もう一度送ってください。",
  unknown: "うまく返事を作れませんでした。もう一度送ってください。",
};

/** SDK の assistant メッセージの error を、HTTP の状態に当てて共通の分類に寄せる */
const ASSISTANT_ERROR_STATUS: Record<string, number> = {
  rate_limit: 429,
  overloaded: 529,
  server_error: 500,
  authentication_failed: 401,
  oauth_org_not_allowed: 403,
  account_on_hold: 403,
  billing_error: 403,
  cloud_credential_error: 401,
};

export function toAgentError(failure: Failure): AgentError {
  if (failure.kind === "auth" || failure.kind === "budget") {
    // サーバーの設定の問題なので、ログで気づけるようにする（会話の文は残さない）
    console.error(JSON.stringify({ kind: "agent_unavailable", reason: failure.kind }));
  }
  return new AgentError(failure.errorCode, USER_MESSAGES[failure.kind], failure.retryable);
}

/** query が投げた例外の分類 */
export function failureFromException(error: unknown): Failure {
  const failure = classifyFailure(error);
  if (failure.kind !== "unknown") return failure;
  // 「Failed to authenticate」「OAuth session expired」も認証の失敗として扱う
  const message = error instanceof Error ? error.message : String(error);
  return /authenticat|oauth/i.test(message) ? classifyFailure({ status: 401 }) : failure;
}

export interface ResultSummary {
  subtype: string;
  is_error: boolean;
  /** 成功の結果の文。失敗のときは、失敗の理由が入ることがある */
  result?: string;
  errors?: string[];
}

/** 結果のメッセージの分類。成功なら null */
export function failureFromResult(
  result: ResultSummary | null,
  assistantError: string | null,
): Failure | null {
  if (result === null) {
    return classifyFailure(new Error("connection aborted before the result message"));
  }
  const bySubtype = classifyResultSubtype(result.subtype);
  if (bySubtype === null && !result.is_error) return null;
  // 回数・費用の上限は subtype で決まる。実行中の失敗は、理由の手がかりで細かく分ける
  if (bySubtype !== null && bySubtype.kind !== "process") return bySubtype;
  const status = assistantError === null ? undefined : ASSISTANT_ERROR_STATUS[assistantError];
  if (status !== undefined) return classifyFailure({ status });
  const reason = [result.result ?? "", ...(result.errors ?? [])].join("\n");
  const byReason = failureFromException(new Error(reason));
  return byReason.kind === "unknown" && bySubtype !== null ? bySubtype : byReason;
}
