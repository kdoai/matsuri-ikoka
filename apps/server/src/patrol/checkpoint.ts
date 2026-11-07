import { createHash } from "node:crypto";
import {
  checkPublicWebUrl,
  comparableUrl,
  parseJsonWithSchema,
  ungroundedSources,
} from "@matsuri-ikoka/agent-kit";
import {
  type CheckedChange,
  CheckedChangeSchema,
  type CheckedSource,
  type FestivalChange,
  type NoticeContent,
  type NoticeTopic,
  type PatrolFinding,
  type PatrolReport,
  PatrolReportSchema,
} from "@matsuri-ikoka/schema";
import { nowInJapan, todayInJapan } from "../domain/calendar";
import {
  announcesDate,
  announcesTime,
  hasScheduleValue,
  isInstructionLine,
  isOtherEvent,
  lineHash,
  mentionsDate,
  mentionsOtherYear,
  mentionsTime,
  normalizeLine,
  saysCancelled,
  saysPostponed,
} from "./lines";
import type { RunPage, RunTarget, ScheduleBaseline } from "./types";

// 検問。見回り係の報告は信用しない入力なので、形・URL・出典を確かめ、変化の種類はコードが決める。
// モデルの見立て（result）だけでは通知を作らない。値がコードで読んだ新しい行に書いてあることを確かめる。
// ページの文章は次へ渡さない。ここから出るのは、決まった形の値と出典だけ。

export type ReportParse =
  | { ok: true; report: PatrolReport }
  | { ok: false; reason: "unreadable" | "shape" | "other_patrol" };

export function parsePatrolReport(text: string, patrolId: string): ReportParse {
  const parsed = parseJsonWithSchema(text, PatrolReportSchema, "object");
  if (!parsed.ok) return { ok: false, reason: parsed.reason === "shape" ? "shape" : "unreadable" };
  if (parsed.value.patrolId !== patrolId) return { ok: false, reason: "other_patrol" };
  return { ok: true, report: parsed.value };
}

/** コードで読み直したページ */
export interface PageEvidence {
  url: string;
  /** コードで読めて、前回の控えと比べられた */
  verifiable: boolean;
  /** 読み直しが一時的に失敗した。読んだとは数えず、次の回に確かめ直す */
  transient: boolean;
  /** 前回になかった行（指示に見える行を除く） */
  added: readonly string[];
  /** ページの行（指示に見える行を除く） */
  lines: readonly string[];
  /** 新しい行のうち、指示に見えて除いた、日程や中止の言葉がある行の数 */
  suspiciousSchedule: number;
}

type Claim =
  | { kind: "date"; after: string }
  | { kind: "time"; field: "start" | "end"; after: string }
  | { kind: "postponed" }
  | { kind: "cancelled" };

/** 報告が言っている変化。前回の値と比べてコードで決める。分からない値（null）は変化にしない */
function claimsOf(
  finding: PatrolFinding,
  baseline: ScheduleBaseline,
  alreadyCancelled: boolean,
): Claim[] {
  const claims: Claim[] = [];
  if (finding.result === "cancelled" && !alreadyCancelled) claims.push({ kind: "cancelled" });
  const { date, start, end } = finding.observed;
  if (date !== null && date !== baseline.date) claims.push({ kind: "date", after: date });
  if (date === null && finding.result === "changed") claims.push({ kind: "postponed" });
  if (start !== null && start !== baseline.start) {
    claims.push({ kind: "time", field: "start", after: start });
  }
  if (end !== null && end !== baseline.end) claims.push({ kind: "time", field: "end", after: end });
  return claims;
}

function claimHolds(claim: Claim, evidence: PageEvidence, added: readonly string[]): boolean {
  switch (claim.kind) {
    case "date":
      return (
        added.some((line) => announcesDate(line, claim.after)) ||
        // 新しい行で順延と言えていて、前から載っている予備日へ移るとき
        (added.some(saysPostponed) &&
          evidence.lines.some((line) => mentionsDate(line, claim.after) && !isOtherEvent(line)))
      );
    case "time":
      return added.some((line) => announcesTime(line, claim.after));
    case "postponed":
      return added.some(saysPostponed);
    case "cancelled":
      return added.some(saysCancelled);
  }
}

/** 値が、変わっていない行にだけ書いてあるか（読むだけで変化と言っているとき） */
function valueOnUnchangedLine(claim: Claim, evidence: PageEvidence): boolean {
  if (claim.kind === "date") {
    return evidence.lines.some((line) => mentionsDate(line, claim.after));
  }
  if (claim.kind === "time") {
    return evidence.lines.some((line) => mentionsTime(line, claim.after));
  }
  return false;
}

function fingerprintOf(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

const compact = (text: string) => text.replace(/\s+/g, "");

/** 写した開催日の文が、ページにそのまま書いてあるか。照合だけに使い、残さない */
function dateTextOnPage(dateText: string, evidence: PageEvidence): boolean {
  return compact(evidence.lines.join("")).includes(compact(normalizeLine(dateText)));
}

/** 同じ組織のサイトをまとめるための、日本の第2レベルの区分 */
const JP_GENERIC = new Set(["ac", "ad", "co", "ed", "go", "gr", "lg", "ne", "or"]);
const JP_PREFECTURES = new Set(
  (
    "aichi akita aomori chiba ehime fukui fukuoka fukushima gifu gunma hiroshima hokkaido hyogo ibaraki ishikawa " +
    "iwate kagawa kagoshima kanagawa kochi kumamoto kyoto mie miyagi miyazaki nagano nagasaki nara niigata oita " +
    "okayama okinawa osaka saga saitama shiga shimane shizuoka tochigi tokushima tokyo tottori toyama wakayama " +
    "yamagata yamaguchi yamanashi"
  ).split(" "),
);
const COUNTRY_GENERIC = new Set(["ac", "co", "com", "edu", "gov", "ne", "net", "or", "org"]);

/**
 * 同じサイトとして数えるための名前（登録ドメインの近似）。公開接尾辞の一覧は持たず、祭りの出典に多い形だけを見る。
 * まとめすぎると一致と数えないだけで、公式でない変更がお知らせに落ちる。誤って通知を増やす側には倒れない
 */
export function siteOf(hostname: string): string {
  const labels = hostname
    .toLowerCase()
    .replace(/^www\./, "")
    .split(".");
  const last = (count: number) => labels.slice(-count).join(".");
  const top = labels.at(-1) ?? "";
  const second = labels.at(-2) ?? "";
  if (top === "jp" && labels.length >= 3) {
    if (JP_GENERIC.has(second)) return last(3);
    if (JP_PREFECTURES.has(second)) {
      const third = labels.at(-3) ?? "";
      return third === "pref" || third === "city" ? last(3) : last(Math.min(4, labels.length));
    }
  }
  if (top.length === 2 && COUNTRY_GENERIC.has(second) && labels.length >= 3) return last(3);
  return last(2);
}

export type FindingOutcome =
  | "no_change"
  | "schedule_change"
  | "cancellation"
  | "announcement"
  /** 読んだページはあるが、言っている値が読めるページのどこからも確かめられない。指示に見える文字がある */
  | "rejected"
  /** 実際に開いたページが1つもない。結果として扱わず、調べ直す */
  | "not_read";

export interface FindingCheck {
  outcome: FindingOutcome;
  changes: CheckedChange[];
  /** 実際に開いたページ。比べる元を進めてよいのは、これらのページだけ */
  readUrls: string[];
  /** 検問を通った新しい開催の日時。変わっていなければ null */
  baseline: ScheduleBaseline | null;
  /** 新しい中止の状態。変わらなければ null */
  cancelled: boolean | null;
  /** 確かな開催の変更か中止を知らせる */
  firm: boolean;
}

/** 主張を支持するページから、確度をコードで決める */
function firmSources(
  pages: readonly RunPage[],
  checkedOn: string,
): { sources: CheckedSource[]; firm: boolean } {
  const sites = new Set(pages.map((page) => siteOf(new URL(page.url).hostname)));
  const corroborated = sites.size >= 2;
  const sources = pages.map((page) => ({
    url: page.url,
    checkedAt: checkedOn,
    confidence:
      page.confidence === "official"
        ? ("official" as const)
        : corroborated
          ? ("corroborated" as const)
          : ("single" as const),
  }));
  return { sources, firm: corroborated || pages.some((page) => page.confidence === "official") };
}

function checked(
  content: NoticeContent,
  fingerprintParts: unknown,
  sources: readonly CheckedSource[],
  checkedAt: string,
): CheckedChange | null {
  const parsed = CheckedChangeSchema.safeParse({
    fingerprint: fingerprintOf(fingerprintParts),
    content,
    sources,
    checkedAt,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * 1つの対象の報告を確かめる。
 * - 読んだページは、依頼にあり、実際に開いたものだけを数える。1つもなければ not_read
 * - 変化は、値がコードで読んだ新しい行に書いてあるときだけ認める。指示に見える行、別の年の行、
 *   一部の催しや別の催しの行は根拠にしない
 * - 変わっていない行にしかない値は、主張を捨てるだけで、お知らせの判定へ進む
 * - 開催の変更と中止は、主張ごとに、公式か2つのサイトで確かめられたときだけ。足りなければ、値を持たない
 *   お知らせ（announcement）に落とし、くわしくは出典のページを開いてもらう
 * - 新しい行に中止や延期の言葉があるのに報告が何も言っていなければ、黙って捨てず、お知らせにする
 */
export function checkFinding(input: {
  finding: PatrolFinding;
  target: RunTarget;
  baseline: ScheduleBaseline;
  /** 検問を通って中止と決まっている */
  cancelled?: boolean;
  /** これまでに知らせた開催の変更と中止の数 */
  changeCount?: number;
  evidence: readonly PageEvidence[];
  fetchedUrls: readonly string[];
  now: number;
}): FindingCheck {
  const { finding, target, baseline, evidence, fetchedUrls } = input;
  const alreadyCancelled = input.cancelled ?? false;
  const changeCount = input.changeCount ?? 0;
  const nowDate = new Date(input.now);
  const checkedAt = nowInJapan(nowDate);
  const checkedOn = todayInJapan(nowDate);

  const evidenceOf = (page: RunPage) =>
    evidence.find((item) => comparableUrl(item.url) === comparableUrl(page.url));

  const unread = new Set(
    ungroundedSources(
      finding.pages.map((url) => ({ url })),
      fetchedUrls,
    ),
  );
  const requested = new Map(target.pages.map((page) => [comparableUrl(page.url), page]));
  const read: RunPage[] = [];
  for (const url of finding.pages) {
    const page = requested.get(comparableUrl(url));
    if (page === undefined || unread.has(url) || !checkPublicWebUrl(url).ok) continue;
    if (read.includes(page) || evidenceOf(page)?.transient === true) continue;
    read.push(page);
  }
  const readUrls = read.map((page) => page.url);
  const result = (
    outcome: FindingOutcome,
    changes: CheckedChange[] = [],
    extra: Partial<FindingCheck> = {},
  ): FindingCheck => ({
    outcome,
    changes,
    readUrls,
    baseline: null,
    cancelled: null,
    firm: false,
    ...extra,
  });

  if (read.length === 0) return result("not_read");
  if (finding.dateText !== null && isInstructionLine(finding.dateText)) return result("rejected");

  const verifiable = read.filter((page) => evidenceOf(page)?.verifiable === true);
  const unverifiable = read.filter((page) => evidenceOf(page)?.verifiable !== true);

  // 読んだページがすべて読み直せたのに、写した文がどこにもなければ、報告そのものを信用しない
  if (
    finding.dateText !== null &&
    verifiable.length > 0 &&
    unverifiable.length === 0 &&
    !verifiable.some((page) => {
      const item = evidenceOf(page);
      return item !== undefined && dateTextOnPage(finding.dateText ?? "", item);
    })
  ) {
    return result("rejected");
  }

  /** 別の年の行は根拠にしない */
  const addedOf = (page: RunPage): string[] =>
    (evidenceOf(page)?.added ?? []).filter((line) => !mentionsOtherYear(line, target.date));

  const announcements = (topics: readonly NoticeTopic[], pages: readonly RunPage[]) => {
    // 指紋に報告の値を入れる。読めないページでは、時刻の変更のあとの中止を重複として捨てないため
    const marks = pages.flatMap((page) => {
      const added = addedOf(page);
      return evidenceOf(page)?.verifiable === true ? added.map(lineHash) : [page.url];
    });
    const parts = [finding.result, finding.observed, [...marks].sort()];
    return topics.flatMap((topic) => {
      const change = checked(
        { kind: "announcement", festivalId: target.festivalId, date: target.date, topic },
        ["announcement", target.key, topic, ...parts],
        firmSources(pages, checkedOn).sources,
        checkedAt,
      );
      return change === null ? [] : [change];
    });
  };
  const topicsOr = (fallback: NoticeTopic): readonly NoticeTopic[] =>
    finding.topics.length > 0 ? finding.topics : [fallback];

  const claims = claimsOf(finding, baseline, alreadyCancelled);
  const supportOf = (claim: Claim) =>
    verifiable.filter((page) => {
      const item = evidenceOf(page);
      return item !== undefined && claimHolds(claim, item, addedOf(page));
    });
  const firmClaims: { claim: Claim; pages: RunPage[] }[] = [];
  const weakPages: RunPage[] = [];
  let unsupported = 0;
  let unknown = 0;
  for (const claim of claims) {
    const pages = supportOf(claim);
    if (pages.length > 0) {
      if (firmSources(pages, checkedOn).firm) firmClaims.push({ claim, pages });
      else weakPages.push(...pages.filter((page) => !weakPages.includes(page)));
      continue;
    }
    if (claim.kind === "time" && baseline[claim.field] === null) continue;
    if (unverifiable.length > 0) {
      unknown += 1;
      continue;
    }
    const stale = verifiable.some((page) => {
      const item = evidenceOf(page);
      return item !== undefined && valueOnUnchangedLine(claim, item);
    });
    if (!stale) unsupported += 1;
  }

  const changes: CheckedChange[] = [];
  let next: ScheduleBaseline | null = null;
  let cancelled: boolean | null =
    alreadyCancelled && finding.result === "as_planned" ? false : null;
  const cancellation = firmClaims.find(({ claim }) => claim.kind === "cancelled");
  if (cancellation !== undefined) {
    const change = checked(
      { kind: "cancellation", festivalId: target.festivalId, date: target.date },
      ["cancellation", target.key, changeCount],
      firmSources(cancellation.pages, checkedOn).sources,
      checkedAt,
    );
    if (change !== null) changes.push(change);
    cancelled = true;
  } else if (firmClaims.length > 0) {
    const list: FestivalChange[] = [];
    const updated: ScheduleBaseline = { ...baseline };
    const pages: RunPage[] = [];
    for (const { claim, pages: support } of firmClaims) {
      pages.push(...support.filter((page) => !pages.includes(page)));
      if (claim.kind === "date") {
        list.push({ field: "date", before: baseline.date, after: claim.after });
        updated.date = claim.after;
      } else if (claim.kind === "postponed") {
        list.push({ field: "date", before: baseline.date, after: null });
      } else if (claim.kind === "time") {
        list.push({ field: claim.field, before: baseline[claim.field], after: claim.after });
        updated[claim.field] = claim.after;
      }
    }
    const content: NoticeContent = {
      kind: "schedule_change",
      festivalId: target.festivalId,
      date: target.date,
      changes: list,
    };
    const change = checked(
      content,
      [content, changeCount],
      firmClaims
        .flatMap(({ pages: support }) => firmSources(support, checkedOn).sources)
        .filter((source, index, all) => all.findIndex((item) => item.url === source.url) === index),
      checkedAt,
    );
    if (change !== null) {
      changes.push(change);
      next = updated;
    }
  }
  const firm = changes.length > 0;

  // 確かでない主張は、値を持たないお知らせに落とす
  if (weakPages.length > 0) changes.push(...announcements(topicsOr("other"), weakPages));
  if (unknown > 0) changes.push(...announcements(topicsOr("other"), unverifiable));

  if (changes.length === 0) {
    // 主張がないか確かめられなくても、新しい行に日程の言葉があれば、黙って捨てない
    const noValues =
      finding.observed.date === null &&
      finding.observed.start === null &&
      finding.observed.end === null;
    // すでに知らせた中止や順延の言葉が、ページに載り直しただけなら数えない
    const knownMove = baseline.date !== target.date && finding.observed.date === baseline.date;
    const unclear = verifiable.filter((page) => {
      const added = addedOf(page);
      return (
        added.some(
          (line) =>
            (saysCancelled(line) && !alreadyCancelled) || (saysPostponed(line) && !knownMove),
        ) ||
        (noValues && added.some(hasScheduleValue)) ||
        (evidenceOf(page)?.suspiciousSchedule ?? 0) > 0
      );
    });
    if (unclear.length > 0) changes.push(...announcements(topicsOr("other"), unclear));
    else if (finding.topics.length > 0) {
      // お知らせは、読めるページなら新しい行があるときだけ、読めないページならそのまま受ける
      const topicPages = [
        ...verifiable.filter((page) => addedOf(page).length > 0),
        ...unverifiable,
      ];
      if (topicPages.length > 0) changes.push(...announcements(finding.topics, topicPages));
    }
  }

  if (firm) {
    return result(cancellation !== undefined ? "cancellation" : "schedule_change", changes, {
      baseline: next,
      cancelled,
      firm: true,
    });
  }
  if (changes.length > 0) return result("announcement", changes, { cancelled });
  return result(unsupported > 0 ? "rejected" : "no_change", [], { cancelled });
}
