import { REGION_PREFECTURES } from "../apps/server/src/domain/destination";
import { matchesOf } from "../apps/server/src/domain/festivalSearch";
import {
  FESTIVAL_KINDS,
  type Festival,
  type FestivalKind,
  type Prefecture,
  SEASONS,
  type Season,
} from "../packages/schema/src";

// 祭りから探すときに、今のデータで種類×季節×地方の祭りが何件出るかを数える。
// 件数の少ない組み合わせが、データを足す先になる（docs/spec/festival-search.md の「精度の確かめ方」）。
// 数え方は検索そのもの（matchesOf）を使う。

/** 地方の分け方。すべての都道府県がどこか1つに入る */
export const COVERAGE_REGIONS = [
  "北海道",
  "東北",
  "関東",
  "中部",
  "近畿",
  "中国",
  "四国",
  "九州沖縄",
] as const;
export type CoverageRegion = (typeof COVERAGE_REGIONS)[number];

/** 件数がこの数以下の組み合わせを「少ない」とする（1回に出す6件に届かない） */
export const FEW_RESULTS = 5;

export interface CoverageCell {
  kind: FestivalKind;
  season: Season;
  region: CoverageRegion;
  /** 条件に合う祭りの数 */
  count: number;
  /** そのうち、種類に強く合う祭りの数 */
  strong: number;
}

export interface SearchCoverage {
  today: string;
  festivals: number;
  /** 今日以降の開催回があり、検索に出せる祭りの数 */
  searchable: number;
  cells: CoverageCell[];
  empty: CoverageCell[];
  few: CoverageCell[];
  /** 種類ごとの、季節と地域を問わない数 */
  kindTotals: Record<FestivalKind, { count: number; strong: number }>;
}

function prefecturesOf(region: CoverageRegion): Prefecture[] {
  return [...(REGION_PREFECTURES[region] ?? [])];
}

export function searchCoverage(festivals: readonly Festival[], today: string): SearchCoverage {
  const countOf = (kind: FestivalKind, season: Season | null, prefectures: Prefecture[]) => {
    const matches = matchesOf(festivals, { kinds: [kind], season, prefectures }, today);
    return {
      count: matches.length,
      strong: matches.filter((m) => m.kinds.weakAxes === 0).length,
    };
  };
  const cells: CoverageCell[] = [];
  for (const kind of FESTIVAL_KINDS) {
    for (const season of SEASONS) {
      for (const region of COVERAGE_REGIONS) {
        cells.push({ kind, season, region, ...countOf(kind, season, prefecturesOf(region)) });
      }
    }
  }
  return {
    today,
    festivals: festivals.filter((f) => !f.optOut).length,
    searchable: matchesOf(festivals, { kinds: [], season: null, prefectures: [] }, today).length,
    cells,
    empty: cells.filter((c) => c.count === 0),
    few: cells.filter((c) => c.count > 0 && c.count <= FEW_RESULTS),
    kindTotals: Object.fromEntries(
      FESTIVAL_KINDS.map((kind) => [kind, countOf(kind, null, [])]),
    ) as SearchCoverage["kindTotals"],
  };
}
