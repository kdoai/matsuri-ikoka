import { describe, expect, it } from "vitest";
import { lanternLight } from "./SceneLoading";

describe("lanternLight", () => {
  it("読み込みの進みに合わせて、提灯の灯が明るくなる", () => {
    expect(lanternLight(0)).toBeCloseTo(0.15);
    expect(lanternLight(0.5)).toBeGreaterThan(lanternLight(0.2));
    expect(lanternLight(1)).toBe(1);
  });

  it("範囲の外や数でない値は、0〜1 に収める", () => {
    expect(lanternLight(-1)).toBeCloseTo(0.15);
    expect(lanternLight(2)).toBe(1);
    expect(lanternLight(Number.NaN)).toBeCloseTo(0.15);
  });
});
