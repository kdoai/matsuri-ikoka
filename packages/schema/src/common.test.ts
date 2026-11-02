import { describe, expect, it } from "vitest";
import {
  LocalTimeSchema,
  MinuteRangeSchema,
  SlugSchema,
  SourceSchema,
  strongestConfidence,
} from "./common";
import { fictionalSource } from "./testing";

describe("SourceSchema", () => {
  it("URL・確認した日・確度がそろった出典を受け付ける", () => {
    expect(SourceSchema.safeParse(fictionalSource("about")).success).toBe(true);
  });

  it.each(["url", "checkedAt", "confidence"] as const)("%s のない出典は不正", (key) => {
    const { [key]: _, ...rest } = fictionalSource("about");
    expect(SourceSchema.safeParse(rest).success).toBe(false);
  });

  it("http(s) 以外の URL は受け付けない", () => {
    const source = { ...fictionalSource("about"), url: "javascript:alert(1)" };
    expect(SourceSchema.safeParse(source).success).toBe(false);
  });

  it("4段階にない確度は受け付けない", () => {
    const source = { ...fictionalSource("about"), confidence: "verified" };
    expect(SourceSchema.safeParse(source).success).toBe(false);
  });

  it("確認した日はカレンダーにある日付だけ", () => {
    const source = { ...fictionalSource("about"), checkedAt: "2026-02-30" };
    expect(SourceSchema.safeParse(source).success).toBe(false);
  });
});

describe("strongestConfidence", () => {
  it("いちばん強い確度を返す", () => {
    const sources = [
      fictionalSource("a", "single"),
      fictionalSource("b", "corroborated"),
      fictionalSource("c", "inferred"),
    ];
    expect(strongestConfidence(sources)).toBe("corroborated");
  });

  it("出典がなければ null", () => {
    expect(strongestConfidence([])).toBeNull();
  });
});

describe("基本の型", () => {
  it.each(["00:00", "09:05", "23:59"])("時刻 %s を受け付ける", (time) => {
    expect(LocalTimeSchema.safeParse(time).success).toBe(true);
  });

  it.each(["24:00", "9:05", "12:60", "12:00:00"])("時刻 %s は不正", (time) => {
    expect(LocalTimeSchema.safeParse(time).success).toBe(false);
  });

  it("分の幅は最短が最長以下", () => {
    expect(MinuteRangeSchema.safeParse([10, 20]).success).toBe(true);
    expect(MinuteRangeSchema.safeParse([15, 15]).success).toBe(true);
    expect(MinuteRangeSchema.safeParse([20, 10]).success).toBe(false);
  });

  it.each(["suzunari-toro", "a1"])("ID %s を受け付ける", (id) => {
    expect(SlugSchema.safeParse(id).success).toBe(true);
  });

  it.each(["Suzunari", "suzunari_toro", "-suzunari", "鈴鳴"])("ID %s は不正", (id) => {
    expect(SlugSchema.safeParse(id).success).toBe(false);
  });
});
