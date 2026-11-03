import { describe, expect, it } from "vitest";
import { routeOf, smoothPath, stayGroups } from "./route";
import { fictionalOuting, fictionalWeek, fictionalWeekend } from "./testTrips";
import { dayKindOf } from "./viewModel";

describe("旅のかたちの図", () => {
  it("日帰りには図を出さない", () => {
    expect(routeOf(fictionalOuting())).toBeNull();
  });

  it("続けて同じ地域に泊まる夜をまとめ、祭りの日がある地域に印を付ける", () => {
    expect(stayGroups(fictionalWeek())).toEqual([
      { area: "鈴鳴駅の周り", nights: 2, festival: false },
      { area: "鈴鳴の温泉街", nights: 1, festival: true },
      { area: "星見町の浜の近く", nights: 2, festival: false },
      { area: "星見町の駅前", nights: 1, festival: true },
    ]);
  });

  it("泊まる地域が1つならずっと一か所、出発地に戻るなら巡る、戻らなければ途中で寄る旅", () => {
    expect(routeOf(fictionalWeekend())?.shape).toBe("stay");
    expect(routeOf(fictionalWeek())?.shape).toBe("loop");

    const oneWay = fictionalWeek();
    oneWay.returnTo = "星見駅";
    const via = routeOf(oneWay);
    expect(via?.shape).toBe("via");
    expect(via?.stops.map((s) => s.kind)).toEqual(["start", "area", "area", "area", "area", "end"]);
    expect(via?.stops.at(-1)).toMatchObject({ label: "星見駅", sub: "旅の終わり" });
  });

  it("相談で聞いた旅のかたちがあれば、それを使う", () => {
    const trip = fictionalWeek();
    trip.style = { shape: "via" };
    expect(routeOf(trip)?.shapeLabel).toBe("目的地へ向かう途中で祭りに寄る旅");
  });

  it("巡る旅は出発地を兼ねた点から始まり、線は閉じる。点はすべて枠の中にある", () => {
    const route = routeOf(fictionalWeek());
    expect(route?.stops[0]).toMatchObject({
      kind: "start_end",
      label: "みなと中央駅",
      sub: "出発・帰着",
    });
    expect(route?.stops.slice(1).map((s) => s.number)).toEqual([1, 2, 3, 4]);
    expect(route?.path.endsWith("Z")).toBe(true);
    for (const s of route?.stops ?? []) {
      expect(s.x).toBeGreaterThan(0);
      expect(s.x).toBeLessThan(200);
      expect(s.y).toBeGreaterThan(0);
      expect(s.y).toBeLessThan(100);
    }
  });

  it("なめらかな線は、点の数だけの曲線でつなぐ", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 20, y: 0 },
    ];
    expect(smoothPath(points, false).match(/C/g)).toHaveLength(2);
    expect(smoothPath(points, true).match(/C/g)).toHaveLength(3);
  });
});

describe("日の種類", () => {
  it("祭りの日・めぐる日・移動の日・のんびりの日に分ける", () => {
    const days = fictionalWeek().days;
    expect(days.map(dayKindOf)).toEqual([
      "explore",
      "explore",
      "festival",
      "explore",
      "explore",
      "festival",
      "explore",
    ]);
    const travel = { items: (days[0]?.items ?? []).filter((i) => i.type !== "sightseeing") };
    expect(dayKindOf(travel)).toBe("travel");
    const relax = { items: (days[2]?.items ?? []).filter((i) => i.type === "rest") };
    expect(dayKindOf(relax)).toBe("relax");
  });
});
