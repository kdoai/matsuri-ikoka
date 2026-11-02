import { z } from "zod";
import { PreferencesSchema } from "./preferences";

/** 発言の長さの上限（文字） */
export const MAX_MESSAGE_LENGTH = 1000;

/** POST /api/chat の本文。返答は SSE のイベント（events.ts）で返す */
export const ChatRequestSchema = z.strictObject({
  sessionId: z.string().min(1),
  message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
  preferences: PreferencesSchema,
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;
