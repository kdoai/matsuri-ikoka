import {
  type Festival,
  type FestivalKind,
  type FestivalNearMatch,
  type FestivalSearchConditions,
  type FestivalSearchNext,
  type FestivalSearchResponse,
  type FestivalSearchResult,
  type FestivalWishIntent,
  type FestivalWishReading,
  type IsoDate,
  isOccurrenceConfirmed,
  MAX_FESTIVAL_RESULTS,
  type Occurrence,
  type Prefecture,
  type Season,
} from "@matsuri-ikoka/schema";
import { addDays, formatMonthDay, laterDate } from "./calendar";
import { type FestivalMatch, toCandidate } from "./dateWindow";
import { festivalInPrefectures, neighborsOf } from "./destination";
import {
  mentions,
  NO_WISH_SCORE,
  readWishByWords,
  scoreWish,
  type WishFit,
  type WishScore,
} from "./festivalSearchWish";

// 祭りから探す（docs/spec/festival-search.md の「探し方」）。
// 1. 必ず守る条件（種類・季節・地域・掲載停止・中止と延期・過ぎた日）に合う祭りだけを候補にする
// 2. 自由記述の読み取り（FestivalWishIntent）は並び順にだけ効かせる。祭りの有無は変えない
// 3. 点を付けて並べ、同じ県・同じ種類に偏らないように選ぶ
// 計算はすべてコードで行う。

/** 種類の3つの軸。軸の中はどれかに合えばよく、軸どうしはすべて合う祭りを出す */
const KIND_AXES = {
  genre: ["fireworks", "community", "traditional"],
  participation: ["participatory"],
  fame: ["hidden", "famous"],
} as const satisfies Record<string, readonly FestivalKind[]>;
type KindAxis = keyof typeof KIND_AXES;
const AXES = Object.keys(KIND_AXES) as KindAxis[];

const KIND_LABELS: Readonly<Record<FestivalKind, string>> = {
  fireworks: "花火",
  community: "地域の祭り",
  traditional: "伝統的な祭り",
  participatory: "参加型の祭り",
  hidden: "マイナーなお祭り",
  famous: "メジャーなお祭り",
};

const SEASON_MONTHS: Readonly<Record<Season, readonly number[]>> = {
  spring: [3, 4, 5],
  summer: [6, 7, 8],
  autumn: [9, 10, 11],
  winter: [12, 1, 2],
};

const SEASON_LABELS: Readonly<Record<Season, string>> = {
  spring: "春",
  summer: "夏",
  autumn: "秋",
  winter: "冬",
};

/** 1回の結果に、同じ県を入れる数と、同じ category を入れる数の上限（足りないときは緩める） */
const MAX_PER_PREFECTURE = 2;
const MAX_PER_CATEGORY = 3;
/** 複数日の開催を調べる日数の上限 */
const MAX_OCCURRENCE_DAYS = 366;

/** 見どころや小話にあれば、受け継がれてきたと言える言葉（文化財と、由来の年代） */
const TRADITION_WORDS =
  /文化財|無形民俗|世界遺産|創始|起源|由来|年の歴史|\d+年以上|百年|古来|古式|伝統|(江戸|室町|鎌倉|平安|安土桃山|戦国|南北朝|奈良)(時代|初期|前期|中期|後期|末期)|(明治|大正)(\d|元年|時代|初期|中期|末期)/;

function hasTraditionWords(festival: Festival): boolean {
  return [...festival.highlights, ...festival.trivia.map((t) => t.text)].some((text) =>
    TRADITION_WORDS.test(text.normalize("NFKC")),
  );
}

export type KindStrength = "strong" | "weak";

/** 祭りが種類に合うか。強く合う / 弱く合う（強く合う祭りのあとに並べる）/ 合わない（null） */
export function matchKind(festival: Festival, kind: FestivalKind): KindStrength | null {
  const hasStyle = (style: Festival["styles"][number]["style"]) =>
    festival.styles.some((s) => s.style === style);
  switch (kind) {
    case "fireworks":
      if (festival.category === "fireworks") return "strong";
      return mentions(festival.highlights, "花火") ? "weak" : null;
    case "community":
      if (hasStyle("community")) return "strong";
      return festival.styles.length === 0 &&
        festival.scaleTier !== "L" &&
        festival.popularity !== "major" &&
        festival.category !== "fireworks"
        ? "weak"
        : null;
    case "traditional":
      if (hasStyle("traditional")) return "strong";
      return festival.styles.length === 0 &&
        festival.category !== "fireworks" &&
        festival.category !== "market" &&
        hasTraditionWords(festival)
        ? "weak"
        : null;
    case "participatory":
      return festival.etiquette.participation === "join_open" ||
        festival.etiquette.participation === "join_by_application"
        ? "strong"
        : null;
    case "hidden":
      return festival.popularity === "local" ? "strong" : null;
    case "famous":
      if (festival.popularity === "major") return "strong";
      return festival.popularity === "regional" && festival.scaleTier === "L" ? "weak" : null;
  }
}

interface KindCheck {
  /** 選んだ種類のうち、合ったもの（選んだ順） */
  matched: FestivalKind[];
  strengths: Partial<Record<FestivalKind, KindStrength>>;
  /** 合わなかった軸 */
  missedAxes: KindAxis[];
  /** 弱い一致でしか合っていない軸の数 */
  weakAxes: number;
}

function checkKinds(festival: Festival, kinds: readonly FestivalKind[]): KindCheck {
  const check: KindCheck = { matched: [], strengths: {}, missedAxes: [], weakAxes: 0 };
  for (const kind of new Set(kinds)) {
    const strength = matchKind(festival, kind);
    if (strength === null) continue;
    check.matched.push(kind);
    check.strengths[kind] = strength;
  }
  for (const axis of AXES) {
    const selected = (KIND_AXES[axis] as readonly FestivalKind[]).filter((k) => kinds.includes(k));
    if (selected.length === 0) continue;
    const strengths = selected.map((k) => check.strengths[k]);
    if (strengths.includes("strong")) continue;
    if (strengths.includes("weak")) check.weakAxes += 1;
    else check.missedAxes.push(axis);
  }
  return check;
}

function inSeason(date: IsoDate, season: Season | null): boolean {
  return season === null || SEASON_MONTHS[season].includes(Number(date.slice(5, 7)));
}

/**
 * 開催回の、今日以降で季節に入るいちばん早い日。なければ null。
 * 何日かにまたがる開催は、どれかの日が季節に入れば合うとする
 */
function firstDayInSeason(
  occurrence: Occurrence,
  season: Season | null,
  today: IsoDate,
): IsoDate | null {
  const last = occurrence.endDate ?? occurrence.date;
  let date = laterDate(occurrence.date, today);
  for (let i = 0; i < MAX_OCCURRENCE_DAYS && date <= last; i += 1) {
    if (inSeason(date, season)) return date;
    date = addDays(date, 1);
  }
  return null;
}

/** 候補の日：今日以降で季節に入る、いちばん早い開催回。中止・延期の回は使わず、日付も推測しない */
function matchOf(festival: Festival, season: Season | null, today: IsoDate): FestivalMatch | null {
  let best: FestivalMatch | null = null;
  for (const occurrence of festival.occurrences) {
    if (occurrence.status === "cancelled" || occurrence.status === "postponed") continue;
    const date = firstDayInSeason(occurrence, season, today);
    if (date === null || (best !== null && date >= best.date)) continue;
    best = {
      festival,
      occurrence,
      date,
      daysFromWish: 0,
      confirmed: isOccurrenceConfirmed(occurrence),
      travelMinutes: null,
      travelBasis: null,
      travelFit: null,
    };
  }
  return best;
}

function inArea(festival: Festival, prefectures: readonly Prefecture[]): boolean {
  return prefectures.length === 0 || festivalInPrefectures(festival, new Set(prefectures));
}

/** 必ず守る条件にすべて合う祭り（日付つき）。掲載停止・中止と延期・過ぎた日は入らない */
export function matchesOf(
  festivals: readonly Festival[],
  conditions: FestivalSearchConditions,
  today: IsoDate,
): { match: FestivalMatch; kinds: KindCheck }[] {
  const out: { match: FestivalMatch; kinds: KindCheck }[] = [];
  for (const festival of festivals) {
    if (festival.optOut || !inArea(festival, conditions.prefectures)) continue;
    const kinds = checkKinds(festival, conditions.kinds);
    if (kinds.missedAxes.length > 0) continue;
    const match = matchOf(festival, conditions.season, today);
    if (match !== null) out.push({ match, kinds });
  }
  return out;
}

/** 文字列から決まる 0 以上の整数（FNV-1a と攪拌）。同じ相談では、同じ祭りに同じ値を返す */
function seededRank(sessionId: string, festivalId: string): number {
  let hash = 0x811c9dc5;
  for (const c of `${sessionId}\u0000${festivalId}`) {
    hash ^= c.codePointAt(0) as number;
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

const FIT_ORDER: readonly (WishFit | null)[] = ["matched", "partial", null, "none"];
const fitRank = (fit: WishFit | null) => FIT_ORDER.indexOf(fit);

interface Ranked {
  match: FestivalMatch;
  kinds: KindCheck;
  wish: WishScore;
  tie: number;
}

/**
 * 並べる。自由記述に合う度合い → 種類の強い一致 → 開催が確かめられている → 相談ごとに決まる乱数の順。
 * 見せた祭りを除いても順が変わらないよう、乱数は相談の ID と祭りの ID だけで決める
 */
function compareRanked(a: Ranked, b: Ranked): number {
  return (
    fitRank(a.wish.fit) - fitRank(b.wish.fit) ||
    b.wish.points - a.wish.points ||
    a.kinds.weakAxes - b.kinds.weakAxes ||
    Number(b.match.confirmed) - Number(a.match.confirmed) ||
    a.tie - b.tie ||
    a.match.festival.id.localeCompare(b.match.festival.id)
  );
}

function prefecturesOf(festival: Festival): Prefecture[] {
  return [...new Set(festival.municipalities.map((m) => m.prefecture))];
}

/**
 * 並べた祭りから1回分を選ぶ。同じ県は2件まで（地域が1県のときは数えない）、同じ category は3件まで。
 * 足りないときは、上限を1つずつ緩めて埋める。
 * 自由記述に合う度合いが上の祭りや、種類に強く合う祭りが残っているのに、下の祭りを出さない（偏りより条件を先にする）
 */
export function pickBatch<
  T extends { match: FestivalMatch; wish: WishScore; kinds: Pick<KindCheck, "weakAxes"> },
>(ranked: readonly T[], options: { limitPrefectures: boolean; size?: number }): T[] {
  const size = options.size ?? MAX_FESTIVAL_RESULTS;
  const picked = new Set<T>();
  const perPrefecture = new Map<Prefecture, number>();
  const perCategory = new Map<Festival["category"], number>();

  const fits = (item: T, slack: number) => {
    const { festival } = item.match;
    if ((perCategory.get(festival.category) ?? 0) >= MAX_PER_CATEGORY + slack) return false;
    return (
      !options.limitPrefectures ||
      prefecturesOf(festival).every((p) => (perPrefecture.get(p) ?? 0) < MAX_PER_PREFECTURE + slack)
    );
  };
  const take = (item: T) => {
    const { festival } = item.match;
    picked.add(item);
    perCategory.set(festival.category, (perCategory.get(festival.category) ?? 0) + 1);
    for (const p of prefecturesOf(festival)) {
      perPrefecture.set(p, (perPrefecture.get(p) ?? 0) + 1);
    }
  };

  for (const fit of FIT_ORDER) {
    const sameFit = ranked.filter((item) => item.wish.fit === fit);
    const tiers = [...new Set(sameFit.map((item) => item.kinds.weakAxes))].sort((a, b) => a - b);
    for (const tier of tiers) {
      let rest = sameFit.filter((item) => item.kinds.weakAxes === tier);
      for (let slack = 0; rest.length > 0 && picked.size < size; slack += 1) {
        const skipped: T[] = [];
        for (const item of rest) {
          if (picked.size < size && fits(item, slack)) take(item);
          else skipped.push(item);
        }
        rest = skipped;
      }
    }
  }
  // 選んだ順ではなく、点の順で見せる
  return ranked.filter((item) => picked.has(item));
}

// ---------------------------------------------------------------------------
// 理由

function kindReason(festival: Festival, kind: FestivalKind, strength: KindStrength): string {
  const basis = (style: Festival["styles"][number]["style"]) =>
    festival.styles.find((s) => s.style === style)?.basis;
  switch (kind) {
    case "fireworks":
      return strength === "strong" ? "花火が主役の祭りです" : "見どころに花火があります";
    case "community":
      return basis("community") ?? "規模が大きすぎない、地域の祭りです";
    case "traditional":
      return basis("traditional") ?? "文化財や由来の記録がある祭りです";
    case "participatory":
      return festival.etiquette.participation === "join_by_application"
        ? "参加には申し込みが必要です"
        : "だれでも加われます";
    case "hidden":
      return "大手の観光サイトにほとんど載っていない穴場です";
    case "famous":
      return strength === "strong"
        ? "多くの観光サイトに載る定番の祭りです"
        : "規模が大きく、一部の観光サイトに載る祭りです";
  }
}

/** 理由は3つまで。申し込みが要ることは必ず添える。そのあとは希望に合った点、種類の順 */
function reasonsOf(match: FestivalMatch, kinds: KindCheck, wish: WishScore): string[] {
  const { festival } = match;
  const needsApplication =
    kinds.matched.includes("participatory") &&
    festival.etiquette.participation === "join_by_application";
  const kindReasons = kinds.matched
    .filter((k) => !(needsApplication && k === "participatory"))
    .map((k) => kindReason(festival, k, kinds.strengths[k] as KindStrength));
  const wishReason =
    wish.hits.length > 0 ? [`ご希望の${wish.hits.map((h) => `「${h}」`).join("")}に合います`] : [];
  const reasons = [
    ...(needsApplication ? ["参加には申し込みが必要です"] : []),
    ...wishReason,
    ...kindReasons,
  ].slice(0, 3);
  return reasons.length > 0 ? reasons : [`${formatMonthDay(match.date)}に開きます`];
}

function toResult(item: Pick<Ranked, "match" | "kinds" | "wish">): FestivalSearchResult {
  return {
    candidate: toCandidate(item.match),
    matchedKinds: item.kinds.matched,
    reasons: reasonsOf(item.match, item.kinds, item.wish),
    wishFit: item.wish.fit,
  };
}

// ---------------------------------------------------------------------------
// 見つからないとき、見終えたとき

/** 条件を1つだけ外せば出る祭り。外れている点ごとに順に選び、かたよらないようにする */
function nearMatchesOf(
  festivals: readonly Festival[],
  conditions: FestivalSearchConditions,
  context: {
    today: IsoDate;
    excluded: ReadonlySet<string>;
    rank: (match: FestivalMatch, kinds: KindCheck) => Ranked;
  },
): FestivalNearMatch[] {
  const { season, prefectures, kinds } = conditions;
  const near = new Set(neighborsOf(prefectures));
  const groups = new Map<string, { ranked: Ranked; miss: string; neighbor: boolean }[]>();

  for (const festival of festivals) {
    if (festival.optOut || context.excluded.has(festival.id)) continue;
    const check = checkKinds(festival, kinds);
    const areaMissed = !inArea(festival, prefectures);
    const inSeasonMatch = matchOf(festival, season, context.today);
    const seasonMissed = season !== null && inSeasonMatch === null;
    const missCount = check.missedAxes.length + Number(areaMissed) + Number(seasonMissed);
    if (missCount !== 1) continue;
    // 季節だけが外れた祭りは、いちばん早い開催回を見せる
    const match = seasonMissed ? matchOf(festival, null, context.today) : inSeasonMatch;
    if (match === null) continue;

    let key: string;
    let miss: string;
    if (seasonMissed) {
      key = "season";
      miss = `ご希望の${SEASON_LABELS[season]}ではなく、${formatMonthDay(match.date)}に開きます`;
    } else if (areaMissed) {
      key = "area";
      miss = `選んだ地域の外の${prefecturesOf(festival).join("・")}にあります`;
    } else {
      const axis = check.missedAxes[0] as KindAxis;
      key = axis;
      miss = axisMiss(festival, axis, kinds);
    }
    const entries = groups.get(key) ?? [];
    entries.push({
      ranked: context.rank(match, check),
      miss,
      neighbor: festivalInPrefectures(festival, near),
    });
    groups.set(key, entries);
  }

  for (const entries of groups.values()) {
    // 地域から外れた祭りは、隣の県を先に見せる
    entries.sort(
      (a, b) => Number(b.neighbor) - Number(a.neighbor) || compareRanked(a.ranked, b.ranked),
    );
  }
  const out: FestivalNearMatch[] = [];
  const ordered = [...groups.values()];
  for (let round = 0; out.length < MAX_FESTIVAL_RESULTS; round += 1) {
    let added = false;
    for (const entries of ordered) {
      const entry = entries[round];
      if (entry === undefined || out.length >= MAX_FESTIVAL_RESULTS) continue;
      out.push({ result: toResult(entry.ranked), miss: entry.miss });
      added = true;
    }
    if (!added) break;
  }
  return out;
}

function axisMiss(festival: Festival, axis: KindAxis, kinds: readonly FestivalKind[]): string {
  if (axis === "participation") {
    return festival.etiquette.participation === "unknown"
      ? "加われるかどうかが分かっていません"
      : "見学のみの祭りです";
  }
  const selected = (KIND_AXES[axis] as readonly FestivalKind[]).filter((k) => kinds.includes(k));
  return `${selected.map((k) => KIND_LABELS[k]).join("・")}には当たりません`;
}

/** 次の手。変えた条件で、まだ見せていない祭りを数え、祭りのあるものだけを返す。最後に「条件を選び直す」 */
function nextStepsOf(
  festivals: readonly Festival[],
  conditions: FestivalSearchConditions,
  today: IsoDate,
  shown: ReadonlySet<string>,
): FestivalSearchNext[] {
  const steps: Omit<FestivalSearchNext, "found">[] = [];
  if (conditions.season !== null) {
    steps.push({
      kind: "any_season",
      label: "季節を問わず探す",
      conditions: { ...conditions, season: null },
    });
  }
  if (conditions.kinds.length > 0) {
    steps.push({
      kind: "any_kind",
      label: "種類を問わず探す",
      conditions: { ...conditions, kinds: [] },
    });
  }
  if (conditions.prefectures.length > 0) {
    const neighbors = neighborsOf(conditions.prefectures);
    if (neighbors.length > 0) {
      steps.push({
        kind: "neighbor_area",
        label: "隣の県まで広げる",
        conditions: { ...conditions, prefectures: [...conditions.prefectures, ...neighbors] },
      });
    }
    steps.push({
      kind: "nationwide",
      label: "全国から探す",
      conditions: { ...conditions, prefectures: [] },
    });
  }
  const counted = steps.flatMap((step): FestivalSearchNext[] => {
    if (step.conditions === null) return [];
    const found = matchesOf(festivals, step.conditions, today).filter(
      ({ match }) => !shown.has(match.festival.id),
    ).length;
    return found === 0 ? [] : [{ ...step, found }];
  });
  return [
    ...counted,
    { kind: "edit_conditions", label: "条件を選び直す", conditions: null, found: null },
  ];
}

// ---------------------------------------------------------------------------

export interface FestivalSearchInput {
  conditions: FestivalSearchConditions;
  sessionId: string;
  /** すでに見せた祭り */
  excludeIds?: readonly string[];
  /** その他の希望（自由記述）。空なら読まない */
  wish?: string | undefined;
  /** 自由記述をモデルで読んだ結果。省略すると言葉の辞書で読む */
  wishIntent?: FestivalWishIntent | undefined;
  today: IsoDate;
}

/**
 * 祭りから探す。必ず守る条件に合う祭りだけを results に返し、見せた祭りは出さない。
 * results が空なら、条件を1つだけ外せば出る祭りを nearMatches に分けて返す
 */
export function searchFestivalsByConditions(
  festivals: readonly Festival[],
  input: FestivalSearchInput,
): FestivalSearchResponse {
  const { conditions, sessionId, today } = input;
  const wish = input.wish?.trim() ?? "";
  const intent = wish === "" ? null : (input.wishIntent ?? readWishByWords(wish));
  const reading: FestivalWishReading | null =
    intent === null
      ? null
      : { text: intent.summary, by: input.wishIntent === undefined ? "words" : "model" };
  const excluded = new Set(input.excludeIds ?? []);

  const rank = (match: FestivalMatch, kinds: KindCheck): Ranked => ({
    match,
    kinds,
    wish:
      intent === null ? NO_WISH_SCORE : scoreWish(match.festival, match.occurrence, intent, wish),
    tie: seededRank(sessionId, match.festival.id),
  });

  const ranked = matchesOf(festivals, conditions, today)
    .filter(({ match }) => !excluded.has(match.festival.id))
    .map(({ match, kinds }) => rank(match, kinds))
    .sort(compareRanked);
  const picked = pickBatch(ranked, { limitPrefectures: conditions.prefectures.length !== 1 });
  const results = picked.map(toResult);
  const remaining = ranked.length - picked.length;

  const shown = new Set([...excluded, ...picked.map((p) => p.match.festival.id)]);
  return {
    results,
    remaining,
    nearMatches:
      results.length === 0 ? nearMatchesOf(festivals, conditions, { today, excluded, rank }) : [],
    next: remaining === 0 ? nextStepsOf(festivals, conditions, today, shown) : [],
    reading,
  };
}
