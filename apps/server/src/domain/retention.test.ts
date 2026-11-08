import { describe, expect, it } from "vitest";
import {
  lastOpenDay,
  RETENTION_AFTER_SAVE_DAYS,
  retentionUntil,
  SESSION_WITHOUT_TRIP_MS,
  sessionRetentionUntil,
} from "./retention";

const DAY = 24 * 60 * 60 * 1000;
const saved = Date.parse("2026-08-01T03:00:00Z");

describe("残さなかった旅程と共有の期限", () => {
  it("旅が近ければ、最後の保存から30日", () => {
    expect(retentionUntil(saved, "2026-08-16")).toBe(saved + RETENTION_AFTER_SAVE_DAYS * DAY);
  });

  it("旅が先なら、最終日の3日後の日本の1日の終わりまで", () => {
    // 11/3 が最終日 → 11/6 の終わり（11/7 0:00 JST = 11/6 15:00 UTC）
    expect(retentionUntil(saved, "2026-11-03")).toBe(Date.parse("2026-11-06T15:00:00Z"));
  });

  it("最終日の数日後が保存から30日とちょうど重なるあたりでも、遅い方をとる", () => {
    const thirty = saved + 30 * DAY;
    expect(retentionUntil(saved, "2026-08-27")).toBe(thirty);
    expect(retentionUntil(saved, "2026-08-29")).toBeGreaterThan(thirty);
  });

  it("最終日が分からない・形が違うときは、保存から30日", () => {
    expect(retentionUntil(saved, null)).toBe(saved + 30 * DAY);
    expect(retentionUntil(saved, "11/3")).toBe(saved + 30 * DAY);
  });
});

describe("相談の途中の状態の期限", () => {
  it("旅程のない相談は、最後に使ってから6時間", () => {
    expect(sessionRetentionUntil(saved, null)).toBe(saved + SESSION_WITHOUT_TRIP_MS);
    expect(SESSION_WITHOUT_TRIP_MS).toBe(6 * 60 * 60 * 1000);
  });

  it("旅程を持つ相談は、旅程と同じ期限まで残す", () => {
    expect(sessionRetentionUntil(saved, { lastDate: "2026-08-16" })).toBe(saved + 30 * DAY);
    expect(sessionRetentionUntil(saved, { lastDate: "2026-11-03" })).toBe(
      retentionUntil(saved, "2026-11-03"),
    );
  });
});

describe("開ける最後の日", () => {
  it("日本の1日の終わりが期限なら、その日まで", () => {
    expect(lastOpenDay(Date.parse("2026-11-06T15:00:00Z"))).toBe("2026-11-06");
  });

  it("日の途中が期限なら、その日まで", () => {
    expect(lastOpenDay(Date.parse("2026-08-31T03:00:00Z"))).toBe("2026-08-31");
  });
});
