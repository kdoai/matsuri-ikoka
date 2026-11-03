import type { ClientError, ClientErrorCode } from "./types";

// 画面に出すエラー。サーバーが一文と「送り直せば直るか」を送ってきたら、それを使う。

/** 送り直せば直る見込みのあるエラー（サーバーが retryable を送らないときに使う） */
const RETRYABLE: Record<ClientErrorCode, boolean> = {
  bad_request: false,
  unauthorized: false,
  rate_limited: false,
  timeout: true,
  tool_failed: true,
  upstream_unavailable: true,
  internal: true,
  connection_lost: true,
  server_unreachable: true,
  invalid_event: false,
  session_lost: true,
};

export function retryableByDefault(code: ClientErrorCode): boolean {
  return RETRYABLE[code];
}

/** 画面の側で気づいたエラー（サーバーの一文はない） */
export function clientError(code: ClientErrorCode): ClientError {
  return { code, message: null, retryable: RETRYABLE[code] };
}
