import {
  type AgentMode,
  ApiErrorSchema,
  type ChatRequest,
  type Festival,
  type PreferencesRequest,
  type SseMessage,
} from "@matsuri-ikoka/schema";
import { clientError, retryableByDefault } from "../state/errors";
import type { ClientError, ClientErrorCode } from "../state/types";

// 相談の通信の口（接客サーバーへの通信）。テストでは同じ形の代わりを渡す。
// SSE の1件（event と data の文字列）を渡すだけで、検証はストアの側で1か所で行う。

export type OnSseMessage = (message: SseMessage) => void;

export interface ChatTransport {
  /** 相談を始めて、セッション ID を受け取る */
  startSession(signal?: AbortSignal): Promise<string>;
  /** 発言を送り、返答のイベントを受け取る。接続が閉じたら終わる */
  chat(request: ChatRequest, onMessage: OnSseMessage, signal: AbortSignal): Promise<void>;
  /** こだわりの切り替えを送り、組み直しのイベントを受け取る */
  updatePreferences(
    request: PreferencesRequest,
    onMessage: OnSseMessage,
    signal: AbortSignal,
  ): Promise<void>;
  /** 最後に始めた相談で、サーバーが知らせた動き方（知らせがなければ null） */
  agentMode?(): AgentMode | null;
  /** 接続が切れたあとに、サーバーが応答するかを確かめる（つながらなければ false） */
  checkServer?(): Promise<boolean>;
  /** 接客サーバーのときだけ：合言葉を覚えて、これからの呼び出しに付ける */
  setPasscode?(passcode: string): void;
  /** 接客サーバーのときだけ：合言葉を覚えているか */
  hasPasscode?(): boolean;
}

/** 祭りのデータの読み込み口。小話・クイズ・しおりに使う */
export interface FestivalSource {
  /** 1件を読み込む。見つからない・掲載停止のときは null */
  load(id: string): Promise<Festival | null>;
  /** 相談を始めたときに読み込んでおく、小話の祭り */
  initial(): Promise<Festival[]>;
}

export class TransportError extends Error {
  readonly status: number | undefined;
  /** サーバーが本文で送った、利用者に見せる一文 */
  readonly serverMessage: string | null;
  /** サーバーが本文で送った「もう一度送れば直るか」 */
  readonly retryable: boolean | null;

  constructor(
    readonly code: ClientErrorCode,
    options: { status?: number; message?: string | null; retryable?: boolean | null } = {},
  ) {
    super(options.status === undefined ? code : `${code} (HTTP ${options.status})`);
    this.name = "TransportError";
    this.status = options.status;
    this.serverMessage = options.message ?? null;
    this.retryable = options.retryable ?? null;
  }
}

/** HTTP の状態コードを、画面に出すエラーの種類に変える（本文が読めないとき） */
export function errorCodeForStatus(status: number): ClientErrorCode {
  if (status === 400 || status === 413 || status === 422) {
    return "bad_request";
  }
  if (status === 401 || status === 403) {
    return "unauthorized";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status === 408 || status === 504) {
    return "timeout";
  }
  if (status === 502 || status === 503) {
    return "upstream_unavailable";
  }
  return "internal";
}

/**
 * SSE を始める前に断られたときの応答を、エラーに変える。
 * サーバーは状態コードに、error イベントの data と同じ形（code・message・retryable）の JSON を付ける。
 * 相談に結びついた呼び出し（sessionBound）の 404 は、サーバーが相談を覚えていないことを表す。
 */
export async function errorFromResponse(
  response: Response,
  sessionBound: boolean,
): Promise<TransportError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const parsed = ApiErrorSchema.safeParse(body);
  const status = response.status;
  if (sessionBound && status === 404) {
    return new TransportError("session_lost", { status, retryable: true });
  }
  if (!parsed.success) {
    return new TransportError(errorCodeForStatus(status), { status });
  }
  return new TransportError(parsed.data.code, {
    status,
    message: parsed.data.message,
    retryable: parsed.data.retryable,
  });
}

export function toClientError(error: unknown): ClientError {
  if (!(error instanceof TransportError)) {
    return clientError("connection_lost");
  }
  return {
    code: error.code,
    message: error.serverMessage,
    retryable: error.retryable ?? retryableByDefault(error.code),
  };
}
