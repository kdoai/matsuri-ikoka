import { type ErrorCode, ErrorEventSchema, type SseEventOf } from "@matsuri-ikoka/schema";

export type ErrorBody = SseEventOf<"error">["data"];

/**
 * SSE を始める前に断るときの本文。error イベントの data と同じ形（code・message・retryable）。
 * message は利用者に見せる短い一文
 */
export function apiError(code: ErrorCode, message: string, retryable: boolean): ErrorBody {
  return ErrorEventSchema.shape.data.parse({ code, message, retryable });
}
