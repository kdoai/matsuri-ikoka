import type { Festival, IsoDate, Source } from "@matsuri-ikoka/schema";

// Web で開催を確かめるときの、検索の言葉の広げ方と、情報源の優先順位をコードで決める。
// 小さな祭りほど、名前の書き方や地域の呼び方が揺れ、当年の日程は主催者のページや自治体の広報誌の PDF に
// 散らばるので、言葉を広げて並べて検索し、優先順位の高い情報源から読む。

/** 1回の確かめで使う検索の言葉の上限 */
export const MAX_VERIFICATION_QUERIES = 7;

/** 令和の年（2026 → 8）。令和より前なら null */
export function reiwaYear(year: number): number | null {
  const reiwa = year - 2018;
  return reiwa >= 1 ? reiwa : null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** 祭りの名前の揺れ（括弧の中の読み・別名を外したもの、「祭」と「祭り」） */
export function nameVariants(name: string): string[] {
  const bare = name.replace(/[（(][^）)]*[）)]/g, "").trim();
  const variants = [name, bare];
  if (bare.endsWith("祭り")) variants.push(bare.replace(/祭り$/, "祭"));
  else if (bare.endsWith("祭")) variants.push(`${bare}り`);
  return [...new Set(variants.filter((v) => v !== ""))];
}

/**
 * 開催を確かめるための検索の言葉。上から順に優先し、上限（MAX_VERIFICATION_QUERIES）で切る。
 * 1. 公式のサイトの中を、祭りの名前と年で探す（主催者・神社・自治体）
 * 2. 名前と年（西暦）と「日程」
 * 3. 会場（神社・寺・公園など）の名前と、確かめる年と月（小さな祭りは、祭りの名前を書かず、
 *    会場の行事の日程だけを載せたページが多い）
 * 4. 祭りの名前だけ（年の書かれていない案内や、地域のイベントのページも拾う）
 * 5. 市町村の名前と名前（同じ名前の別の土地の祭りと分ける）
 * 6. 市町村の名前と名前と令和の年（地域の呼び方で探す）
 * 7. 名前と「広報」と月（地域の広報誌の PDF に載る小さな行事。広報誌は月ごとに出る）
 * 8. 名前の別の書き方と年
 */
export function verificationQueries(festival: Festival, date: IsoDate): string[] {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const venue = festival.venue.name.trim();
  const reiwa = reiwaYear(year);
  const [name = festival.name.ja, ...others] = nameVariants(festival.name.ja);
  const city = festival.municipalities[0]?.name ?? "";
  const officialHost = [...festival.sources, ...festival.occurrences.flatMap((o) => o.sources)]
    .filter((s) => s.confidence === "official")
    .map((s) => hostOf(s.url))
    .find((host): host is string => host !== null);
  const queries = [
    ...(officialHost ? [`site:${officialHost} ${name} ${year}`] : []),
    `${name} ${year} 日程`,
    // 会場の名前が祭りの名前の中にあれば、名前と年の言葉と変わらないので足さない
    ...(venue !== "" && !name.includes(venue) ? [`${venue} ${year}年${month}月`] : []),
    name,
    ...(city !== "" ? [`${city} ${name}`] : []),
    ...(reiwa !== null && city !== "" ? [`${city} ${name} 令和${reiwa}年`] : []),
    `${city} ${name} 広報 ${month}月`.trim(),
    ...others.map((other) => `${other} ${year}`),
  ];
  return [...new Set(queries)].slice(0, MAX_VERIFICATION_QUERIES);
}

/**
 * 情報源の優先順位（小さいほど先に読む）。
 * 1. 主催者・神社・自治体の公式の案内（祭りのデータで公式とした出典のホスト、自治体の lg.jp）
 * 2. 観光協会・公式の地域イベント情報（データで公式としたほかのホスト）
 * 3. 地域の広報誌の PDF
 * 4. 地域のメディア・イベントサイト
 * 5. ブログ・SNS（手がかりだけに使い、公式で確かめ直す）
 */
export function sourcePriority(url: string, officialHosts: ReadonlySet<string>): number {
  const host = hostOf(url);
  if (host === null) return 5;
  if (/\.lg\.jp$/.test(host) || /\.(?:pref|city|town|vill)\.[a-z-]+\.jp$/.test(host)) return 1;
  if (officialHosts.has(host)) return /kanko|kankou|tourism|travel|navi/.test(host) ? 2 : 1;
  if (/\.pdf(?:$|[?#])/i.test(url)) return 3;
  if (
    /(?:^|\.)(?:ameblo\.jp|note\.com|hatenablog\.|fc2\.com|livedoor\.|x\.com|twitter\.com|instagram\.com|facebook\.com|tiktok\.com|youtube\.com)/.test(
      host,
    )
  ) {
    return 5;
  }
  return 4;
}

/** 出典を優先順位の順に並べる（同じ順位の中は元の順） */
export function bySourcePriority<T extends Pick<Source, "url">>(
  sources: readonly T[],
  officialHosts: ReadonlySet<string>,
): T[] {
  return sources
    .map((source, index) => ({ source, index, rank: sourcePriority(source.url, officialHosts) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ source }) => source);
}
