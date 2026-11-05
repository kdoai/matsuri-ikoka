import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createStationPointIndex, type StationPointIndex } from "../domain/travelEstimate";

// 駅の位置（data/stations/points.json）を起動時に読み込む。出典と作り方は docs/stations.md。
// 出発の駅から会場までの所要時間の目安を、駅の位置から見積もるのに使う（domain/travelEstimate.ts）。

const StationPointsFileSchema = z.object({
  points: z.array(z.tuple([z.string().min(1), z.number(), z.number()])),
});

/** 駅の位置を読む。ファイルがない・読めないときは null（所要時間の見積もりをせずに動く） */
export async function loadStationPoints(repoRoot: string): Promise<StationPointIndex | null> {
  const file = path.join(repoRoot, "data", "stations", "points.json");
  try {
    const parsed = StationPointsFileSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (!parsed.success) {
      console.warn(`[stations] ${file} の形が正しくありません`);
      return null;
    }
    return createStationPointIndex(parsed.data.points);
  } catch (error) {
    console.warn(`[stations] ${file} を読めません：${(error as Error).message}`);
    return null;
  }
}
