import { describe, expect, it } from "vitest";
import { arrivalBufferMinutes } from "./arrivalBuffer";

describe("arrivalBufferMinutes", () => {
  it.each([
    ["XS", 15],
    ["S", 15],
    ["M", 30],
    ["L", 60],
  ] as const)("規模 %s は %i 分前に着く", (scaleTier, minutes) => {
    expect(arrivalBufferMinutes({ scaleTier, category: "lantern" })).toBe(minutes);
  });

  it("花火大会は場所取りの30分を足す", () => {
    expect(arrivalBufferMinutes({ scaleTier: "S", category: "fireworks" })).toBe(45);
    expect(arrivalBufferMinutes({ scaleTier: "L", category: "fireworks" })).toBe(90);
  });
});
