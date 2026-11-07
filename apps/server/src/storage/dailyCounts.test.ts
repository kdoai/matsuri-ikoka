import { describe, expect, it } from "vitest";
import { MemoryDailyCountStore } from "./dailyCounts";

describe("MemoryDailyCountStore", () => {
  it("枠と日ごとに、キーの回数を足して読む", async () => {
    const store = new MemoryDailyCountStore();
    await store.add("chat", "2026-08-03", "k1");
    await store.add("chat", "2026-08-03", "k1");
    await store.add("chat", "2026-08-04", "k1");
    await store.add("client", "2026-08-03", "k2");

    expect(await store.load("chat", "2026-08-03")).toEqual(new Map([["k1", 2]]));
    expect(await store.load("client", "2026-08-03")).toEqual(new Map([["k2", 1]]));
    expect(await store.load("trial", "2026-08-03")).toEqual(new Map());
  });
});
