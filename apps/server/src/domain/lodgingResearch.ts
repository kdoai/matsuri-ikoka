import { createHash } from "node:crypto";
import {
  type IsoDate,
  type LatLng,
  LODGING_PERSPECTIVES,
  type LodgingFromVenue,
  type LodgingOffer,
  type LodgingPerspective,
  type Party,
  type Source,
} from "@matsuri-ikoka/schema";
import { distanceKm, lodgingHeadcount } from "./lodging";
import { stationWord } from "./nearbySearch";
import { lastMileMinutes } from "./travelEstimate";

// 宿の調べ（Web）。観点ごとの調べ方をコードで決め、並べて調べた報告を突き合わせて、提案する宿をコードが選ぶ。
// 報告は信用しない入力なので、距離・移動の目安・予算に合うかは報告の値とこの決まりで計算し、モデルの言い分では決めない。
// 合う宿がなければ、合わない宿で埋めずに空で返す。

/** 提案する宿の数の上限 */
export const MAX_PROPOSED_LODGINGS = 3;
/** 会場からこれより遠い宿は提案しない（km、直線）。祭りの夜に戻れる範囲 */
export const MAX_LODGING_KM = 10;
/** 会場の近くを探す範囲（km） */
export const VENUE_LODGING_KM = 3;
/** 1つの観点の検索の言葉の数の上限 */
export const MAX_LODGING_QUERIES = 4;
/** 歩いて行ける距離（km）。lastMileMinutes と同じ区切り */
const WALK_KM = 2;

export interface LodgingResearchInput {
  festival: { name: string; place: string; venueName: string };
  /** 会場の最寄り駅（祭りのデータのアクセスの順） */
  stations: readonly string[];
  checkIn: IsoDate;
  nights: number;
  party: Party;
  /** 1泊1人あたりの宿の予算の上限（円）。分からなければ null */
  perPersonNightLimitYen: number | null;
}

/** 1つの観点の調べ方。観点ごとに1つの調べ役に渡す */
export interface LodgingSearchPlan {
  perspective: LodgingPerspective;
  /** 検索の言葉（上から優先） */
  queries: string[];
  /** 宿のページで確かめる観点 */
  checkpoints: string[];
  /** 探す範囲（km、会場からの直線） */
  radiusKm: number;
}

function hasChildren(party: Party): boolean {
  return party.children > 0;
}

/**
 * 観点ごとの調べ方を決める。会場の近く・駅の近くは必ず、予算が分かれば予算に合う宿、子ども連れなら家族向けの宿も探す。
 * 1回の検索で終わらせず、観点ごとに別の言葉で並べて探すため
 */
export function lodgingSearchPlans(input: LodgingResearchInput): LodgingSearchPlan[] {
  const { festival, party } = input;
  const place = festival.place;
  const stations = input.stations.slice(0, 2).map(stationWord);
  const common = [
    "宿の公式のページか、予約サイトの宿のページを読み、宿の名前と場所（住所や地図）を確かめる",
    "1泊1人あたりの料金の目安がページにあれば、幅で確かめる（素泊まりか食事つきかも）",
  ];
  const plans: LodgingSearchPlan[] = [
    {
      perspective: "venue",
      queries: [
        `${festival.venueName} 近く ホテル`,
        `${place} 旅館`,
        `${festival.name} 宿泊`,
        `${place} ホテル`,
      ],
      checkpoints: [...common, "会場から歩いて行けるか（宿のページの地図や住所から）"],
      radiusKm: VENUE_LODGING_KM,
    },
    {
      perspective: "station",
      queries:
        stations.length > 0
          ? stations.flatMap((station) => [`${station} 駅前 ホテル`, `${station} 徒歩 宿`])
          : [`${place} 駅前 ホテル`, `${place} 駅 近く ビジネスホテル`],
      checkpoints: [...common, "最寄りの駅から歩いて何分か（宿のページに書かれているもの）"],
      radiusKm: MAX_LODGING_KM,
    },
  ];
  if (input.perPersonNightLimitYen !== null) {
    const limit = input.perPersonNightLimitYen.toLocaleString("ja-JP");
    plans.push({
      perspective: "budget",
      queries: [
        `${place} ホテル 1泊 ${limit}円`,
        `${place} 素泊まり 安い 宿`,
        `${place} ゲストハウス`,
        `${place} ビジネスホテル`,
      ],
      checkpoints: [...common, `1泊1人 ${limit}円までに収まるプランがあるか`],
      radiusKm: MAX_LODGING_KM,
    });
  }
  if (hasChildren(party)) {
    const { infants } = lodgingHeadcount(party);
    plans.push({
      perspective: "family",
      queries: [
        `${place} ホテル 子連れ`,
        `${place} 和室 ファミリー 宿`,
        ...(infants > 0 ? [`${place} 添い寝 無料 ホテル`] : []),
        `${place} 家族 旅館`,
      ],
      checkpoints: [
        ...common,
        "子どもの宿泊を受け付けているか、家族で泊まれる部屋（和室・和洋室・3人以上の部屋）があるか",
      ],
      radiusKm: MAX_LODGING_KM,
    });
  }
  return plans.map((plan) => ({ ...plan, queries: plan.queries.slice(0, MAX_LODGING_QUERIES) }));
}

/** 調べ役が報告した1件の宿（信用しない入力） */
export interface ResearchedLodgingReport {
  name: string;
  /** 自分の言葉の要約 */
  summary: string;
  location: LatLng;
  /** ページに書かれた1泊1人あたりの料金の幅（円）。分からなければ null */
  perPersonNightYen: [number, number] | null;
  /** 料金の目安の文。分からなければ null */
  price: string | null;
  /** 子どもの宿泊や家族の部屋があるとページに書かれていれば true、断っていれば false、分からなければ null */
  familyFriendly: boolean | null;
  /** 宿のページ（公式か予約サイトの宿のページ）。読んだページのうちの1つ */
  pageUrl: string;
  /** 実際に読んだページだけ */
  sources: { url: string; title?: string }[];
}

/** 1つの観点の調べの報告 */
export interface PerspectiveLodgingReport {
  perspective: LodgingPerspective;
  hotels: ResearchedLodgingReport[];
}

export interface LodgingScreenOptions {
  venue: LatLng;
  party: Party;
  perPersonNightLimitYen: number | null;
  /** 調べた時刻（ISO 8601） */
  checkedAt: string;
  /** 確かめた日（出典の checkedAt） */
  today: IsoDate;
  maxKm?: number;
  limit?: number;
}

export type LodgingExclusionReason = "too_far" | "over_budget" | "not_for_children";

export interface LodgingSelection {
  offers: LodgingOffer[];
  excluded: { name: string; reason: LodgingExclusionReason }[];
}

/** 同じ宿かを見る名前（全角・半角、空白、括弧の補足の違いをならす） */
export function lodgingNameKey(name: string): string {
  return name
    .normalize("NFKC")
    .replace(/[(（][^)）]*[)）]/g, "")
    .replace(/[\s・\-ー]/g, "")
    .toLowerCase();
}

/** 調べた宿の ID。名前から決める（観点をまたいで同じ宿を1つにまとめるため） */
export function researchedLodgingId(name: string): string {
  return `web-${createHash("sha256").update(lodgingNameKey(name)).digest("hex").slice(0, 12)}`;
}

/** 会場から宿までの目安（直線の距離から計算する） */
export function lodgingFromVenue(venue: LatLng, location: LatLng): LodgingFromVenue {
  const km = distanceKm(venue, location);
  return { distanceKm: km, mode: km <= WALK_KM ? "walk" : "ride", minutes: lastMileMinutes(km) };
}

interface MergedLodging {
  report: ResearchedLodgingReport;
  perspectives: Set<LodgingPerspective>;
  sources: Map<string, { url: string; title?: string }>;
}

/** 観点をまたいで同じ宿をまとめる。値が欠けていれば、ほかの観点の報告で埋める */
function mergeReports(reports: readonly PerspectiveLodgingReport[]): MergedLodging[] {
  const byKey = new Map<string, MergedLodging>();
  for (const { perspective, hotels } of reports) {
    for (const hotel of hotels) {
      if (hotel.sources.length === 0) continue;
      const key = lodgingNameKey(hotel.name);
      if (key === "") continue;
      const found = byKey.get(key);
      if (found === undefined) {
        byKey.set(key, {
          report: hotel,
          perspectives: new Set([perspective]),
          sources: new Map(hotel.sources.map((s) => [s.url, s])),
        });
        continue;
      }
      found.perspectives.add(perspective);
      for (const s of hotel.sources) if (!found.sources.has(s.url)) found.sources.set(s.url, s);
      found.report = {
        ...found.report,
        perPersonNightYen: found.report.perPersonNightYen ?? hotel.perPersonNightYen,
        price: found.report.price ?? hotel.price,
        familyFriendly: found.report.familyFriendly ?? hotel.familyFriendly,
      };
    }
  }
  return [...byKey.values()];
}

function exclusionReason(
  merged: MergedLodging,
  options: LodgingScreenOptions,
): LodgingExclusionReason | null {
  const { report } = merged;
  if (distanceKm(options.venue, report.location) > (options.maxKm ?? MAX_LODGING_KM)) {
    return "too_far";
  }
  const limit = options.perPersonNightLimitYen;
  if (limit !== null && report.perPersonNightYen !== null && report.perPersonNightYen[0] > limit) {
    return "over_budget";
  }
  if (hasChildren(options.party) && report.familyFriendly === false) return "not_for_children";
  return null;
}

/**
 * 観点ごとの報告を突き合わせ、提案する宿を1〜3件選ぶ。
 * 並びは、挙がった観点の数（多いほど条件に広く合う）→ 予算に収まると分かる宿 → 子ども連れなら家族向け → 会場に近い順。
 * 空きは確かめていないので、1泊の合計（nightlyTotalYen）は null にし、ページの料金の目安だけを持つ
 */
export function screenResearchedLodging(
  reports: readonly PerspectiveLodgingReport[],
  options: LodgingScreenOptions,
): LodgingSelection {
  const excluded: LodgingSelection["excluded"] = [];
  const kept: { merged: MergedLodging; fromVenue: LodgingFromVenue }[] = [];
  for (const merged of mergeReports(reports)) {
    const reason = exclusionReason(merged, options);
    if (reason !== null) {
      excluded.push({ name: merged.report.name, reason });
      continue;
    }
    kept.push({ merged, fromVenue: lodgingFromVenue(options.venue, merged.report.location) });
  }

  const limit = options.perPersonNightLimitYen;
  const withinBudget = (r: ResearchedLodgingReport) =>
    limit !== null && r.perPersonNightYen !== null && r.perPersonNightYen[1] <= limit;
  const children = hasChildren(options.party);
  kept.sort((a, b) => {
    const byPerspectives = b.merged.perspectives.size - a.merged.perspectives.size;
    if (byPerspectives !== 0) return byPerspectives;
    const byBudget = Number(withinBudget(b.merged.report)) - Number(withinBudget(a.merged.report));
    if (byBudget !== 0) return byBudget;
    if (children) {
      const byFamily =
        Number(b.merged.report.familyFriendly === true) -
        Number(a.merged.report.familyFriendly === true);
      if (byFamily !== 0) return byFamily;
    }
    return a.fromVenue.distanceKm - b.fromVenue.distanceKm;
  });

  const offers = kept
    .slice(0, options.limit ?? MAX_PROPOSED_LODGINGS)
    .map(({ merged, fromVenue }): LodgingOffer => {
      const { report } = merged;
      const sources = [...merged.sources.values()];
      // 宿のページを出典の先頭にする。読んだページが2つ以上なら corroborated
      const page = sources.find((s) => s.url === report.pageUrl) ?? sources[0];
      const source: Source = {
        url: page?.url ?? report.pageUrl,
        ...(page?.title ? { title: page.title } : {}),
        checkedAt: options.today,
        confidence: sources.length >= 2 ? "corroborated" : "single",
      };
      return {
        id: researchedLodgingId(report.name),
        name: report.name,
        nightlyTotalYen: null,
        ...(report.perPersonNightYen !== null
          ? { perPersonNightYen: report.perPersonNightYen }
          : {}),
        ...(report.price !== null ? { priceNote: report.price } : {}),
        summary: report.summary,
        bookingUrl: source.url,
        location: report.location,
        fromVenue,
        perspectives: LODGING_PERSPECTIVES.filter((p) => merged.perspectives.has(p)),
        checkedAt: options.checkedAt,
        source,
      };
    });
  return { offers, excluded };
}
