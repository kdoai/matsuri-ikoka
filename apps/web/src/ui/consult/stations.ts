// 出発の駅の候補を、駅の一覧（data/stations/stations.json）から探す。
// 一覧の作り方と出典は docs/stations.md。

/** 1つの駅：[駅名（「駅」は付けない）, 路線の説明（例：「みなと鉄道 本線」）] */
export type Station = readonly [name: string, lines: string];

export interface StationList {
  stations: Station[];
}

/** 比べる前にそろえる：全角・半角、ヶとケ、前後の空白、終わりの「駅」 */
export function normalizeStationName(text: string): string {
  return text
    .normalize("NFKC")
    .trim()
    .replace(/[ヶヵ]/g, "ケ")
    .replace(/\s+/g, "")
    .replace(/駅$/, "");
}

/**
 * 入力に合う駅を、名前が一致・前方一致・部分一致の順に、短い名前から出す。
 * 同じ名前の駅（別の土地の駅）は路線の説明で見分ける
 */
export function searchStations(stations: readonly Station[], query: string, limit = 8): Station[] {
  const q = normalizeStationName(query);
  if (q.length === 0) return [];
  const ranked: { station: Station; rank: number }[] = [];
  for (const station of stations) {
    const name = normalizeStationName(station[0]);
    const rank = name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : -1;
    if (rank >= 0) ranked.push({ station, rank });
  }
  ranked.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.station[0].length - b.station[0].length ||
      a.station[0].localeCompare(b.station[0], "ja"),
  );
  return ranked.slice(0, limit).map((entry) => entry.station);
}
