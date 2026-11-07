import type { Itinerary } from "@matsuri-ikoka/schema";
import { fictionalItinerary, fictionalPlannedItinerary } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import {
  closedGuideCalls,
  dueGuideCalls,
  guideCallSchedule,
  japanTimeMs,
  MAX_CALL_DELAY_MS,
} from "./guideCalls";

const summary = (itinerary: Pick<Itinerary, "days">) =>
  guideCallSchedule(itinerary).map(({ key, at, itemId }) => ({ key, at, itemId }));

describe("guideCallSchedule", () => {
  it("前日の夕方・朝・会場へ向かう前・帰りの最終の前を、旅程から決める", () => {
    expect(summary(fictionalPlannedItinerary())).toEqual([
      { key: "eve:2026-08-16", at: "18:00", itemId: "go" },
      // 最初の予定は 14:30。90分前は遅すぎるので 8:00 にする
      { key: "morning:2026-08-16", at: "08:00", itemId: "go" },
      // 祭りは 18:30、移動の目安は最長15分。支度の30分を足して 17:45
      { key: "depart:2026-08-16:18:30", at: "17:45", itemId: "festival" },
      // 最終の目安 22:40 の60分前
      { key: "last_return:2026-08-16:22:40", at: "21:40", itemId: null },
    ]);
  });

  it("前日の夕方の声かけは、前の日の時刻にする", () => {
    const eve = guideCallSchedule(fictionalItinerary()).find((item) => item.slot === "eve");
    expect(eve?.atMs).toBe(japanTimeMs("2026-08-15", "18:00"));
  });

  it("帰りの最終が分からない日は、最終の前の声かけをしない", () => {
    const keys = guideCallSchedule(fictionalItinerary()).map((item) => item.key);
    expect(keys.some((key) => key.startsWith("last_return:"))).toBe(false);
  });

  it("深夜0時を過ぎた最終は、翌日の時刻として扱う", () => {
    const itinerary = fictionalPlannedItinerary();
    const day = itinerary.days[0] as Itinerary["days"][number];
    day.lastReturn = {
      station: "鈴鳴駅",
      departBy: "00:20",
      sources: day.lastReturn?.sources ?? [],
    };
    const last = guideCallSchedule(itinerary).find((item) => item.slot === "last_return");
    expect(last?.at).toBe("23:20");
    expect(last?.atMs).toBe(japanTimeMs("2026-08-16", "23:20"));
    expect(last?.untilMs).toBe(japanTimeMs("2026-08-17", "00:20"));
  });

  it("最初の予定が朝早い日は、間に合わない朝の声かけを出さない", () => {
    const itinerary = fictionalItinerary();
    const day = itinerary.days[0] as Itinerary["days"][number];
    (day.items[0] as Itinerary["days"][number]["items"][number]).start = "05:00";
    expect(guideCallSchedule(itinerary).map((item) => item.slot)).not.toContain("morning");
  });

  it("移動の目安がない祭りは、開始の60分前に声をかける", () => {
    const itinerary = fictionalItinerary();
    const day = itinerary.days[0] as Itinerary["days"][number];
    const festival = day.items.find((item) => item.type === "festival");
    if (festival === undefined) throw new Error("祭りの予定がありません");
    festival.move = null;
    expect(guideCallSchedule(itinerary).find((item) => item.slot === "depart")?.at).toBe("17:30");
  });

  it("旅程を変えると、まだ来ていない時刻を作り直す", () => {
    const before = fictionalPlannedItinerary();
    const after = fictionalPlannedItinerary();
    const day = after.days[0] as Itinerary["days"][number];
    const festival = day.items.find((item) => item.type === "festival");
    if (festival === undefined) throw new Error("祭りの予定がありません");
    festival.start = "19:30";
    const depart = (itinerary: Itinerary) =>
      guideCallSchedule(itinerary).find((item) => item.slot === "depart");
    expect(depart(before)?.at).toBe("17:45");
    expect(depart(after)?.at).toBe("18:45");
    // 祭りの時刻が変わったので、会場へ向かう前の声かけは別のものとして、もう一度かけられる
    expect(depart(after)?.key).toBe("depart:2026-08-16:19:30");
    expect(depart(after)?.key).not.toBe(depart(before)?.key);
    // 前日の夕方と朝の声かけは、日ごとに1回だけ
    const eve = (itinerary: Itinerary) =>
      guideCallSchedule(itinerary).find((item) => item.slot === "eve")?.key;
    expect(eve(after)).toBe(eve(before));
  });
});

describe("dueGuideCalls", () => {
  const itinerary = fictionalPlannedItinerary();
  const at = (time: string, date = "2026-08-16") => japanTimeMs(date, time);

  it("時刻が来たものだけを返す", () => {
    expect(dueGuideCalls(itinerary, at("17:44")).map((item) => item.slot)).toEqual([]);
    expect(dueGuideCalls(itinerary, at("17:45")).map((item) => item.slot)).toEqual(["depart"]);
  });

  it("役に立つ時刻を過ぎたものは返さない", () => {
    expect(dueGuideCalls(itinerary, at("18:30")).map((item) => item.slot)).toEqual([]);
  });

  it("遅れすぎた声かけは、あとからまとめて届けない", () => {
    const eve = at("18:00", "2026-08-15");
    expect(dueGuideCalls(itinerary, eve + MAX_CALL_DELAY_MS - 1).map((item) => item.slot)).toEqual([
      "eve",
    ]);
    expect(dueGuideCalls(itinerary, eve + MAX_CALL_DELAY_MS)).toEqual([]);
  });

  it("同じ時刻に2回確かめても、同じ声かけを返す（重ならないようにするのは実行済みの記録）", () => {
    const now = at("21:45");
    expect(dueGuideCalls(itinerary, now)).toEqual(dueGuideCalls(itinerary, now));
  });
});

describe("closedGuideCalls", () => {
  const itinerary = fictionalPlannedItinerary();
  const at = (time: string, date = "2026-08-16") => japanTimeMs(date, time);
  const hours = 60 * 60 * 1000;

  it("出せる時間を過ぎた声かけを、過ぎてから決めた間だけ返す", () => {
    // 会場へ向かう前（17:45）は祭りの開始 18:30 で締め切る。朝（8:00）は 10:00 に締め切り、6時間より前
    expect(closedGuideCalls(itinerary, at("18:29"), 6 * hours)).toEqual([]);
    expect(closedGuideCalls(itinerary, at("10:00"), 6 * hours).map((item) => item.slot)).toEqual([
      "morning",
    ]);
    expect(closedGuideCalls(itinerary, at("18:30"), 6 * hours).map((item) => item.slot)).toContain(
      "depart",
    );
    expect(
      closedGuideCalls(itinerary, at("18:30") + 6 * hours, 6 * hours).map((item) => item.slot),
    ).not.toContain("depart");
  });
});
