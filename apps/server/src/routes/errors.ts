import { type ApiError, ApiErrorSchema, type ErrorCode } from "@matsuri-ikoka/schema";

export type ErrorBody = ApiError;

/**
 * SSE を始める前に断るときや、JSON を返す API が失敗したときの本文（ApiErrorSchema）。
 * error イベントの data と同じ形で、message は利用者に見せる短い一文
 */
export function apiError(code: ErrorCode, message: string, retryable: boolean): ErrorBody {
  return ApiErrorSchema.parse({ code, message, retryable });
}
