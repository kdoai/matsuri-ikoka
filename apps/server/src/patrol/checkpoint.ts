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
  isInstructionLine,
  lineHash,
  mentionsDate,
  mentionsTime,
  normalizeLine,
  saysCancelled,
  saysPostponed,
} from "./lines";
import type { RunPage, RunTarget, ScheduleBaseline } from "./types";

// 検問。見回り係の報告は信用しない入力なので、形・URL・出典を確かめ、変化の種類はコードが決める。
// モデルの見立て（result）だけでは通知を作らない。値がコードで読んだ行に書いてあることを確かめる。
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
  /** 前回になかった行（指示に見える行を除く） */
  added: readonly string[];
  /** ページの行（指示に見える行を除く） */
  lines: readonly string[];
}

type Claim =
  | { kind: "date"; after: string }
  | { kind: "time"; field: "start" | "end"; after: string }
  | { kind: "postponed" }
  | { kind: "cancelled" };

/** 報告が言っている変化。前回の値と比べてコードで決める。分からない値（null）は変化にしない */
function claimsOf(finding: PatrolFinding, baseline: ScheduleBaseline): Claim[] {
  const claims: Claim[] = [];
  if (finding.result === "cancelled") claims.push({ kind: "cancelled" });
  const { date, start, end } = finding.observed;
  if (date !== null && date !== baseline.date) claims.push({ kind: "date", after: date });
  if (date === null && finding.result === "changed") claims.push({ kind: "postponed" });
  if (start !== null && start !== baseline.start) {
    claims.push({ kind: "time", field: "start", after: start });
  }
  if (end !== null && end !== baseline.end) claims.push({ kind: "time", field: "end", after: end });
  return claims;
}

/** 検問でページを読み直す必要があるか（変化もお知らせも言っていなければ、読み直さない） */
export function needsEvidence(finding: PatrolFinding, baseline: ScheduleBaseline): boolean {
  return claimsOf(finding, baseline).length > 0 || finding.topics.length > 0;
}

function claimHolds(claim: Claim, line: string): boolean {
  switch (claim.kind) {
    case "date":
      return mentionsDate(line, claim.after);
    case "time":
      return mentionsTime(line, claim.after);
    case "postponed":
      return saysPostponed(line);
    case "cancelled":
      return saysCancelled(line);
  }
}

function fingerprintOf(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

const compact = (text: string) => text.replace(/\s+/g, "");

/** 写した開催日の文が、ページにそのまま書いてあるか。照合だけに使い、残さない */
function dateTextOnPage(dateText: string, evidence: PageEvidence): boolean {
  return compact(evidence.lines.join("")).includes(compact(normalizeLine(dateText)));
}

export type FindingOutcome =
  | "no_change"
  | "schedule_change"
  | "cancellation"
  | "announcement"
  /** 読んでいないページしかない、値がコードで読んだ行にない、指示に見える文字がある */
  | "rejected";

export interface FindingCheck {
  outcome: FindingOutcome;
  changes: CheckedChange[];
  /** 検問を通った新しい開催の日時。変わっていなければ null */
  baseline: ScheduleBaseline | null;
}

const REJECTED: FindingCheck = { outcome: "rejected", changes: [], baseline: null };
const NO_CHANGE: FindingCheck = { outcome: "no_change", changes: [], baseline: null };

/** 確度はコードが決める。公式はそのまま、2つのサイトで一致すれば corroborated、1つだけなら single */
function sourcesOf(pages: readonly RunPage[], checkedOn: string): CheckedSource[] {
  const hosts = new Set(pages.map((page) => new URL(page.url).hostname));
  return pages.map((page) => ({
    url: page.url,
    checkedAt: checkedOn,
    confidence:
      page.confidence === "official" ? "official" : hosts.size >= 2 ? "corroborated" : "single",
  }));
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
 * - 読んだページは、依頼にあり、実際に開いたものだけを数える
 * - 変化は、値がコードで読んだ新しい行に書いてあるときだけ認める。ページに書かれた指示で見回り係の
 *   報告が変わっても、指示に見える行は根拠にならないので通らない
 * - 開催の変更と中止は、公式か2つのサイトで確かめられたときだけ。足りなければ、値を持たない
 *   お知らせ（announcement）に落とし、くわしくは出典のページを開いてもらう
 */
export function checkFinding(input: {
  finding: PatrolFinding;
  target: RunTarget;
  baseline: ScheduleBaseline;
  evidence: readonly PageEvidence[];
  fetchedUrls: readonly string[];
  now: number;
}): FindingCheck {
  const { finding, target, baseline, evidence, fetchedUrls } = input;
  const nowDate = new Date(input.now);
  const checkedAt = nowInJapan(nowDate);
  const checkedOn = todayInJapan(nowDate);

  const unread = new Set(
    ungroundedSources(
      finding.pages.map((url) => ({ url })),
      fetchedUrls,
    ),
  );
  const requested = new Map(target.pages.map((page) => [comparableUrl(page.url), page]));
  const read = finding.pages.flatMap((url) => {
    const page = requested.get(comparableUrl(url));
    return page !== undefined && !unread.has(url) && checkPublicWebUrl(url).ok ? [page] : [];
  });
  if (read.length === 0) return REJECTED;
  if (finding.dateText !== null && isInstructionLine(finding.dateText)) return REJECTED;

  const evidenceOf = (page: RunPage) =>
    evidence.find((item) => comparableUrl(item.url) === comparableUrl(page.url));
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
    return REJECTED;
  }

  const announcements = (topics: readonly NoticeTopic[], pages: readonly RunPage[]) => {
    const marks = pages.flatMap((page) => {
      const item = evidenceOf(page);
      return item?.verifiable === true ? item.added.map(lineHash) : [page.url];
    });
    return topics.flatMap((topic) => {
      const change = checked(
        { kind: "announcement", festivalId: target.festivalId, date: target.date, topic },
        ["announcement", target.key, topic, [...marks].sort()],
        sourcesOf(pages, checkedOn),
        checkedAt,
      );
      return change === null ? [] : [change];
    });
  };
  const announced = (topics: readonly NoticeTopic[], pages: readonly RunPage[]): FindingCheck => {
    const changes = announcements(topics, pages);
    return changes.length === 0 ? NO_CHANGE : { outcome: "announcement", changes, baseline: null };
  };

  const claims = claimsOf(finding, baseline);
  const supportFor = (claim: Claim) =>
    verifiable.filter((page) =>
      (evidenceOf(page)?.added ?? []).some((line) => claimHolds(claim, line)),
    );
  const supported = claims.filter((claim) => supportFor(claim).length > 0);
  // お知らせは、読めるページなら新しい行があるときだけ、読めないページならそのまま受ける
  const topicPages = [
    ...verifiable.filter((page) => (evidenceOf(page)?.added.length ?? 0) > 0),
    ...unverifiable,
  ];

  if (supported.length === 0) {
    if (claims.length > 0 && unverifiable.length > 0) {
      // コードで読めないページの変化は確かめられないので、値を持たないお知らせにする
      return announced(finding.topics.length > 0 ? finding.topics : ["other"], unverifiable);
    }
    if (claims.length > 0) return REJECTED;
    return topicPages.length > 0 ? announced(finding.topics, topicPages) : NO_CHANGE;
  }

  const support = verifiable.filter((page) =>
    supported.some((claim) => supportFor(claim).includes(page)),
  );
  const sources = sourcesOf(support, checkedOn);
  const firm = sources.some(
    (source) => source.confidence === "official" || source.confidence === "corroborated",
  );
  if (!firm) return announced(finding.topics.length > 0 ? finding.topics : ["other"], support);

  if (supported.some((claim) => claim.kind === "cancelled")) {
    const change = checked(
      { kind: "cancellation", festivalId: target.festivalId, date: target.date },
      ["cancellation", target.key],
      sources,
      checkedAt,
    );
    return change === null
      ? REJECTED
      : { outcome: "cancellation", changes: [change], baseline: null };
  }

  const changes: FestivalChange[] = [];
  const next: ScheduleBaseline = { ...baseline };
  for (const claim of supported) {
    if (claim.kind === "date") {
      changes.push({ field: "date", before: baseline.date, after: claim.after });
      next.date = claim.after;
    } else if (claim.kind === "postponed") {
      changes.push({ field: "date", before: baseline.date, after: null });
    } else if (claim.kind === "time") {
      changes.push({ field: claim.field, before: baseline[claim.field], after: claim.after });
      next[claim.field] = claim.after;
    }
  }
  const content: NoticeContent = {
    kind: "schedule_change",
    festivalId: target.festivalId,
    date: target.date,
    changes,
  };
  const change = checked(content, content, sources, checkedAt);
  return change === null
    ? REJECTED
    : { outcome: "schedule_change", changes: [change], baseline: next };
}
