import { z } from "zod";
import { LocaleSchema, SessionIdSchema, SlugSchema } from "./common";
import { ErrorEventSchema } from "./events";
import { FestivalSchema } from "./festival";
import { TripAnchorSchema } from "./festivalSearch";
import { PreferencesSchema } from "./preferences";
import { SearchRetrySchema } from "./search";

// 接客サーバーの API の本文と応答（docs/spec/api.md）。
// 返答のイベントは SSE（events.ts）、旅程は ItinerarySchema、祭りは FestivalSchema の形で返す。

/** 発言の長さの上限（文字） */
export const MAX_MESSAGE_LENGTH = 1000;

/** POST /api/session の本文（省略できる）。記録の再生（mock）のときだけ、再生するサンプルの相談を選べる */
export const SessionRequestSchema = z.strictObject({ sample: SlugSchema.optional() });
export type SessionRequest = z.infer<typeof SessionRequestSchema>;

/** 接客サーバーの動き方。live は Claude が返事を作る / mock は記録した見本の相談を再生する */
export const AGENT_MODES = ["live", "mock"] as const;
export const AgentModeSchema = z.enum(AGENT_MODES);
export type AgentMode = z.infer<typeof AgentModeSchema>;

/** POST /api/session の応答。mode は、画面が「見本の相談を再生しています」と出すのに使う */
export const SessionResponseSchema = z.strictObject({
  sessionId: SessionIdSchema,
  mode: AgentModeSchema.optional(),
});
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

/** GET /api/festivals の応答。掲載停止の祭りは含めない */
export const FestivalsResponseSchema = z.strictObject({ festivals: z.array(FestivalSchema) });
export type FestivalsResponse = z.infer<typeof FestivalsResponseSchema>;

/** POST /api/chat の本文。返答は SSE のイベント（events.ts）で返す */
export const ChatRequestSchema = z.strictObject({
  sessionId: SessionIdSchema,
  message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
  preferences: PreferencesSchema,
  /** 候補の窓の次の手（ボタン）から送るとき、変えて探し直す条件 */
  search: SearchRetrySchema.optional(),
  /** 祭りから探して決めた祭り。あれば、この祭りを必ず行く場所にして旅程を組む */
  anchor: TripAnchorSchema.optional(),
  /** 画面の言語。コンシェルジュはこの言語で返事を書く。省略すると日本語 */
  locale: LocaleSchema.optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/** PATCH /api/preferences の本文。返答は SSE のイベントで返す */
export const PreferencesRequestSchema = z.strictObject({
  sessionId: SessionIdSchema,
  preferences: PreferencesSchema,
  /** 画面の言語。旅程を組み直すときの返事の言語。省略すると日本語 */
  locale: LocaleSchema.optional(),
});
export type PreferencesRequest = z.infer<typeof PreferencesRequestSchema>;

/**
 * SSE を始める前に断るときや、JSON を返す API が失敗したときの本文。
 * error イベントの data と同じ形（種類・利用者に見せる一文・もう一度送れば直るか）
 */
export const ApiErrorSchema = ErrorEventSchema.shape.data;
export type ApiError = z.infer<typeof ApiErrorSchema>;
