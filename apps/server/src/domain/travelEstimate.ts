import type { Access, LatLng, MinuteRange } from "@matsuri-ikoka/schema";
import { distanceKm } from "./lodging";

// 出発の駅から祭りの会場までの所要時間の目安を、駅の位置（国土数値情報の鉄道データ）からコードで見積もる。
// 祭りのデータに出発の駅からの所要時間がないときに使う。モデルには計算させない。
// - 見積もりは幅で返す。下限は「どう急いでもこれより早くは着かない」側に、上限は乗り換えや待ちを含めた側に倒す
// - 日帰りの上限で除くのは、下限でも上限を超える（明らかに遠い）祭りだけ。境目の祭りは残して、見積もりと伝える
// - データに主要駅からの所要時間があれば、出発の駅から主要駅までの見積もりと足した道も比べる

/** 駅の位置：[駅名, 緯度, 経度]（data/stations/points.json の1行） */
export type StationPoint = readonly [name: string, lat: number, lng: number];

export interface NearestStation {
  name: string;
  point: LatLng;
  km: number;
}

export interface StationPointIndex {
  /** 駅名に当たる駅の位置。同じ名前の別の土地の駅もすべて返す。見つからなければ空 */
  find(name: string): LatLng[];
  /** その地点にいちばん近い駅 */
  nearest(point: LatLng): NearestStation | null;
}

/** 駅名の前に付きがちな運営会社の名前（「JR 〇〇駅」「私鉄の名前 〇〇駅」など） */
const OPERATOR_PREFIXES = [
  "JR",
  "阪急",
  "阪神",
  "京阪",
  "近鉄",
  "南海",
  "名鉄",
  "京急",
  "京王",
  "小田急",
  "東急",
  "西武",
  "東武",
  "京成",
  "相鉄",
  "西鉄",
  "嵐電",
  "叡電",
  "地下鉄",
  "市営地下鉄",
  "東京メトロ",
  "都営",
];

/** 駅名の書き方の違い（全角・空白・末尾の「駅」）をならす */
export function normalizeStationName(name: string): string {
  return name
    .normalize("NFKC")
    .replace(/[\s　]/g, "")
    .replace(/[（(][^）)]*[）)]$/, "")
    .replace(/駅$/, "");
}

function withoutOperator(name: string): string | null {
  const prefix = OPERATOR_PREFIXES.find((p) => name.startsWith(p) && name.length > p.length);
  return prefix === undefined ? null : name.slice(prefix.length);
}

export function createStationPointIndex(points: readonly StationPoint[]): StationPointIndex {
  const byName = new Map<string, LatLng[]>();
  for (const [name, lat, lng] of points) {
    const key = normalizeStationName(name);
    const list = byName.get(key) ?? [];
    list.push({ lat, lng });
    byName.set(key, list);
  }
  const nearestCache = new Map<string, NearestStation | null>();
  return {
    find(name) {
      const key = normalizeStationName(name);
      const exact = byName.get(key);
      if (exact !== undefined) return exact;
      const bare = withoutOperator(key);
      return bare === null ? [] : (byName.get(bare) ?? []);
    },
    nearest(point) {
      const cacheKey = `${point.lat},${point.lng}`;
      const cached = nearestCache.get(cacheKey);
      if (cached !== undefined) return cached;
      let best: NearestStation | null = null;
      for (const [name, lat, lng] of points) {
        const km = distanceKm(point, { lat, lng });
        if (best === null || km < best.km) best = { name, point: { lat, lng }, km };
      }
      nearestCache.set(cacheKey, best);
      return best;
    },
  };
}

/** 近い区間（都市の中の電車）として見る距離（km） */
const LOCAL_KM = 40;

/**
 * 2つの駅の間の、電車での所要時間の目安（分の幅）。直線の距離から見積もる。
 * - 下限：近い区間は時速約67km、その先は新幹線なみ（直線で時速300km）に、乗るまでの8分を足す
 * - 上限：近い区間は時速約27km、その先は在来線なみ（直線で時速約86km）に、乗り換えと待ちの20分を足す
 */
export function railMinutes(km: number): MinuteRange {
  const near = Math.min(km, LOCAL_KM);
  const far = Math.max(km - LOCAL_KM, 0);
  const lower = 8 + near * 0.9 + far * 0.2;
  const upper = 20 + near * 2.2 + far * 0.7;
  return [Math.round(lower), Math.round(upper)];
}

/** 歩いて行ける距離（km）。これより遠いと、バス・車・船で行く区間とみなす */
const WALK_KM = 2;

/**
 * 最寄りの駅から会場までの所要時間の目安（分の幅）。
 * 歩ける距離なら徒歩（時速5km〜3km）。それより遠ければ、バス・車・船（直線で時速80km〜24km）に、待ちを足す
 */
export function lastMileMinutes(km: number): MinuteRange {
  if (km <= WALK_KM) return [Math.round(km * 12), Math.round(km * 20)];
  return [Math.round(5 + km * 0.75), Math.round(15 + km * 2.5)];
}

/**
 * データの主要駅の位置。同じ名前の駅がほかの土地にもあるときは、会場にいちばん近いものにする
 * （主要駅は、その祭りへ向かう道の上の駅なので）
 */
function hubPoint(stations: StationPointIndex, hub: string, venue: LatLng): LatLng | null {
  let best: LatLng | null = null;
  for (const point of stations.find(hub)) {
    if (best === null || distanceKm(point, venue) < distanceKm(best, venue)) best = point;
  }
  return best;
}

const addRanges = (...ranges: MinuteRange[]): MinuteRange =>
  ranges.reduce<MinuteRange>((sum, r) => [sum[0] + r[0], sum[1] + r[1]], [0, 0]);

/** 出発の駅が主要駅と同じ場所とみなす距離（km）。運営会社ごとに名前の違う、隣り合う駅 */
const SAME_HUB_KM = 1;

export interface TravelEstimate {
  minutes: MinuteRange;
  /** data：祭りのデータの所要時間（主要駅から）/ estimate：駅の位置からの見積もり */
  basis: "data" | "estimate";
  /** 会場にいちばん近い駅（見積もりのとき） */
  nearestStation: string | null;
  /** 見積もりで、データの主要駅を経由した道を使ったときの主要駅 */
  viaHub: string | null;
}

export interface TravelEstimateInput {
  access: Access;
  venue: LatLng;
  origin: string;
}

/**
 * 出発の駅から会場までの所要時間の目安。
 * 1. 出発の駅がデータの主要駅（またはそのすぐ近くの駅）なら、データの所要時間に最寄り駅からの徒歩を足す
 * 2. そうでなければ、駅の位置から見積もる：出発の駅→会場にいちばん近い駅→会場の道と、
 *    出発の駅→データの主要駅→（データの所要時間）→会場の道のうち、早い方
 * 3. 出発の駅の位置が分からなければ null
 * 同じ名前の駅がほかの土地にもあるときは、いちばん近いものを使う（遠すぎると誤って除かないため）
 */
export function estimateTravel(
  input: TravelEstimateInput,
  stations: StationPointIndex,
): TravelEstimate | null {
  const { access, venue, origin } = input;
  const walk = access.stations[0]?.walkMinutes ?? [0, 0];
  const exact = access.fromHubs.find(
    (h) => normalizeStationName(h.hub) === normalizeStationName(origin),
  );
  if (exact !== undefined) {
    return {
      minutes: addRanges(exact.minutes, walk),
      basis: "data",
      nearestStation: null,
      viaHub: null,
    };
  }
  const origins = stations.find(origin);
  if (origins.length === 0) return null;

  for (const hub of access.fromHubs) {
    const point = hubPoint(stations, hub.hub, venue);
    const nextToHub = point !== null && origins.some((o) => distanceKm(o, point) <= SAME_HUB_KM);
    if (nextToHub) {
      return {
        minutes: addRanges(hub.minutes, walk),
        basis: "data",
        nearestStation: null,
        viaHub: hub.hub,
      };
    }
  }

  const nearest = stations.nearest(venue);
  const routes: { minutes: MinuteRange; viaHub: string | null }[] = [];
  for (const from of origins) {
    if (nearest !== null) {
      routes.push({
        minutes: addRanges(
          railMinutes(distanceKm(from, nearest.point)),
          lastMileMinutes(nearest.km),
        ),
        viaHub: null,
      });
    }
    for (const hub of access.fromHubs) {
      const point = hubPoint(stations, hub.hub, venue);
      if (point === null) continue;
      routes.push({
        minutes: addRanges(railMinutes(distanceKm(from, point)), hub.minutes, walk),
        viaHub: hub.hub,
      });
    }
  }
  if (routes.length === 0) return null;
  const lower = Math.min(...routes.map((r) => r.minutes[0]));
  const best = routes.reduce((a, b) => (b.minutes[1] < a.minutes[1] ? b : a));
  return {
    minutes: [lower, Math.max(lower, best.minutes[1])],
    basis: "estimate",
    nearestStation: nearest?.name ?? null,
    viaHub: best.viaHub,
  };
}

/** 日帰りの上限と比べた結果：収まる / 境目（見積もりの幅が上限をまたぐ）/ 明らかに超える */
export type TravelFit = "within" | "uncertain" | "over";

/**
 * 上限と比べる。データの所要時間は上限（幅の大きい方）で比べる。
 * 見積もりは、下限でも超えるときだけ「超える」、上限まで収まれば「収まる」、間は「境目」
 */
export function travelFit(estimate: TravelEstimate, maxMinutes: number): TravelFit {
  const [lower, upper] = estimate.minutes;
  if (estimate.basis === "data") return upper > maxMinutes ? "over" : "within";
  if (lower > maxMinutes) return "over";
  return upper <= maxMinutes ? "within" : "uncertain";
}

/** 調べた行き方の所要時間を、見積もりと照らした結果 */
export type RouteCheck =
  | { ok: true; minutes: MinuteRange }
  | { ok: false; reason: string; minutes: MinuteRange | null };

/**
 * Web で調べた行き方の所要時間（分の幅）を、駅の位置からの見積もりと照らす。
 * 見積もりの下限より明らかに短い（7割より短い）か、上限より明らかに長い（1.5倍と30分を超える）ものは、
 * 区間の取り違えや読み違えとみなして使わない。見積もりがなければ、幅の形だけを確かめる
 */
export function checkResearchedMinutes(
  researched: MinuteRange,
  estimate: TravelEstimate | null,
): RouteCheck {
  const [lower, upper] = researched;
  const fallback = estimate?.minutes ?? null;
  if (!(lower > 0 && upper >= lower && upper <= 24 * 60)) {
    return { ok: false, reason: "所要時間の幅の形が正しくありません", minutes: fallback };
  }
  if (estimate === null) return { ok: true, minutes: [lower, upper] };
  if (lower < estimate.minutes[0] * 0.7) {
    return {
      ok: false,
      reason: "駅の位置からの見積もりより短すぎます（区間を取り違えたおそれ）",
      minutes: fallback,
    };
  }
  if (upper > estimate.minutes[1] * 1.5 + 30) {
    return {
      ok: false,
      reason: "駅の位置からの見積もりより長すぎます（区間を取り違えたおそれ）",
      minutes: fallback,
    };
  }
  return { ok: true, minutes: [lower, upper] };
}

/** 旅程の始まりの検査で見る予定（日ごとの最初の予定から） */
export interface StartItem {
  id: string;
  type: string;
  name: string;
  move: { minutes: MinuteRange } | null;
}

export interface StartIssue {
  code: "start_not_origin" | "origin_move_too_short";
  itemId: string | null;
  message: string;
}

/**
 * 旅程の1日目が、出発の駅からの移動で始まっているか、その移動の時間が見積もりより明らかに短くないかを確かめる。
 * - 1日目の最初の予定が移動（move）で、名前に出発の駅の名前が入っていること
 * - はじめに続く移動の予定の所要時間（幅の大きい方）の合計が、見積もりの下限の7割より短くないこと
 *   （別の駅から始めた時間を、出発の駅からの時間として使っていないか）
 */
export function checkStartsAtOrigin(
  firstDayItems: readonly StartItem[],
  origin: string,
  estimate: TravelEstimate | null,
): StartIssue[] {
  const first = firstDayItems[0];
  const name = normalizeStationName(origin);
  if (
    first === undefined ||
    first.type !== "move" ||
    !normalizeStationName(first.name).includes(name)
  ) {
    return [
      {
        code: "start_not_origin",
        itemId: first?.id ?? null,
        message: `1日目の最初の予定を、出発の駅（${origin}）からの移動にしてください。name に出発の駅の名前を入れます`,
      },
    ];
  }
  if (estimate === null) return [];
  let upper = 0;
  for (const item of firstDayItems) {
    if (item.type !== "move") break;
    upper += item.move?.minutes[1] ?? 0;
  }
  const floor = Math.round(estimate.minutes[0] * 0.7);
  if (upper < floor) {
    return [
      {
        code: "origin_move_too_short",
        itemId: first.id,
        message: `出発の駅（${origin}）から会場までの移動が短すぎます（合計で最大${upper}分。目安は${estimate.minutes[0]}〜${estimate.minutes[1]}分）。research_route か get_access の目安を使ってください`,
      },
    ];
  }
  return [];
}
