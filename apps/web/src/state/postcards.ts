import type { Festival, FestivalCandidate } from "@matsuri-ikoka/schema";

// 祭りの候補を絵葉書のカードにするための材料：目印のタグと、エリア・時期・テーマの絞り込み。
// どれも候補の項目と祭りのデータだけから決め、推測で足さない（分からなければタグを付けない）。

export const POSTCARD_TAGS = ["wishDay", "night", "join", "hidden", "stalls", "family"] as const;
export type PostcardTag = (typeof POSTCARD_TAGS)[number];

/** 夜のイベントとみなす始まりの時刻 */
const NIGHT_FROM = "17:00";

/** 候補の目印のタグ。祭りのデータがまだ届いていなければ、候補の項目から分かるものだけ */
export function candidateTags(
  candidate: FestivalCandidate,
  festival: Festival | null,
): PostcardTag[] {
  const tags: PostcardTag[] = [];
  if (candidate.daysFromWish === 0) tags.push("wishDay");
  if (candidate.start !== null && candidate.start >= NIGHT_FROM) tags.push("night");
  if (festival !== null) {
    const participation = festival.etiquette.participation;
    if (participation === "join_open" || participation === "join_by_application") {
      tags.push("join");
    }
    if (festival.popularity === "local") tags.push("hidden");
    if (festival.food.stalls === "yes") tags.push("stalls");
    if (festival.nearby.some((spot) => spot.tags.includes("kid_friendly"))) tags.push("family");
  }
  return tags;
}

/** 開催地の表示（例：滋賀県鈴鳴町）から、都道府県を取り出す。取り出せなければそのまま */
export function candidateArea(place: string): string {
  return /^(.{2,3}?[都道府県])/.exec(place)?.[1] ?? place;
}

/** 開催日の月（1〜12） */
export function candidateMonth(date: string): number {
  return Number(date.slice(5, 7));
}

export interface PostcardFilters {
  area: string | null;
  month: number | null;
  /** 祭りの種類（festival.category） */
  theme: string | null;
}

export const NO_FILTERS: PostcardFilters = { area: null, month: null, theme: null };

export function candidateTheme(festival: Festival | null): string {
  return festival?.category ?? "other";
}

/** 絞り込みに合う候補だけを、元の順のまま返す */
export function filterCandidates(
  candidates: readonly FestivalCandidate[],
  festivals: Readonly<Record<string, Festival>>,
  filters: PostcardFilters,
): FestivalCandidate[] {
  return candidates.filter(
    (candidate) =>
      (filters.area === null || candidateArea(candidate.place) === filters.area) &&
      (filters.month === null || candidateMonth(candidate.date) === filters.month) &&
      (filters.theme === null ||
        candidateTheme(festivals[candidate.festivalId] ?? null) === filters.theme),
  );
}

/** 絞り込みの選択肢と、それぞれに合う候補の数（出てくる順） */
export function filterOptions<T extends string | number>(
  candidates: readonly FestivalCandidate[],
  key: (candidate: FestivalCandidate) => T,
): { value: T; count: number }[] {
  const counts = new Map<T, number>();
  for (const candidate of candidates) {
    const value = key(candidate);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts].map(([value, count]) => ({ value, count }));
}
