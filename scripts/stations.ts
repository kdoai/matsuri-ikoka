// 国土数値情報（鉄道データ）の駅を、出発の駅の候補の一覧（data/stations/stations.json）にする。
// 同じグループコードの駅（乗り換えできる駅）と、近く（1.5km 以内）にある同じ名前の駅は1つにまとめ、
// 路線の説明を添える。位置は、まとめるかを決めるためだけに使い、一覧には入れない。
// 出典と利用条件は docs/stations.md。

/** 鉄道データの駅（Station）の属性。使うものだけ */
export interface StationProperties {
  /** 路線名 */
  N02_003?: unknown;
  /** 運営会社 */
  N02_004?: unknown;
  /** 駅名 */
  N02_005?: unknown;
  /** グループコード（乗り換えできる駅をまとめる） */
  N02_005g?: unknown;
}

export interface StationFeature {
  properties?: StationProperties | null;
  /** 駅のホームの線（経度・緯度） */
  geometry?: { coordinates?: unknown } | null;
}

/** 同じ名前の駅を1つにまとめる距離（km） */
const MERGE_KM = 1.5;

/** 線の最初の点（経度・緯度）。読めなければ null */
function firstPoint(feature: StationFeature): [number, number] | null {
  let value: unknown = feature.geometry?.coordinates;
  while (Array.isArray(value) && Array.isArray(value[0])) value = value[0];
  if (!Array.isArray(value) || typeof value[0] !== "number" || typeof value[1] !== "number") {
    return null;
  }
  return [value[0], value[1]];
}

/** 2点の間のおよその距離（km。駅をまとめるかを決めるだけなので、平面で近似する） */
function distanceKm(a: [number, number], b: [number, number]): number {
  const lat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const dx = (a[0] - b[0]) * 111.32 * Math.cos(lat);
  const dy = (a[1] - b[1]) * 110.57;
  return Math.hypot(dx, dy);
}

/** 1つの駅：[駅名, 路線の説明] */
export type StationEntry = [name: string, lines: string];

export interface StationSource {
  title: string;
  url: string;
  license: string;
  retrieved: string;
  note: string;
}

/** 路線の説明に書く路線の数。多い駅は「ほかN路線」とする */
const MAX_LINES = 3;

function text(value: unknown): string {
  return typeof value === "string" ? value.normalize("NFKC").trim() : "";
}

/** グループの中でいちばん多い駅名（同じなら短い方） */
function mostCommon(names: string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0], "ja"),
  )[0]?.[0] as string;
}

export function linesLabel(lines: string[]): string {
  const shown = lines.slice(0, MAX_LINES).join("、");
  const rest = lines.length - MAX_LINES;
  return rest > 0 ? `${shown} ほか${rest}路線` : shown;
}

/** 駅の一覧を作る。駅名のないものは除き、駅名の順に並べる */
export function buildStations(features: readonly StationFeature[]): StationEntry[] {
  const groups = new Map<
    string,
    { names: string[]; lines: Set<string>; point: [number, number] | null }
  >();
  for (const feature of features) {
    const props = feature.properties ?? {};
    const name = text(props.N02_005);
    if (name === "") continue;
    const key = text(props.N02_005g) || `name:${name}`;
    const group = groups.get(key) ?? {
      names: [],
      lines: new Set<string>(),
      point: firstPoint(feature),
    };
    group.names.push(name);
    const line = [text(props.N02_004), text(props.N02_003)].filter((part) => part !== "").join(" ");
    if (line !== "") group.lines.add(line);
    groups.set(key, group);
  }
  // 同じ名前で近くにあるグループをまとめる（グループコードが路線ごとに分かれている駅）
  const merged: { name: string; lines: Set<string>; point: [number, number] | null }[] = [];
  for (const group of groups.values()) {
    const name = mostCommon(group.names);
    const near = merged.find(
      (other) =>
        other.name === name &&
        other.point !== null &&
        group.point !== null &&
        distanceKm(other.point, group.point) <= MERGE_KM,
    );
    if (near === undefined) merged.push({ name, lines: new Set(group.lines), point: group.point });
    else for (const line of group.lines) near.lines.add(line);
  }
  const seen = new Set<string>();
  const entries: StationEntry[] = [];
  for (const group of merged) {
    const entry: StationEntry = [
      group.name,
      linesLabel([...group.lines].sort((a, b) => a.localeCompare(b, "ja"))),
    ];
    const id = entry.join("\t");
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push(entry);
  }
  return entries.sort((a, b) => a[0].localeCompare(b[0], "ja") || a[1].localeCompare(b[1], "ja"));
}

/** 一覧のファイルの中身。差分を読みやすいよう、駅を1行に1つ書く */
export function stationsFile(source: StationSource, stations: StationEntry[]): string {
  const rows = stations.map((station) => `    ${JSON.stringify(station)}`).join(",\n");
  return `{\n  "source": ${JSON.stringify(source)},\n  "stations": [\n${rows}\n  ]\n}\n`;
}
