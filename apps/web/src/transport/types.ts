import type { ChatRequest, Festival, Preferences, SseMessage } from "@matsuri-ikoka/schema";
import type { ClientErrorCode, TransportKind } from "../state/types";

// 相談の通信の口。接客サーバーへの通信と、画面だけのモックの再生を同じ形で扱う。
// どちらも SSE の1件（event と data の文字列）を渡すだけで、検証はストアの側で1か所で行う。

export type OnSseMessage = (message: SseMessage) => void;

/** PATCH /api/preferences の本文 */
export interface PreferencesRequest {
  sessionId: string;
  preferences: Preferences;
}

export interface ChatTransport {
  readonly kind: TransportKind;
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
  /** モックのときだけ：次に再生する記録の発言 */
  nextSampleMessage?(): string | null;
}

/** 祭りのデータの読み込み口。小話・クイズ・しおりに使う */
export interface FestivalSource {
  /** 1件を読み込む。見つからない・掲載停止のときは null */
  load(id: string): Promise<Festival | null>;
  /** 相談を始めたときに読み込んでおく、小話の祭り */
  initial(): Promise<Festival[]>;
}

export class TransportError extends Error {
  constructor(
    readonly code: ClientErrorCode,
    readonly status?: number,
  ) {
    super(status === undefined ? code : `${code} (HTTP ${status})`);
    this.name = "TransportError";
  }
}

/** HTTP の状態コードを、画面に出すエラーの種類に変える */
export function errorCodeForStatus(status: number): ClientErrorCode {
  if (status === 400 || status === 422) {
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

export function toClientErrorCode(error: unknown): ClientErrorCode {
  return error instanceof TransportError ? error.code : "connection_lost";
}
