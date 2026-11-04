import { describe, expect, it } from "vitest";
import {
  ApiErrorSchema,
  FestivalsResponseSchema,
  PreferencesRequestSchema,
  SessionRequestSchema,
  SessionResponseSchema,
} from "./api";
import { DEFAULT_PREFERENCES } from "./preferences";

describe("API の本文と応答", () => {
  it("POST /api/session の本文は空か、サンプルの相談の ID だけ", () => {
    expect(SessionRequestSchema.safeParse({}).success).toBe(true);
    expect(SessionRequestSchema.safeParse({ sample: "suzunari-day-trip" }).success).toBe(true);
    expect(SessionRequestSchema.safeParse({ sample: "Not A Slug" }).success).toBe(false);
    expect(SessionRequestSchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it("POST /api/session の応答はセッション ID", () => {
    expect(SessionResponseSchema.parse({ sessionId: "s-1" })).toEqual({ sessionId: "s-1" });
    expect(SessionResponseSchema.safeParse({ sessionId: "" }).success).toBe(false);
    expect(SessionResponseSchema.parse({ sessionId: "s-1", mode: "mock" })).toEqual({
      sessionId: "s-1",
      mode: "mock",
    });
    expect(SessionResponseSchema.safeParse({ sessionId: "s-1", mode: "replay" }).success).toBe(
      false,
    );
  });

  it("PATCH /api/preferences の本文はセッション ID とこだわり", () => {
    expect(
      PreferencesRequestSchema.safeParse({ sessionId: "s-1", preferences: DEFAULT_PREFERENCES })
        .success,
    ).toBe(true);
    expect(
      PreferencesRequestSchema.safeParse({
        sessionId: "s-1",
        preferences: { ...DEFAULT_PREFERENCES, party: "everyone" },
      }).success,
    ).toBe(false);
  });

  it("エラーの本文は error イベントの data と同じ形", () => {
    expect(
      ApiErrorSchema.safeParse({ code: "rate_limited", message: "上限です。", retryable: false })
        .success,
    ).toBe(true);
    expect(
      ApiErrorSchema.safeParse({ code: "teapot", message: "x", retryable: false }).success,
    ).toBe(false);
  });
});

describe("FestivalsResponseSchema", () => {
  it("祭りのデータの並びを持つ", () => {
    expect(FestivalsResponseSchema.safeParse({ festivals: [] }).success).toBe(true);
    expect(FestivalsResponseSchema.safeParse({}).success).toBe(false);
  });
});
