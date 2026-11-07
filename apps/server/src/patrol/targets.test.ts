import { FestivalSchema } from "@matsuri-ikoka/schema";
import { describe, expect, it } from "vitest";
import { createFestivalStore } from "../data/festivalStore";
import { planTargets } from "./targets";
import { FESTIVAL_ID, PAGE_URL, PATROL_DATE, patrolFestival, watchedTrip } from "./testing";

const TODAY = "2026-08-10";
const festivals = createFestivalStore([patrolFestival()]);

/** 旅程の祭りの日を変える */
const onDate = (name: string, date: string) => {
  const entry = watchedTrip(name);
  const day = entry.itinerary.days[0];
  if (day === undefined) throw new Error("旅程に日がありません");
  entry.itinerary = { ...entry.itinerary, days: [{ ...day, date }] };
  return entry;
};

describe("planTargets", () => {
  it("同じ祭りと開催日は、いくつの旅で見張っていても1つにまとめる", () => {
    const { plans } = planTargets([watchedTrip("a"), watchedTrip("b")], festivals, TODAY);

    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      key: `${FESTIVAL_ID}_${PATROL_DATE}`,
      festivalId: FESTIVAL_ID,
      date: PATROL_DATE,
      baseline: { date: PATROL_DATE, start: "18:30", end: "21:00" },
      pages: [{ url: PAGE_URL, confidence: "official" }],
    });
    expect(plans[0]?.trips).toHaveLength(2);
  });

  it("止めた依頼と、終わった旅は対象にしない", () => {
    const stopped = watchedTrip("a");
    stopped.trip.watch = {
      ...stopped.trip.watch,
      status: "stopped",
      stoppedAt: "2026-08-10T06:00:00+09:00",
    };
    expect(planTargets([stopped], festivals, TODAY).plans).toEqual([]);
    expect(planTargets([watchedTrip("a")], festivals, "2026-08-17").plans).toEqual([]);
  });

  it("掲載停止の祭りは対象にしない", () => {
    const hidden = createFestivalStore([
      FestivalSchema.parse({ ...patrolFestival(), optOut: true }),
    ]);

    expect(planTargets([watchedTrip("a")], hidden, TODAY).plans).toEqual([]);
  });

  it("開催回に当たらない旅程の日は、利用者の日付を使わず、対象にしない", () => {
    const { plans, unmatched } = planTargets([onDate("a", "2026-08-15")], festivals, TODAY);

    expect(plans).toEqual([]);
    expect(unmatched).toBe(1);
    expect(JSON.stringify(plans)).not.toContain("2026-08-15");
  });

  it("複数日の開催の2日目の旅も、開催回の日付で1つにまとめる", () => {
    const festival = patrolFestival();
    const long = FestivalSchema.parse({
      ...festival,
      occurrences: festival.occurrences.map((item) => ({ ...item, endDate: "2026-08-17" })),
    });

    const { plans, unmatched } = planTargets(
      [onDate("a", "2026-08-17"), watchedTrip("b")],
      createFestivalStore([long]),
      TODAY,
    );

    expect(unmatched).toBe(0);
    expect(plans.map((plan) => plan.date)).toEqual([PATROL_DATE]);
    expect(plans[0]?.trips).toHaveLength(2);
  });

  it("読むページは確度の高い順に、推定を除いて、同じページを1つにする", () => {
    const festival = patrolFestival();
    const source = (url: string, confidence: string) => ({
      url,
      checkedAt: "2026-08-01",
      confidence,
    });
    const store = createFestivalStore([
      FestivalSchema.parse({
        ...festival,
        sources: [
          source("https://example.com/news", "single"),
          source("https://example.com/guess", "inferred"),
          source(`${PAGE_URL}/`, "official"),
          source("https://example.com/kanko", "corroborated"),
        ],
      }),
    ]);

    const { plans } = planTargets([watchedTrip("a")], store, TODAY);

    expect(plans[0]?.pages.map((page) => page.url)).toEqual([
      PAGE_URL,
      "https://example.com/kanko",
      "https://example.com/news",
    ]);
  });

  it("開催の近い順に並べる", () => {
    const festival = patrolFestival();
    const later = FestivalSchema.parse({
      ...festival,
      id: "hanabi-matsuri",
      occurrences: festival.occurrences.map((item) => ({ ...item, date: "2026-08-20" })),
    });
    const entry = onDate("b", "2026-08-20");
    entry.itinerary = {
      ...entry.itinerary,
      days: entry.itinerary.days.map((day) => ({
        ...day,
        items: day.items.map((item) =>
          item.type === "festival" ? { ...item, festivalId: later.id } : item,
        ),
      })),
    };

    const { plans } = planTargets(
      [entry, watchedTrip("a")],
      createFestivalStore([festival, later]),
      TODAY,
    );

    expect(plans.map((plan) => plan.date)).toEqual([PATROL_DATE, "2026-08-20"]);
  });
});
