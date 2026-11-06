import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createOsmPlaceIndex, type OsmPlaceIndex } from "../domain/osmPlaces";

// 店と宿の一覧（data/places/osm-places.json）を起動時に読み込む。出典・ライセンス・作り方は data/places/README.md。

const PlaceSchema = z.object({
  type: z.enum(["node", "way"]),
  id: z.number().int().positive(),
  name: z.string().trim().min(1),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  tags: z.record(z.string(), z.string()),
});
const FileSchema = z.object({ places: z.array(z.unknown()) });

/** 一覧を読む。ファイルがない・読めないときは undefined（Web の調べだけで動く）。形の合わない場所だけを捨てる */
export async function loadOsmPlaces(repoRoot: string): Promise<OsmPlaceIndex | undefined> {
  const file = path.join(repoRoot, "data", "places", "osm-places.json");
  try {
    const parsed = FileSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (!parsed.success) {
      console.warn(`[places] ${file} の形が正しくありません`);
      return undefined;
    }
    const places = parsed.data.places.flatMap((raw) => {
      const place = PlaceSchema.safeParse(raw);
      if (!place.success) return [];
      const { lat, lng, ...rest } = place.data;
      return [{ ...rest, location: { lat, lng } }];
    });
    return createOsmPlaceIndex(places);
  } catch (error) {
    console.warn(`[places] ${file} を読めません：${(error as Error).message}`);
    return undefined;
  }
}
