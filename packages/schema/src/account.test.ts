import { describe, expect, it } from "vitest";
import {
  AuthConfigSchema,
  SaveTripRequestSchema,
  ShareResponseSchema,
  TripSummarySchema,
} from "./account";

describe("ログインと自分の旅の API の型", () => {
  it("ログインの設定は、用意していなければ enabled: false だけ", () => {
    expect(AuthConfigSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(AuthConfigSchema.safeParse({ enabled: true }).success).toBe(false);
    expect(
      AuthConfigSchema.safeParse({
        enabled: true,
        apiKey: "public-key",
        authDomain: "demo.example.com",
        projectId: "demo",
        emulatorUrl: "http://127.0.0.1:9099",
      }).success,
    ).toBe(true);
  });

  it("旅を残すときは、旅程の ID ではなく相談の ID で指す", () => {
    expect(SaveTripRequestSchema.safeParse({ sessionId: "s-1" }).success).toBe(true);
    expect(SaveTripRequestSchema.safeParse({ itineraryId: "trip-1" }).success).toBe(false);
  });

  it("一覧の1件は、初日が分からなければ null", () => {
    const trip = {
      itineraryId: "trip-1",
      title: "灯籠の旅",
      date: null,
      version: 1,
      updatedAt: "2026-08-03T01:00:00.000Z",
    };
    expect(TripSummarySchema.parse(trip)).toEqual(trip);
    expect(TripSummarySchema.safeParse({ ...trip, version: 0 }).success).toBe(false);
  });

  it("共有の応答は、しおりのパスを返す", () => {
    const share = {
      shareId: "sh-abc",
      path: "/shiori/sh-abc",
      expiresAt: "2026-09-02T01:00:00.000Z",
    };
    expect(ShareResponseSchema.parse(share)).toEqual(share);
    expect(ShareResponseSchema.safeParse({ ...share, path: "https://example.com/x" }).success).toBe(
      false,
    );
  });
});
