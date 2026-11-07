import { fictionalItinerary } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { tripStorageContract } from "./contract";
import { MemoryTripStorage } from "./memory";
import { summarize } from "./types";

describe("MemoryTripStorage", () => {
  tripStorageContract((clock) => new MemoryTripStorage({ now: () => clock.now }));

  it("数の上限を超えたら、いちばん長く保存されていない旅程から消す", async () => {
    const storage = new MemoryTripStorage({ max: 2 });
    for (const id of ["a", "b", "c"]) {
      await storage.saveItinerary({ ...fictionalItinerary(), id }, null);
    }

    expect(await storage.readUnowned("a")).toBeNull();
    expect(await storage.readUnowned("c")).not.toBeNull();
  });
});

describe("summarize", () => {
  it("旅程の形が変わっても、名前と初日を取り出す", () => {
    expect(summarize({ title: "旅", date: "2026-08-16" })).toEqual({
      title: "旅",
      date: "2026-08-16",
    });
    expect(summarize({ title: "旅", startDate: "2026-08-15" }).date).toBe("2026-08-15");
    expect(summarize({ title: "旅", days: [{ date: "2026-08-14" }] }).date).toBe("2026-08-14");
    expect(summarize(null)).toEqual({ title: "", date: null });
  });
});
