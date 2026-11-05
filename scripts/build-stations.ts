// 国土数値情報（鉄道データ）の zip から、出発の駅の候補の一覧（data/stations/stations.json）を作る。
// 出典・利用条件・作り直す手順は docs/stations.md。
//
//   取得元：https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2025.html
//           （2025年度版、全国、N02-25_GML.zip。CC BY 4.0）
//
//   pnpm build:stations --zip path/to/N02-25_GML.zip --retrieved 2026-11-03
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { IsoDateSchema } from "../packages/schema/src";
import { readZipEntry, zipEntries } from "./lib/zip";
import {
  buildStationPoints,
  buildStations,
  isStationFile,
  type StationFeature,
  stationPointsFile,
  stationsFile,
} from "./stations";

const OUTPUT = fileURLToPath(new URL("../data/stations/stations.json", import.meta.url));
const POINTS_OUTPUT = fileURLToPath(new URL("../data/stations/points.json", import.meta.url));

/** 使っている版のページ（出典に書く） */
const SOURCE_URL = "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2025.html";

function main(): number {
  const { values } = parseArgs({
    options: { zip: { type: "string" }, retrieved: { type: "string" } },
  });
  if (values.zip === undefined || values.retrieved === undefined) {
    console.error("--zip（N02 の zip）と --retrieved（取得した日）を指定してください");
    return 1;
  }
  const retrieved = IsoDateSchema.parse(values.retrieved);
  // pnpm から呼ぶと作業フォルダがリポジトリのルートになるので、呼んだ場所（INIT_CWD）から読む
  const path = resolve(process.env.INIT_CWD ?? process.cwd(), values.zip);
  const zip = readFileSync(path);
  const entry = zipEntries(zip).find((candidate) => isStationFile(candidate.name));
  if (entry === undefined) {
    console.error(`${path} に駅の GeoJSON（UTF-8/N02-xx_Station.geojson）がありません`);
    return 1;
  }
  const geojson = JSON.parse(readZipEntry(zip, entry).toString("utf8")) as {
    features?: StationFeature[];
  };
  const stations = buildStations(geojson.features ?? []);
  if (stations.length === 0) {
    console.error(`${entry.name} に駅がありません`);
    return 1;
  }
  const source = {
    title: "国土数値情報（鉄道データ）",
    url: SOURCE_URL,
    license: "CC BY 4.0",
    retrieved,
    note: `「国土数値情報（鉄道データ）」（国土交通省）（${SOURCE_URL}）を加工して作成`,
  };
  writeFileSync(OUTPUT, stationsFile(source, stations));
  console.log(`${entry.name} から ${stations.length} 駅を ${OUTPUT} に書きました`);
  const points = buildStationPoints(geojson.features ?? []);
  writeFileSync(POINTS_OUTPUT, stationPointsFile(source, points));
  console.log(`${points.length} 駅の位置を ${POINTS_OUTPUT} に書きました`);
  return 0;
}

process.exitCode = main();
