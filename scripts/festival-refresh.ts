// 祭りのデータの定期の確かめ直しで使う、コードの規則の部分。
// どの祭りを調べ直すかを選ぶことと、調べ直した結果の差分を変更の種類で分けることの2つ。
// ファイルの読み込みも調査もしない（呼ぶ側が渡す）ので、テストではファイルなしで使える。
import {
  CONFIDENCE_LEVELS,
  type Confidence,
  type Festival,
  type IsoDate,
} from "../packages/schema/src";
import { staleMessages } from "./festival-validation";

// ---------------------------------------------------------------------------
// 調べ直す祭りを選ぶ

/** 開催が近いとみなす日数の既定値 */
export const DEFAULT_UPCOMING_WITHIN_DAYS = 30;

/**
 * 調べ直す理由。
 * request 掲載・訂正・掲載停止の依頼や、接客中に見つかった公式情報との食い違い /
 * expected これから先の開催回が「見込み」のまま / upcoming 開催が近い / stale 確認日が期限を過ぎた
 */
export const REFRESH_REASONS = ["request", "expected", "upcoming", "stale"] as const;
export type RefreshReason = (typeof REFRESH_REASONS)[number];

export const REFRESH_REQUEST_KINDS = ["correction", "listing", "opt_out", "discrepancy"] as const;

/** 祭りの ID に結び付け済みの依頼。Issue の本文から ID を決めるのは呼ぶ側の仕事 */
export interface RefreshRequest {
  festivalId: string;
  kind: (typeof REFRESH_REQUEST_KINDS)[number];
}

export interface RefreshTarget {
  id: string;
  reasons: RefreshReason[];
  /** これから先でいちばん近い開催回の初日。なければ null */
  nextDate: IsoDate | null;
  /** 調べる人に渡す手がかり（期限を過ぎた項目、依頼の種類など） */
  notes: string[];
}

export interface SelectOptions {
  today: IsoDate;
  upcomingWithinDays?: number;
  requests?: readonly RefreshRequest[];
}

/**
 * 調べ直す祭りを選ぶ。掲載停止（optOut）の祭りは、どの理由があっても選ばない。
 * 並びは、依頼のあるもの → 開催が近いもの → id の順（費用の上限で途中までにするときに、先頭から調べる）
 */
export function selectRefreshTargets(
  festivals: readonly Festival[],
  { today, upcomingWithinDays = DEFAULT_UPCOMING_WITHIN_DAYS, requests = [] }: SelectOptions,
): RefreshTarget[] {
  const targets: RefreshTarget[] = [];
  for (const festival of festivals) {
    if (festival.optOut) continue;
    const reasons = new Set<RefreshReason>();
    const notes: string[] = [];

    for (const request of requests) {
      if (request.festivalId !== festival.id) continue;
      reasons.add("request");
      notes.push(`依頼：${REQUEST_LABELS[request.kind]}`);
    }

    const ahead = festival.occurrences.filter((o) => (o.endDate ?? o.date) >= today);
    if (ahead.some((o) => o.status === "expected")) reasons.add("expected");
    if (ahead.some((o) => daysBetween(today, o.date) <= upcomingWithinDays)) {
      reasons.add("upcoming");
    }
    const stale = staleMessages(festival, today);
    if (stale.length > 0) {
      reasons.add("stale");
      notes.push(...stale);
    }

    if (reasons.size === 0) continue;
    const nextDate = ahead.map((o) => o.date).sort()[0] ?? null;
    targets.push({
      id: festival.id,
      reasons: REFRESH_REASONS.filter((reason) => reasons.has(reason)),
      nextDate,
      notes,
    });
  }
  return targets.sort(compareTargets);
}

const REQUEST_LABELS: Record<RefreshRequest["kind"], string> = {
  correction: "訂正",
  listing: "掲載・情報提供",
  opt_out: "掲載停止",
  discrepancy: "公式情報との食い違い",
};

function compareTargets(a: RefreshTarget, b: RefreshTarget): number {
  const requested = Number(b.reasons.includes("request")) - Number(a.reasons.includes("request"));
  if (requested !== 0) return requested;
  if (a.nextDate !== b.nextDate) {
    if (a.nextDate === null) return 1;
    if (b.nextDate === null) return -1;
    return a.nextDate < b.nextDate ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 差分を変更の種類で分ける

/**
 * 変更の種類。運用の仕様の「マージのルール」の表に合わせる。
 * 表にない種類（作法・周辺の場所・そのほかの中身）は、人が確かめる側に入れる
 */
export const CHANGE_KINDS = [
  "added",
  "cancelled_or_postponed",
  "schedule",
  "status_confirmed",
  "confidence_down",
  "source_removed",
  "opt_out",
  "etiquette",
  "nearby",
  "other",
  "popularity",
  "source_added",
  "confidence_up",
  "checked_only",
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** CI が通れば自動でマージしてよい種類。ほかは人が確かめる */
const AUTO_MERGE_KINDS: ReadonlySet<ChangeKind> = new Set([
  "checked_only",
  "source_added",
  "confidence_up",
  "popularity",
]);

/** PR の本文に書く、変更の種類の名前 */
export const CHANGE_LABELS: Record<ChangeKind, string> = {
  added: "新しい祭りの追加",
  cancelled_or_postponed: "中止・延期",
  schedule: "開催日・時間・会場の変更",
  status_confirmed: "開催の発表（見込みから確定）",
  confidence_down: "確度が下がる",
  source_removed: "出典が消える",
  opt_out: "掲載停止の変更",
  etiquette: "作法の変更",
  nearby: "周辺の場所の変更",
  other: "そのほかの中身の変更",
  popularity: "知名度の付け直し",
  source_added: "出典の追加",
  confidence_up: "確度が上がる",
  checked_only: "確認した日の更新だけ",
};

export interface FestivalChange {
  id: string;
  /** CHANGE_KINDS の順に並べる。変わっていなければ空 */
  kinds: ChangeKind[];
  review: "auto" | "human";
  /** 中止・延期を含む。人に優先して知らせる */
  urgent: boolean;
}

/** 調べ直す前（新しい祭りなら null）と後の祭りを比べ、変更の種類に分ける */
export function classifyFestivalChange(before: Festival | null, after: Festival): FestivalChange {
  const kinds = new Set<ChangeKind>();
  if (before === null) {
    kinds.add("added");
  } else {
    for (const kind of contentChanges(before, after)) kinds.add(kind);
    for (const kind of sourceChanges(before, after)) kinds.add(kind);
  }
  // 確認した日だけが変わったときに限って checked_only とする
  if (kinds.size > 1) kinds.delete("checked_only");
  const ordered = CHANGE_KINDS.filter((kind) => kinds.has(kind));
  return {
    id: after.id,
    kinds: ordered,
    review: ordered.every((kind) => AUTO_MERGE_KINDS.has(kind)) ? "auto" : "human",
    urgent: ordered.includes("cancelled_or_postponed"),
  };
}

function contentChanges(before: Festival, after: Festival): ChangeKind[] {
  const kinds: ChangeKind[] = [];
  const timing = (f: Festival) =>
    f.occurrences.map(({ date, endDate, start, end }) => ({ date, endDate, start, end }));
  if (!same(timing(before), timing(after)) || !same(before.venue, after.venue)) {
    kinds.push("schedule");
  }

  const beforeByDate = new Map(before.occurrences.map((o) => [o.date, o]));
  for (const occurrence of after.occurrences) {
    const previous = beforeByDate.get(occurrence.date);
    const halted = occurrence.status === "cancelled" || occurrence.status === "postponed";
    if (halted && previous?.status !== occurrence.status) {
      kinds.push("cancelled_or_postponed");
    } else if (previous === undefined) {
      // 新しい開催回は schedule に含まれる
    } else if (previous.status === "expected" && occurrence.status === "announced") {
      kinds.push("status_confirmed");
    } else if (previous.status !== occurrence.status) {
      kinds.push("other");
    }
    if (
      previous !== undefined &&
      (previous.rainPolicy !== occurrence.rainPolicy || previous.note !== occurrence.note)
    ) {
      kinds.push("other");
    }
  }

  if (before.popularity !== after.popularity || !same(before.listedIn, after.listedIn)) {
    kinds.push("popularity");
  }
  if (before.optOut !== after.optOut) kinds.push("opt_out");
  if (!same(withoutSources(before.etiquette), withoutSources(after.etiquette))) {
    kinds.push("etiquette");
  }
  if (!same(withoutSources(before.nearby), withoutSources(after.nearby))) kinds.push("nearby");

  const rest = (f: Festival) => {
    const {
      occurrences: _occurrences,
      venue: _venue,
      popularity: _popularity,
      listedIn: _listedIn,
      optOut: _optOut,
      etiquette: _etiquette,
      nearby: _nearby,
      ...others
    } = f;
    return withoutSources(others);
  };
  if (!same(rest(before), rest(after))) kinds.push("other");
  return kinds;
}

function sourceChanges(before: Festival, after: Festival): ChangeKind[] {
  const kinds: ChangeKind[] = [];
  const previous = indexSources(before);
  const next = indexSources(after);
  for (const [key, source] of next) {
    const old = previous.get(key);
    if (old === undefined) {
      kinds.push("source_added");
      continue;
    }
    const rank = rankOf(source.confidence) - rankOf(old.confidence);
    if (rank > 0) kinds.push("confidence_up");
    if (rank < 0) kinds.push("confidence_down");
    if (old.checkedAt !== source.checkedAt || old.title !== source.title) {
      kinds.push("checked_only");
    }
  }
  for (const key of previous.keys()) {
    if (!next.has(key)) kinds.push("source_removed");
  }
  return kinds;
}

interface IndexedSource {
  confidence: Confidence;
  checkedAt: IsoDate;
  title: string | undefined;
}

/**
 * 祭りの中の出典を「どこに付いているか＋URL」で引けるようにする。
 * 開催回は日付、周辺の場所は id、地元の味は名前で場所を表し、並びが変わっても同じ出典とみなす
 */
function indexSources(festival: Festival): Map<string, IndexedSource> {
  const index = new Map<string, IndexedSource>();
  const add = (place: string, sources: readonly Festival["sources"][number][]) => {
    for (const { url, confidence, checkedAt, title } of sources) {
      index.set(`${place} ${url}`, { confidence, checkedAt, title });
    }
  };
  add("sources", festival.sources);
  add("etiquette", festival.etiquette.sources);
  add("access", festival.access.sources);
  for (const trivia of festival.trivia) add(`trivia:${trivia.text}`, [trivia.source]);
  for (const occurrence of festival.occurrences) {
    add(`occurrence:${occurrence.date}`, occurrence.sources);
  }
  for (const food of festival.food.local) add(`food:${food.name}`, food.sources);
  for (const spot of festival.nearby) add(`nearby:${spot.id}`, spot.sources);
  return index;
}

/** 確度の強さ。大きいほど強い */
function rankOf(confidence: Confidence): number {
  return CONFIDENCE_LEVELS.length - CONFIDENCE_LEVELS.indexOf(confidence);
}

/** sources・source の項目を除いた写し（中身の比較に使う） */
function withoutSources(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSources);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "sources" && key !== "source")
        .map(([key, item]) => [key, withoutSources(item)]),
    );
  }
  return value;
}

/** JSON として同じか。キーの並びの違いは同じとみなす */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sortKeys(item)]),
    );
  }
  return value;
}

/** from から to までの日数（to が前なら負） */
function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}
