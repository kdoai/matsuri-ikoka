// 祭りのデータの週次の調査で使う、コードの規則の部分。
// 調べ直した結果の差分を変更の種類で分けることと、依頼の Issue から祭りの ID を決めること。
// どの祭りを調べるかを選ぶ規則は research-schedule.ts にある。
// ファイルの読み込みも調査もしない（呼ぶ側が渡す）ので、テストではファイルなしで使える。
import {
  CONFIDENCE_LEVELS,
  type Confidence,
  type Festival,
  type IsoDate,
} from "../packages/schema/src";

export const REFRESH_REQUEST_KINDS = ["correction", "listing", "opt_out", "discrepancy"] as const;

/** 祭りの ID に結び付け済みの依頼。Issue の本文から ID を決めるのは呼ぶ側の仕事 */
export interface RefreshRequest {
  festivalId: string;
  kind: (typeof REFRESH_REQUEST_KINDS)[number];
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
  url: string;
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
      index.set(`${place} ${url}`, { url, confidence, checkedAt, title });
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

// ---------------------------------------------------------------------------
// 依頼の Issue から祭りの ID を決める

/** 依頼の Issue のテンプレートが付けるラベルと、依頼の種類 */
const REQUEST_KIND_BY_LABEL: Record<string, RefreshRequest["kind"]> = {
  "data-correction": "correction",
  "listing-request": "listing",
  "opt-out": "opt_out",
};

/** Issue のテンプレートで、祭りの名前を書く欄の見出し */
const FESTIVAL_FIELD_HEADING = "祭りの名前";

export interface RefreshIssue {
  number: number;
  /** Issue の本文。誰でも書ける、信用しない入力 */
  body: string;
  labels: readonly string[];
}

export interface UnresolvedIssue {
  number: number;
  reason: "no_field" | "not_found" | "ambiguous";
}

export interface IssueRequests {
  requests: RefreshRequest[];
  /** 祭りの ID を決められなかった依頼。人が確かめる */
  unresolved: UnresolvedIssue[];
}

/**
 * 依頼の Issue（訂正・掲載・掲載停止）の「祭りの名前」の欄から、データにある祭りの ID を決める。
 * 欄の中に祭りの ID がそのまま書かれていればそれを使い、なければ祭りの名前（日本語・英語）で探す。
 * 決まるのはデータにある ID だけなので、本文に何が書かれていても、それ以外の値は出さない。
 * 依頼のラベルのない Issue は無視する。
 */
export function requestsFromIssues(
  issues: readonly RefreshIssue[],
  festivals: readonly Festival[],
): IssueRequests {
  const requests: RefreshRequest[] = [];
  const unresolved: UnresolvedIssue[] = [];
  for (const issue of issues) {
    const kind = issue.labels.map((label) => REQUEST_KIND_BY_LABEL[label]).find(Boolean);
    if (kind === undefined) continue;
    const field = formField(issue.body, FESTIVAL_FIELD_HEADING);
    if (field === null) {
      unresolved.push({ number: issue.number, reason: "no_field" });
      continue;
    }
    const [festivalId, ...others] = matchFestivals(field, festivals);
    if (festivalId === undefined) {
      unresolved.push({ number: issue.number, reason: "not_found" });
    } else if (others.length > 0) {
      unresolved.push({ number: issue.number, reason: "ambiguous" });
    } else {
      requests.push({ festivalId, kind });
    }
  }
  return { requests, unresolved };
}

/** Issue のフォームが本文に書く「### 見出し」の次から、次の見出しまでの文字。空なら null */
function formField(body: string, heading: string): string | null {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `### ${heading}`);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("### "));
  const value = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
  return value === "" || value === "_No response_" ? null : value;
}

function matchFestivals(field: string, festivals: readonly Festival[]): string[] {
  const text = normalize(field);
  const byId = festivals
    .filter((festival) => new RegExp(`(^|[^a-z0-9-])${festival.id}($|[^a-z0-9-])`).test(text))
    .map((festival) => festival.id);
  if (byId.length > 0) return byId;
  return festivals
    .filter((festival) =>
      [festival.name.ja, festival.name.en]
        .filter((name): name is string => name !== undefined)
        .some((name) => text.includes(normalize(name))),
    )
    .map((festival) => festival.id);
}

/** 全角・半角と大文字・小文字の違いをならす */
function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

// ---------------------------------------------------------------------------
// 調べ直した結果を PR の本文にする

/** 調べ直す前（新しい祭りなら null）と後の祭りの組 */
export interface RefreshResult {
  before: Festival | null;
  after: Festival;
}

/** 調べ直しで取り込まなかった祭りと、その理由（スキーマや検証に落ちたなど） */
export interface RejectedRefresh {
  id: string;
  reason: string;
}

export interface SourceChange {
  status: "added" | "removed" | "updated";
  url: string;
  confidence: Confidence;
  checkedAt: IsoDate;
}

/**
 * 変わった出典を一覧にする。付いている場所が違っても同じ URL なら1つにまとめる。
 * 追加 → 更新（確度・確認日・題名が変わった）→ 消えた、の順
 */
export function changedSources(before: Festival | null, after: Festival): SourceChange[] {
  const previous = before === null ? new Map<string, IndexedSource>() : indexSources(before);
  const next = indexSources(after);
  const found = new Map<string, SourceChange>();
  const add = (change: SourceChange) => {
    const key = `${change.status} ${change.url}`;
    if (!found.has(key)) found.set(key, change);
  };
  for (const [key, source] of next) {
    const old = previous.get(key);
    if (old === undefined) {
      add({ status: "added", ...pick(source) });
    } else if (
      old.confidence !== source.confidence ||
      old.checkedAt !== source.checkedAt ||
      old.title !== source.title
    ) {
      add({ status: "updated", ...pick(source) });
    }
  }
  for (const [key, source] of previous) {
    if (!next.has(key)) add({ status: "removed", ...pick(source) });
  }
  const order = { added: 0, updated: 1, removed: 2 } as const;
  return [...found.values()].sort((a, b) => order[a.status] - order[b.status]);
}

function pick({ url, confidence, checkedAt }: IndexedSource) {
  return { url, confidence, checkedAt };
}

/** 結果の全体を人が確かめるか。1件でも人が確かめるもの、取り込まなかったものがあれば human */
export function refreshReview(
  changes: readonly FestivalChange[],
  rejected: readonly RejectedRefresh[] = [],
): "auto" | "human" {
  return rejected.length === 0 && changes.every((change) => change.review === "auto")
    ? "auto"
    : "human";
}

const SOURCE_STATUS_LABELS: Record<SourceChange["status"], string> = {
  added: "追加",
  updated: "更新",
  removed: "消えた",
};

/**
 * 調べ直した結果を、PR の本文（Markdown）にする。
 * 変わらなかった祭りは数だけを書く。中止・延期は先頭に、人が確かめるもの、自動でよいものの順に並べ、
 * 祭りごとに変更の種類と変わった出典を書く。
 * 祭りの名前や理由は調査で集めた信用しない文字列なので、Markdown の記号を打ち消して1行にする
 */
export function refreshPullRequestBody(
  results: readonly RefreshResult[],
  rejected: readonly RejectedRefresh[] = [],
): string {
  const entries = results.map((result) => ({
    ...result,
    change: classifyFestivalChange(result.before, result.after),
  }));
  const changed = entries.filter((entry) => entry.change.kinds.length > 0);
  const urgent = changed.filter((entry) => entry.change.urgent);
  const human = changed.filter((entry) => !entry.change.urgent && entry.change.review === "human");
  const auto = changed.filter((entry) => entry.change.review === "auto");
  const review = refreshReview(
    changed.map((entry) => entry.change),
    rejected,
  );

  const lines = [
    "## 確かめ直した結果",
    "",
    `- マージ：${review === "auto" ? "CI が通れば自動でよい" : "人が確かめる"}`,
    `- 変わった祭り：${changed.length} 件（人が確かめる ${urgent.length + human.length} 件、自動でよい ${auto.length} 件）`,
    `- 変わらなかった祭り：${entries.length - changed.length} 件`,
    `- 取り込まなかった祭り：${rejected.length} 件`,
  ];
  const section = (title: string, list: typeof changed) => {
    if (list.length === 0) return;
    lines.push("", `### ${title}`, "");
    for (const { before, after, change } of list) {
      const kinds = change.kinds.map((kind) => CHANGE_LABELS[kind]).join("、");
      lines.push(`- \`${after.id}\` ${escapeMarkdown(after.name.ja)}：${kinds}`);
      for (const source of changedSources(before, after)) {
        lines.push(
          `  - 出典の${SOURCE_STATUS_LABELS[source.status]}：${linkOf(source.url)}（${source.confidence}、${source.checkedAt} に確認）`,
        );
      }
    }
  };
  section("優先して知らせる（中止・延期）", urgent);
  section("人が確かめる", human);
  section("自動でよい", auto);
  if (rejected.length > 0) {
    lines.push("", "### 取り込まなかった祭り", "");
    for (const { id, reason } of rejected) {
      lines.push(`- ${inlineCode(id)}：${escapeMarkdown(reason)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** URL を自動のリンクにする。山かっこ・空白を含むものはリンクにせず、文字として書く */
function linkOf(url: string): string {
  return /^https?:\/\/[^\s<>]+$/.test(url) ? `<${url}>` : escapeMarkdown(url);
}

/** 取り込まなかった祭りの ID は検証の前の値なので、そのまま書かない */
function inlineCode(text: string): string {
  return /^[a-z0-9-]+$/.test(text) ? `\`${text}\`` : escapeMarkdown(text);
}

/** Markdown・HTML の記号と、人への通知になる @ を打ち消し、改行を空白にして1行にする */
function escapeMarkdown(text: string): string {
  return text.replace(/\s+/g, " ").replace(/[\\`*_{}[\]()#+\-.!|<>~@&]/g, (mark) => `\\${mark}`);
}
