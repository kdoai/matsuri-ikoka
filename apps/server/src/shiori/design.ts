import type { Festival, IsoDate } from "@matsuri-ikoka/schema";
import { toMinutes } from "../domain/calendar";
import type { ShioriTrip } from "./trip";

// しおりの見た目の選び方。祭りの種類・季節・日数・同行者から、コードの決まった規則で選ぶ。
// モデルには HTML や CSS を書かせない。

export type FestivalCategory = Festival["category"];
export type Season = "spring" | "summer" | "autumn" | "winter";
/** 半日のお出かけ / 日帰り / 泊まりの旅 */
export type TripLength = "outing" | "day_trip" | "overnight";
/** 表紙の明るさ。夜に見る祭り（花火・灯籠・火祭り）は夜空の表紙にする */
export type CoverTone = "night" | "day";

export type PageKind =
  | "cover"
  | "festival"
  | "overview"
  | "day"
  | "guide"
  | "checklist"
  | "stamps"
  | "sources"
  | "memory"
  | "back";

/** 素材の静止画（assets/shiori/staff/{name}.webp） */
export type StaffStill =
  | "hiyoko_wave"
  | "hiyoko_stamp"
  | "owl_book"
  | "hen_point"
  | "sparrow_binder"
  | "penguin_cheer"
  | "penguin_stampbook";

export interface Palette {
  /** 表紙の地の色 */
  coverBg: string;
  /** 表紙の文字の色 */
  coverInk: string;
  /** 見出しの帯と強調 */
  accent: string;
  /** 見出しの帯の上の文字（accent の上で読める色） */
  onAccent: string;
  /** 薄い地（箱の背景） */
  soft: string;
  /** 素材の色（--c1〜--c3 は祭りの絵、--s1〜--s3 は季節の飾り） */
  c1: string;
  c2: string;
  c3: string;
  s1: string;
  s2: string;
  s3: string;
}

export interface ShioriDesign {
  season: Season;
  category: FestivalCategory;
  length: TripLength;
  coverTone: CoverTone;
  palette: Palette;
  /** 子ども連れ：持ち物に子どもの分を足し、スタンプ帳に絵を描く枠を出す */
  kids: boolean;
  /** シニアと一緒：文字をひとまわり大きくする */
  largeText: boolean;
  /** 1日分の予定を1ページにまとめ、出典を持ち物のページに続ける（薄いしおり） */
  compact: boolean;
}

/** 6時間以内で終わる日帰りは「半日のお出かけ」 */
export const OUTING_MAX_MINUTES = 6 * 60;

const NIGHT_CATEGORIES: ReadonlySet<FestivalCategory> = new Set(["fireworks", "lantern", "fire"]);

export function seasonOf(date: IsoDate): Season {
  const month = Number(date.slice(5, 7));
  if (month >= 3 && month <= 5) return "spring";
  if (month >= 6 && month <= 8) return "summer";
  if (month >= 9 && month <= 11) return "autumn";
  return "winter";
}

/** 1日の予定の長さ（分）。最後の予定の終わりが最初の始まりより前なら、日をまたぐ */
export function daySpanMinutes(items: readonly { start: string; end: string }[]): number {
  const first = items[0];
  const last = items[items.length - 1];
  if (first === undefined || last === undefined) return 0;
  const from = toMinutes(first.start);
  let to = toMinutes(last.end);
  if (to < from) to += 24 * 60;
  return to - from;
}

export function tripLengthOf(trip: Pick<ShioriTrip, "days">): TripLength {
  if (trip.days.length > 1) return "overnight";
  const day = trip.days[0];
  return day !== undefined && daySpanMinutes(day.items) <= OUTING_MAX_MINUTES
    ? "outing"
    : "day_trip";
}

// 季節ごとの色。文字に使う色（ink・accent）は白地で 4.5:1 以上、onAccent は accent の上で 4.5:1 以上
const SEASON_PALETTES: Record<Season, Omit<Palette, "coverBg" | "coverInk">> = {
  spring: {
    accent: "#B8325A",
    onAccent: "#FFFFFF",
    soft: "#FDEEF2",
    c1: "#E0607E",
    c2: "#F2B33D",
    c3: "#FFF4E0",
    s1: "#F4A6B8",
    s2: "#D9617E",
    s3: "#6BA368",
  },
  summer: {
    accent: "#1F4E9C",
    onAccent: "#FFFFFF",
    soft: "#EAF2FB",
    c1: "#E4572E",
    c2: "#F2B33D",
    c3: "#8FD3F4",
    s1: "#5BA8D8",
    s2: "#F28C6A",
    s3: "#FFF4E0",
  },
  autumn: {
    accent: "#A8401C",
    onAccent: "#FFFFFF",
    soft: "#FBF0E4",
    c1: "#D2552B",
    c2: "#E8A33D",
    c3: "#FFF4E0",
    s1: "#D2552B",
    s2: "#E8A33D",
    s3: "#8B5A2B",
  },
  winter: {
    accent: "#2A4A7F",
    onAccent: "#FFFFFF",
    soft: "#EEF2F8",
    c1: "#C23B4A",
    c2: "#F2B33D",
    c3: "#FFF4E0",
    s1: "#7FA7D9",
    s2: "#C23B4A",
    s3: "#FFFFFF",
  },
};

const COVER_BG: Record<CoverTone, Record<Season, { coverBg: string; coverInk: string }>> = {
  night: {
    spring: { coverBg: "#2B2350", coverInk: "#FFF8EC" },
    summer: { coverBg: "#14254F", coverInk: "#FFF8EC" },
    autumn: { coverBg: "#2E1F3D", coverInk: "#FFF8EC" },
    winter: { coverBg: "#16243F", coverInk: "#FFF8EC" },
  },
  day: {
    spring: { coverBg: "#FFF1F4", coverInk: "#2B1A1F" },
    summer: { coverBg: "#FFF6DD", coverInk: "#1B2440" },
    autumn: { coverBg: "#FFF1E2", coverInk: "#2E1B10" },
    winter: { coverBg: "#F1F5FB", coverInk: "#16243F" },
  },
};

/** しおりの見た目を決める。主役の祭りのデータがなければ「その他」の絵にする */
export function chooseDesign(
  trip: ShioriTrip,
  mainFestival: Pick<Festival, "category"> | undefined,
  mainDate: IsoDate,
): ShioriDesign {
  const season = seasonOf(mainDate);
  const category = mainFestival?.category ?? "other";
  const coverTone: CoverTone = NIGHT_CATEGORIES.has(category) ? "night" : "day";
  const length = tripLengthOf(trip);
  return {
    season,
    category,
    length,
    coverTone,
    palette: { ...SEASON_PALETTES[season], ...COVER_BG[coverTone][season] },
    kids: trip.party.children > 0 || trip.preferences.party === "kids",
    largeText: trip.preferences.party === "seniors",
    compact: length === "outing",
  };
}

/** 冊子にするとき、1枚の紙を2つ折りにすると4ページになる */
export const BOOKLET_PAGES = 4;

/**
 * ページの並び。日帰りや半日は薄く、泊まりの旅は日ごとにページが増える。
 * 印刷して冊子にできるよう、表紙で始めて裏表紙で終え、ページの数を4の倍数にそろえる。
 * 足りない分は、裏表紙の前に「旅の思い出」のページを入れる。半日のお出かけは、持ち物のページが裏表紙を兼ねる。
 * 泊まりの旅では、表紙の次に旅のかたちの図と日ごとの一覧（旅の全体）を置き、
 * 日ごとのページの下に「この日のメモ」を置く
 */
export function pagePlan(design: ShioriDesign, days: number, festivals: number): PageKind[] {
  const repeat = (kind: PageKind, n: number): PageKind[] => Array.from({ length: n }, () => kind);
  const festivalPages = repeat("festival", Math.max(1, festivals));
  const guidePages = repeat("guide", Math.max(1, festivals));
  const dayPages = repeat("day", days);
  if (design.length === "outing") {
    // 表紙に祭りの紹介をのせ、スタンプと出典は持ち物のページ（裏表紙を兼ねる）に続ける
    return padToBooklet(["cover", ...dayPages, ...guidePages], ["checklist"]);
  }
  return padToBooklet(
    [
      "cover",
      ...(design.length === "overnight" ? (["overview"] as PageKind[]) : []),
      ...festivalPages,
      ...dayPages,
      ...guidePages,
      "checklist",
      "stamps",
      "sources",
    ],
    ["back"],
  );
}

function padToBooklet(body: PageKind[], end: PageKind[]): PageKind[] {
  const total = body.length + end.length;
  const blank = (BOOKLET_PAGES - (total % BOOKLET_PAGES)) % BOOKLET_PAGES;
  return [...body, ...Array.from({ length: blank }, (): PageKind => "memory"), ...end];
}

/** ページごとに出すスタッフ（と旅人） */
export const PAGE_STAFF: Record<PageKind, StaffStill | null> = {
  cover: "penguin_cheer",
  festival: "owl_book",
  overview: "sparrow_binder",
  day: "sparrow_binder",
  guide: "hiyoko_wave",
  checklist: "penguin_stampbook",
  stamps: "hiyoko_stamp",
  sources: "owl_book",
  memory: "penguin_stampbook",
  back: "hiyoko_wave",
};
