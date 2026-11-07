import { z } from "zod";
import { IsoDateTimeSchema, SessionIdSchema } from "./common";
import { ItinerarySchema } from "./itinerary";

// ログインと、自分の旅の保存・共有の API（docs/spec/account.md）。
// 旅程そのものは ItinerarySchema の形で返す。保存の側では、旅程の形が変わっても読めるよう、
// 一覧に出す見出し（名前・日付）を保存のときに取り出して別に持つ。

const ItineraryIdSchema = z.string().min(1).max(100);

/** 自分の旅の一覧の1件 */
export const TripSummarySchema = z.strictObject({
  itineraryId: ItineraryIdSchema,
  title: z.string(),
  /** 旅の初日（YYYY-MM-DD）。旅程から取り出せなければ null */
  date: z.string().nullable(),
  /** 最新の版 */
  version: z.number().int().min(1),
  updatedAt: IsoDateTimeSchema,
});
export type TripSummary = z.infer<typeof TripSummarySchema>;

/** GET /api/trips の応答 */
export const TripListResponseSchema = z.strictObject({ trips: z.array(TripSummarySchema) });
export type TripListResponse = z.infer<typeof TripListResponseSchema>;

/**
 * POST /api/trips の本文。相談の旅程を、自分の旅として残す。
 * 旅程の ID ではなく相談の ID で指す（しおりの URL を受け取っただけの人が、他人の旅程を自分のものにできないように）
 */
export const SaveTripRequestSchema = z.strictObject({ sessionId: SessionIdSchema });
export type SaveTripRequest = z.infer<typeof SaveTripRequestSchema>;

/** GET /api/trips/:id と GET /api/trips/:id/versions/:version の応答 */
export const TripResponseSchema = z.strictObject({
  trip: TripSummarySchema,
  /** 残っている版（古い順） */
  versions: z.array(z.number().int().min(1)),
  /** 求めた版の旅程。前の形で保存していて、いまの形で読めなければ null */
  itinerary: ItinerarySchema.nullable(),
});
export type TripResponse = z.infer<typeof TripResponseSchema>;

/** POST /api/trips/:id/share の応答。しおりは path で開ける */
export const ShareResponseSchema = z.strictObject({
  shareId: z.string().min(1),
  /** しおりの URL のパス（/shiori/…） */
  path: z.string().startsWith("/shiori/"),
  expiresAt: IsoDateTimeSchema,
});
export type ShareResponse = z.infer<typeof ShareResponseSchema>;

/** DELETE /api/me/trips の応答 */
export const DeleteTripsResponseSchema = z.strictObject({ deleted: z.number().int().min(0) });
export type DeleteTripsResponse = z.infer<typeof DeleteTripsResponseSchema>;

/**
 * お試し用のアカウントの利用者の ID。何人かで同じアカウントを使うので、パスワードの変更と削除を断る。
 * ID はサーバーが ID トークンから確かめた値なので、ほかの人がこの ID を名乗ることはできない
 */
export const TRIAL_ACCOUNT_UID = "trial-account";

export function isTrialAccount(uid: string): boolean {
  return uid === TRIAL_ACCOUNT_UID;
}

/**
 * GET /api/auth/config の応答。画面がログインに使う Firebase の公開の設定（秘密の値ではない）。
 * ログインを用意していなければ enabled: false
 */
export const AuthConfigSchema = z.discriminatedUnion("enabled", [
  z.strictObject({ enabled: z.literal(false) }),
  z.strictObject({
    enabled: z.literal(true),
    apiKey: z.string().min(1),
    authDomain: z.string().min(1),
    projectId: z.string().min(1),
    /** 手元の Auth のエミュレーターの URL（開発のときだけ） */
    emulatorUrl: z.url().optional(),
  }),
]);
export type AuthConfig = z.infer<typeof AuthConfigSchema>;
