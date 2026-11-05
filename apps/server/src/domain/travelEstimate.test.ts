import type { Access } from "@matsuri-ikoka/schema";
import { describe, expect, it } from "vitest";
import {
  checkDayTripLimit,
  checkResearchedMinutes,
  checkStartsAtOrigin,
  createStationPointIndex,
  estimateTravel,
  lastMileMinutes,
  normalizeStationName,
  railMinutes,
  type StationPoint,
  type TravelEstimate,
  travelFit,
} from "./travelEstimate";

// 架空の駅と会場。実在の駅ではない
const POINTS: StationPoint[] = [
  ["鈴鳴", 35.121, 136.081],
  ["みなと中央", 35.0, 135.75],
  ["みなと北", 35.004, 135.75],
  ["こがね台", 34.9, 135.6],
  ["はるか浜", 33.0, 129.0],
  // 同じ名前の別の土地の駅
  ["こがね台", 43.0, 141.3],
];
const stations = createStationPointIndex(POINTS);

const venue = { lat: 35.12, lng: 136.08 };
const access: Access = {
  stations: [{ name: "鈴鳴駅", walkMinutes: [8, 12] }],
  fromHubs: [{ hub: "みなと中央駅", minutes: [40, 50], route: "鈴鳴線" }],
  parking: "unknown",
  trafficRestrictions: [],
  sources: [],
};
/** 離島の会場：近くに駅がない */
const islandVenue = { lat: 32.7, lng: 128.8 };
const islandAccess: Access = { ...access, stations: [], fromHubs: [] };

describe("normalizeStationName", () => {
  it("全角・空白・末尾の駅・括弧の補足をならす", () => {
    expect(normalizeStationName("ＪＲ 鈴鳴駅")).toBe("JR鈴鳴");
    expect(normalizeStationName("みなと中央駅（北口）")).toBe("みなと中央");
  });
});

describe("createStationPointIndex", () => {
  it("駅名の書き方の違いと、前に付いた運営会社の名前を問わずに引ける", () => {
    expect(stations.find("鈴鳴駅")).toEqual([{ lat: 35.121, lng: 136.081 }]);
    expect(stations.find("JR 鈴鳴駅")).toEqual([{ lat: 35.121, lng: 136.081 }]);
    expect(stations.find("ない駅")).toEqual([]);
  });

  it("同じ名前の別の土地の駅は、すべて返す", () => {
    expect(stations.find("こがね台")).toHaveLength(2);
  });

  it("いちばん近い駅を返す", () => {
    expect(stations.nearest(venue)).toMatchObject({ name: "鈴鳴" });
  });
});

describe("railMinutes と lastMileMinutes", () => {
  it("遠いほど長く、下限は上限を超えない", () => {
    const near = railMinutes(20);
    const far = railMinutes(600);
    expect(near[0]).toBeLessThanOrEqual(near[1]);
    expect(far[0]).toBeGreaterThan(near[0]);
    expect(far[1]).toBeGreaterThan(near[1]);
  });

  it("歩ける距離は徒歩、それより遠ければバス・車・船の時間にする", () => {
    expect(lastMileMinutes(1)).toEqual([12, 20]);
    expect(lastMileMinutes(100)[0]).toBeGreaterThan(60);
  });
});

describe("estimateTravel", () => {
  it("出発の駅がデータの主要駅なら、データの所要時間に徒歩を足す", () => {
    expect(estimateTravel({ access, venue, origin: "みなと中央" }, stations)).toEqual({
      minutes: [48, 62],
      basis: "data",
      nearestStation: null,
      viaHub: null,
    });
  });

  it("主要駅のすぐ近くの駅から出るときも、データの所要時間を使う", () => {
    expect(estimateTravel({ access, venue, origin: "みなと北" }, stations)).toMatchObject({
      minutes: [48, 62],
      basis: "data",
      viaHub: "みなと中央駅",
    });
  });

  it("主要駅でない出発の駅は、駅の位置から見積もる", () => {
    const estimate = estimateTravel({ access, venue, origin: "こがね台" }, stations);
    expect(estimate).toMatchObject({ basis: "estimate", nearestStation: "鈴鳴" });
    const [lower, upper] = estimate?.minutes ?? [0, 0];
    expect(lower).toBeGreaterThan(30);
    expect(upper).toBeGreaterThan(lower);
  });

  it("同じ名前の主要駅がほかの土地にもあるときは、会場に近い方を使う", () => {
    // 主要駅「こがね台」は、会場の近くと遠い土地の2つ。遠い方を経由した近道にしない
    const farVenue = { lat: 43.01, lng: 141.31 };
    const farAccess: Access = {
      ...access,
      stations: [],
      fromHubs: [{ hub: "こがね台駅", minutes: [5, 10] }],
    };
    const estimate = estimateTravel(
      { access: farAccess, venue: farVenue, origin: "みなと中央" },
      stations,
    );
    expect(estimate?.basis).toBe("estimate");
    expect(estimate?.minutes[0]).toBeGreaterThan(180);
  });

  it("出発の駅の位置が分からなければ null", () => {
    expect(estimateTravel({ access, venue, origin: "ない駅" }, stations)).toBeNull();
  });

  it("近くに駅のない離島は、駅からの船やバスの時間も足すので、日帰りの上限を明らかに超える", () => {
    const estimate = estimateTravel(
      { access: islandAccess, venue: islandVenue, origin: "みなと中央" },
      stations,
    );
    expect(estimate).not.toBeNull();
    expect(travelFit(estimate as TravelEstimate, 180)).toBe("over");
  });
});

describe("travelFit", () => {
  const estimate = (minutes: [number, number], basis: TravelEstimate["basis"]) => ({
    minutes,
    basis,
    nearestStation: null,
    viaHub: null,
  });

  it("データの所要時間は、幅の大きい方で比べる", () => {
    expect(travelFit(estimate([100, 130], "data"), 120)).toBe("over");
    expect(travelFit(estimate([100, 120], "data"), 120)).toBe("within");
  });

  it("見積もりは、下限でも超えれば超える、上限まで収まれば収まる、間は境目", () => {
    expect(travelFit(estimate([130, 200], "estimate"), 120)).toBe("over");
    expect(travelFit(estimate([60, 110], "estimate"), 120)).toBe("within");
    expect(travelFit(estimate([90, 160], "estimate"), 120)).toBe("uncertain");
  });
});

describe("checkResearchedMinutes", () => {
  const estimate: TravelEstimate = {
    minutes: [40, 90],
    basis: "estimate",
    nearestStation: "鈴鳴",
    viaHub: null,
  };

  it("見積もりと合う所要時間は使う", () => {
    expect(checkResearchedMinutes([50, 65], estimate)).toEqual({ ok: true, minutes: [50, 65] });
  });

  it("見積もりより明らかに短い・長いものは使わず、見積もりを返す", () => {
    expect(checkResearchedMinutes([10, 20], estimate)).toMatchObject({
      ok: false,
      minutes: [40, 90],
    });
    expect(checkResearchedMinutes([60, 400], estimate)).toMatchObject({ ok: false });
  });

  it("幅の形が正しくないものは使わない", () => {
    expect(checkResearchedMinutes([70, 50], null)).toMatchObject({ ok: false, minutes: null });
  });
});

describe("checkStartsAtOrigin", () => {
  const move = (id: string, name: string, minutes: [number, number]) => ({
    id,
    type: "move",
    name,
    move: { minutes },
  });
  const estimate: TravelEstimate = {
    minutes: [40, 90],
    basis: "estimate",
    nearestStation: "鈴鳴",
    viaHub: null,
  };

  it("出発の駅からの移動で始まり、移動の時間が目安に合えば問題なし", () => {
    expect(
      checkStartsAtOrigin([move("go", "こがね台駅から鈴鳴駅へ", [45, 70])], "こがね台", estimate),
    ).toEqual([]);
  });

  it("別の駅から始まる旅程は保存しない", () => {
    expect(
      checkStartsAtOrigin([move("go", "みなと中央駅から鈴鳴駅へ", [40, 50])], "こがね台", estimate),
    ).toMatchObject([{ code: "start_not_origin", itemId: "go" }]);
  });

  it("出発の駅からの移動が目安より明らかに短いものは保存しない。続く移動の時間は合わせて見る", () => {
    expect(
      checkStartsAtOrigin([move("go", "こがね台駅から鈴鳴駅へ", [10, 15])], "こがね台", estimate),
    ).toMatchObject([{ code: "origin_move_too_short" }]);
    expect(
      checkStartsAtOrigin(
        [
          move("go", "こがね台駅からみなと中央駅へ", [15, 20]),
          move("go2", "みなと中央駅から鈴鳴駅へ", [20, 30]),
        ],
        "こがね台",
        estimate,
      ),
    ).toEqual([]);
  });
});

describe("checkDayTripLimit", () => {
  const move = (id: string, minutes: [number, number]) => ({
    id,
    type: "move",
    name: `${id}の移動`,
    move: { minutes },
  });
  const sightseeing = { id: "walk", type: "sightseeing", name: "散歩", move: null };

  it("行きの移動の下限が上限に収まれば問題なし。上限をまたぐ境目のものも残す", () => {
    expect(checkDayTripLimit([move("go", [40, 50]), sightseeing], 60)).toEqual([]);
    expect(checkDayTripLimit([move("go", [50, 80])], 60)).toEqual([]);
  });

  it("行きの移動の下限が上限を超える旅程は保存しない。続く移動の時間は合わせて見る", () => {
    expect(checkDayTripLimit([move("go", [40, 50]), move("go2", [25, 30])], 60)).toMatchObject([
      { code: "over_travel_limit", itemId: "go" },
    ]);
  });

  it("行きの移動のあとの予定の移動は数えない", () => {
    expect(
      checkDayTripLimit(
        [move("go", [40, 50]), sightseeing, { ...sightseeing, move: { minutes: [30, 40] } }],
        60,
      ),
    ).toEqual([]);
  });
});
