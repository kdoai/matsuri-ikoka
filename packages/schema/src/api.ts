import { z } from "zod";
import { SlugSchema } from "./common";
import { ErrorEventSchema } from "./events";
import { FestivalSchema } from "./festival";
import { PreferencesSchema } from "./preferences";

// 接客サーバーの API の本文と応答（docs/spec/api.md）。
// 返答のイベントは SSE（events.ts）、旅程は ItinerarySchema、祭りは FestivalSchema の形で返す。

/** 発言の長さの上限（文字） */
export const MAX_MESSAGE_LENGTH = 1000;

const SessionIdSchema = z.string().min(1);

/** POST /api/session の本文（省略できる）。記録の再生（mock）のときだけ、再生するサンプルの相談を選べる */
export const SessionRequestSchema = z.strictObject({ sample: SlugSchema.optional() });
export type SessionRequest = z.infer<typeof SessionRequestSchema>;

/** POST /api/session の応答 */
export const SessionResponseSchema = z.strictObject({ sessionId: SessionIdSchema });
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

/** GET /api/festivals の応答。掲載停止の祭りは含めない */
export const FestivalsResponseSchema = z.strictObject({ festivals: z.array(FestivalSchema) });
export type FestivalsResponse = z.infer<typeof FestivalsResponseSchema>;

/** POST /api/chat の本文。返答は SSE のイベント（events.ts）で返す */
export const ChatRequestSchema = z.strictObject({
  sessionId: SessionIdSchema,
  message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
  preferences: PreferencesSchema,
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/** PATCH /api/preferences の本文。返答は SSE のイベントで返す */
export const PreferencesRequestSchema = z.strictObject({
  sessionId: SessionIdSchema,
  preferences: PreferencesSchema,
});
export type PreferencesRequest = z.infer<typeof PreferencesRequestSchema>;

/**
 * SSE を始める前に断るときや、JSON を返す API が失敗したときの本文。
 * error イベントの data と同じ形（種類・利用者に見せる一文・もう一度送れば直るか）
 */
export const ApiErrorSchema = ErrorEventSchema.shape.data;
export type ApiError = z.infer<typeof ApiErrorSchema>;
