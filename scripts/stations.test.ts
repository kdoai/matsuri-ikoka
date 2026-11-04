import { describe, expect, it } from "vitest";
import {
  buildStationPoints,
  buildStations,
  isStationFile,
  linesLabel,
  stationPointsFile,
  stationsFile,
} from "./stations";

// 架空の駅と路線で確かめる
const feature = (name: string, operator: string, line: string, group: string) => ({
  properties: { N02_003: line, N02_004: operator, N02_005: name, N02_005g: group },
});

describe("buildStations", () => {
  it("同じグループの駅を1つにまとめ、路線を添える", () => {
    const stations = buildStations([
      feature("みなと中央", "みなと鉄道", "本線", "001"),
      feature("みなと中央", "うみかぜ交通", "臨港線", "001"),
      feature("鈴鳴", "みなと鉄道", "本線", "002"),
    ]);
    expect(stations).toEqual([
      ["みなと中央", "うみかぜ交通 臨港線、みなと鉄道 本線"],
      ["鈴鳴", "みなと鉄道 本線"],
    ]);
  });

  it("同じ名前でもグループが違えば別の駅として残し、全く同じものは1つにする", () => {
    const stations = buildStations([
      feature("川辺", "やまなみ鉄道", "山線", "010"),
      feature("川辺", "うみかぜ交通", "臨港線", "020"),
      feature("川辺", "やまなみ鉄道", "山線", "030"),
    ]);
    expect(stations).toEqual([
      ["川辺", "うみかぜ交通 臨港線"],
      ["川辺", "やまなみ鉄道 山線"],
    ]);
  });

  it("駅名のないものは除き、全角の英数字はそろえる", () => {
    const stations = buildStations([
      { properties: { N02_005: "" } },
      { properties: null },
      feature("ＡＢ前", "みなと鉄道", "本線", ""),
    ]);
    expect(stations).toEqual([["AB前", "みなと鉄道 本線"]]);
  });
});

describe("buildStations：位置", () => {
  const at = (name: string, line: string, group: string, lon: number, lat: number) => ({
    ...feature(name, "みなと鉄道", line, group),
    geometry: {
      coordinates: [
        [lon, lat],
        [lon + 0.001, lat],
      ],
    },
  });

  it("同じ名前で 1.5km 以内の駅はまとめ、遠い同じ名前の駅は分ける", () => {
    const stations = buildStations([
      at("川辺", "本線", "100", 135.0, 35.0),
      at("川辺", "支線", "200", 135.005, 35.003),
      at("川辺", "山線", "300", 139.0, 36.0),
    ]);
    expect(stations).toEqual([
      ["川辺", "みなと鉄道 山線"],
      ["川辺", "みなと鉄道 支線、みなと鉄道 本線"],
    ]);
  });
});

describe("isStationFile", () => {
  it("zip の根元でもフォルダの中でも、UTF-8 の駅の GeoJSON だけを見つける", () => {
    expect(isStationFile("UTF-8/N02-25_Station.geojson")).toBe(true);
    expect(isStationFile("N02-25_GML/UTF-8/N02-25_Station.geojson")).toBe(true);
    expect(isStationFile("N02-25_GML/Shift-JIS/N02-25_Station.geojson")).toBe(false);
    expect(isStationFile("N02-25_GML/UTF-8/N02-25_RailroadSection.geojson")).toBe(false);
    expect(isStationFile("NOT-UTF-8/N02-25_Station.geojson")).toBe(false);
  });
});

describe("linesLabel", () => {
  it("路線が多い駅は、3つまで書いて残りの数を添える", () => {
    expect(linesLabel(["一号線", "二号線", "三号線", "四号線", "五号線"])).toBe(
      "一号線、二号線、三号線 ほか2路線",
    );
  });
});

describe("stationsFile", () => {
  it("JSON として読め、駅を1行に1つ書く", () => {
    const source = {
      title: "架空の鉄道データ",
      url: "https://example.com/stations",
      license: "CC BY 4.0",
      retrieved: "2030-06-05",
      note: "加工して作成",
    };
    const file = stationsFile(source, [
      ["みなと中央", "みなと鉄道 本線"],
      ["鈴鳴", "みなと鉄道 本線"],
    ]);
    expect(JSON.parse(file)).toEqual({
      source,
      stations: [
        ["みなと中央", "みなと鉄道 本線"],
        ["鈴鳴", "みなと鉄道 本線"],
      ],
    });
    expect(file.split("\n").filter((line) => line.includes("みなと鉄道"))).toHaveLength(2);
  });
});

describe("buildStationPoints", () => {
  const located = (name: string, group: string, lng: number, lat: number) => ({
    properties: { N02_003: "本線", N02_004: "みなと鉄道", N02_005: name, N02_005g: group },
    geometry: {
      coordinates: [
        [lng, lat],
        [lng + 0.001, lat],
      ],
    },
  });

  it("同じグループの駅を1つにまとめ、駅名・緯度・経度（小数4桁）にする。遠くの同じ名前の駅は別の行", () => {
    const points = buildStationPoints([
      located("みなと中央", "001", 135.123456, 35.654321),
      located("みなと中央", "001", 135.1235, 35.6543),
      located("みなと中央", "009", 141.3, 43.0),
      { properties: { N02_005: "位置なし", N02_005g: "002" }, geometry: null },
    ]);
    expect(points).toEqual([
      ["みなと中央", 35.6543, 135.1235],
      ["みなと中央", 43, 141.3],
    ]);
  });

  it("ファイルは駅を1行に1つ書く", () => {
    const text = stationPointsFile(
      {
        title: "t",
        url: "https://example.com",
        license: "CC BY 4.0",
        retrieved: "2026-11-04",
        note: "n",
      },
      [["みなと中央", 35.6543, 135.1235]],
    );
    expect(JSON.parse(text).points).toEqual([["みなと中央", 35.6543, 135.1235]]);
    expect(text).toContain('\n    ["みなと中央",35.6543,135.1235]\n');
  });
});
