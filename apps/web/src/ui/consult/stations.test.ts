import { describe, expect, it } from "vitest";
import { normalizeStationName, type Station, searchStations } from "./stations";

// 架空の駅で確かめる
const STATIONS: Station[] = [
  ["みなと中央", "みなと鉄道 本線"],
  ["みなと", "うみかぜ交通 臨港線"],
  ["東みなと", "みなと鉄道 本線"],
  ["鈴鳴", "みなと鉄道 本線"],
  ["霧ヶ丘", "やまなみ鉄道 山線"],
];

describe("normalizeStationName", () => {
  it("終わりの「駅」、空白、全角と半角、ヶとケの違いをそろえる", () => {
    expect(normalizeStationName(" みなと 中央駅 ")).toBe("みなと中央");
    expect(normalizeStationName("霧ケ丘")).toBe(normalizeStationName("霧ヶ丘"));
    expect(normalizeStationName("ＡＢ")).toBe("AB");
  });
});

describe("searchStations", () => {
  it("一致・前方一致・部分一致の順に出す", () => {
    expect(searchStations(STATIONS, "みなと").map((station) => station[0])).toEqual([
      "みなと",
      "みなと中央",
      "東みなと",
    ]);
  });

  it("駅を付けて打っても、ケで打っても見つかる", () => {
    expect(searchStations(STATIONS, "鈴鳴駅")).toEqual([["鈴鳴", "みなと鉄道 本線"]]);
    expect(searchStations(STATIONS, "霧ケ丘")).toEqual([["霧ヶ丘", "やまなみ鉄道 山線"]]);
  });

  it("空の入力では出さず、数を絞れる", () => {
    expect(searchStations(STATIONS, "  ")).toEqual([]);
    expect(searchStations(STATIONS, "みなと", 1)).toHaveLength(1);
  });
});
