import type { Itinerary } from "@matsuri-ikoka/schema";
import { fictionalNotice, fictionalSource } from "@matsuri-ikoka/schema/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { japanTimeMs } from "../domain/guideCalls";
import { deliverGuideCalls, guideCallNoticeId } from "./guideCalls";
import { startPatrol } from "./runner";
import { patrolHarness, watchedTrip } from "./testing";

const at = (time: string, date = "2026-08-16") => japanTimeMs(date, time);

function festivalOf(itinerary: Itinerary) {
  const festival = itinerary.days[0]?.items.find((item) => item.type === "festival");
  if (festival === undefined) throw new Error("祭りの予定がありません");
  return festival;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("旅程の時刻に合わせた声かけ", () => {
  it("同じ時刻の起動が2回届いても、声かけは1回だけ届く", async () => {
    const harness = patrolHarness();
    harness.clock.now = at("17:50");
    const { trip, itinerary } = watchedTrip("a");
    harness.store.putWatchedTrip(trip, itinerary);

    const first = await startPatrol(harness.deps);
    const second = await startPatrol(harness.deps);

    expect(first.guideCalls).toBe(1);
    expect(second.guideCalls).toBe(0);
    const calls = harness.store
      .noticesOf(trip.ref)
      .filter((notice) => notice.content.kind === "reminder");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      id: guideCallNoticeId(trip.watch.tripId, { key: "depart:2026-08-16" }),
      content: { kind: "reminder", slot: "depart", date: "2026-08-16", itemId: "festival" },
      affectedItemIds: ["festival"],
      readAt: null,
    });
    expect(calls[0]?.summary).toContain("18:30からの「鈴鳴灯籠まつり」");
  });

  it("2つの起動が同時に届いても、1回だけ届く", async () => {
    const harness = patrolHarness();
    harness.clock.now = at("17:50");
    const { trip, itinerary } = watchedTrip("a");
    harness.store.putWatchedTrip(trip, itinerary);

    const counts = await Promise.all([
      deliverGuideCalls(harness.deps, [{ trip, itinerary }]),
      deliverGuideCalls(harness.deps, [{ trip, itinerary }]),
    ]);

    expect(counts[0] + counts[1]).toBe(1);
    expect(harness.store.noticesOf(trip.ref)).toHaveLength(1);
  });

  it("時刻の前と、役に立つ時刻を過ぎたあとは声をかけない", async () => {
    const harness = patrolHarness();
    const { trip, itinerary } = watchedTrip("a");
    harness.store.putWatchedTrip(trip, itinerary);

    harness.clock.now = at("17:44");
    expect(await deliverGuideCalls(harness.deps, [{ trip, itinerary }])).toBe(0);
    harness.clock.now = at("18:30");
    expect(await deliverGuideCalls(harness.deps, [{ trip, itinerary }])).toBe(0);
  });

  it("旅程を変えると、まだ来ていない時刻を作り直す", async () => {
    const harness = patrolHarness();
    const { trip, itinerary } = watchedTrip("a");
    festivalOf(itinerary).start = "19:30";
    harness.store.putWatchedTrip(trip, itinerary);

    // 前の旅程なら 17:45 に声をかけたが、いまの旅程では 18:45
    harness.clock.now = at("17:50");
    expect(await deliverGuideCalls(harness.deps, [{ trip, itinerary }])).toBe(0);
    harness.clock.now = at("18:45");
    expect(await deliverGuideCalls(harness.deps, [{ trip, itinerary }])).toBe(1);
    expect(harness.store.noticesOf(trip.ref)[0]?.content).toMatchObject({ at: "18:45" });
  });

  it("声かけを止めた旅には届けない", async () => {
    const harness = patrolHarness();
    harness.clock.now = at("17:50");
    const { trip, itinerary } = watchedTrip("a");
    const quiet = { ...trip, watch: { ...trip.watch, reminders: false } };
    harness.store.putWatchedTrip(quiet, itinerary);

    expect(await deliverGuideCalls(harness.deps, [{ trip: quiet, itinerary }])).toBe(0);
    expect(harness.store.noticesOf(trip.ref)).toEqual([]);
  });

  it("見回りを止めた旅には届けない", async () => {
    const harness = patrolHarness();
    harness.clock.now = at("17:50");
    const { trip, itinerary } = watchedTrip("a");
    harness.store.putWatchedTrip(
      {
        ...trip,
        watch: { ...trip.watch, status: "stopped", stoppedAt: "2026-08-16T10:00:00+09:00" },
      },
      itinerary,
    );

    expect(await deliverGuideCalls(harness.deps, [{ trip, itinerary }])).toBe(0);
  });

  it("前日の夕方は、天気の予報と未読のお知らせの数を添え、予報の出典も付ける", async () => {
    const forecast = vi.fn().mockResolvedValue({
      weather: {
        status: "forecast",
        summary: "くもり時々晴れ",
        precipitationPercent: 20,
        highC: 31,
        lowC: 24,
        source: fictionalSource("weather"),
      },
      area: null,
    });
    const harness = patrolHarness({ weather: { forecast } });
    harness.clock.now = at("18:10", "2026-08-15");
    const { trip, itinerary } = watchedTrip("a");
    harness.store.putWatchedTrip(trip, itinerary);
    await harness.store.addNotice(trip, { ...fictionalNotice(), tripId: trip.watch.tripId }, null);

    expect(await deliverGuideCalls(harness.deps, [{ trip, itinerary }])).toBe(1);

    const call = harness.store.noticesOf(trip.ref).find((n) => n.content.kind === "reminder");
    expect(call?.summary).toBe(
      "明日から「鈴鳴の灯籠と川べりの夕べ」の旅です。最初の予定は 14:30「みなと中央駅から鈴鳴駅へ」です。" +
        "天気はくもり時々晴れ（降水確率20%）。まだ読んでいないお知らせが1件あります。",
    );
    expect(call?.sources.map((source) => source.url)).toContain(fictionalSource("weather").url);
    expect(forecast).toHaveBeenCalledWith(expect.any(String), "2026-08-16", "2026-08-15");
  });

  it("天気が読めなくても、天気なしで届ける", async () => {
    const forecast = vi.fn().mockRejectedValue(new Error("予報に届きません"));
    const harness = patrolHarness({ weather: { forecast } });
    harness.clock.now = at("18:10", "2026-08-15");
    const { trip, itinerary } = watchedTrip("a");
    harness.store.putWatchedTrip(trip, itinerary);

    expect(await deliverGuideCalls(harness.deps, [{ trip, itinerary }])).toBe(1);
    expect(harness.store.noticesOf(trip.ref)[0]?.summary).not.toContain("天気");
  });

  it("確かめた出典がない声かけは出さない", async () => {
    const harness = patrolHarness();
    harness.clock.now = at("17:50");
    const { trip, itinerary } = watchedTrip("a");
    for (const item of itinerary.days[0]?.items ?? []) {
      item.sources = item.sources.map((source) => ({ ...source, confidence: "inferred" }));
    }
    harness.store.putWatchedTrip(trip, itinerary);
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await deliverGuideCalls(harness.deps, [{ trip, itinerary }])).toBe(0);
  });

  it("1つの旅の失敗で、ほかの旅の声かけを止めない", async () => {
    const harness = patrolHarness();
    harness.clock.now = at("17:50");
    const a = watchedTrip("a");
    const b = watchedTrip("b");
    harness.store.putWatchedTrip(a.trip, a.itinerary);
    harness.store.putWatchedTrip(b.trip, b.itinerary);
    const list = harness.store.listNotices.bind(harness.store);
    vi.spyOn(harness.store, "listNotices").mockImplementation(async (trip) => {
      if (trip.ref === a.trip.ref) throw new Error("保存先に届きません");
      return list(trip);
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await deliverGuideCalls(harness.deps, [a, b])).toBe(1);
    expect(harness.store.noticesOf(b.trip.ref)).toHaveLength(1);
    // ログには分類だけを残し、旅の置き場や利用者の ID を残さない
    expect(JSON.stringify(error.mock.calls)).not.toContain("user-a");
  });
});
