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
  hasScheduleSignal,
  lineHash,
  mentionsDate,
  mentionsTime,
  normalizeLine,
  saysCancelled,
  saysNotHeld,
  saysPostponed,
  saysWithdrawn,
  talksOnlyAboutPast,
} from "./lines";
import type { RunPage, RunTarget, ScheduleBaseline } from "./types";

// 検問。見回り係の報告は信用しない入力なので、形・URL・出典を確かめ、変化の種類はコードが決める。
// モデルの見立て（result）だけでは通知を作らない。値がコードで読んだ新しい行に書いてあることを確かめる。
// ページの文章は次へ渡さない。ここから出るのは、決まった形の値と出典だけ。
//
// 最も避けたいのは、本物の中止や変更を黙って失うこと。決まったと言い切れるものだけを開催の変更や中止にし、
// 新しい行に中止・延期・日時の語があるのに言い切れないものと、報告が中止や日付なしの変更と言っているのに
// ページの言葉で読み取れないものは、値を持たないお知らせにする。どちらでもないときだけ、黙って比べる元を進める。

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

/** いま分かっている状態 */
export interface KnownState {
  baseline: ScheduleBaseline;
  /** 検問を通って中止と決まっている */
  cancelled: boolean;
  /** 検問を通って、新しい日の分からない延期と決まっている */
  postponed: boolean;
  /** 中止を出したページ。分からなければ、読んだ確かなページで確かめる */
  cancelledBy?: readonly string[];
}

/** 報告が言っている変化。前回の値と比べてコードで決める。分からない値（null）は変化にしない */
function claimsOf(finding: PatrolFinding, known: KnownState): Claim[] {
  const claims: Claim[] = [];
  const { baseline } = known;
  if (finding.result === "cancelled" && !known.cancelled) claims.push({ kind: "cancelled" });
  const { date, start, end } = finding.observed;
  if (date !== null && date !== baseline.date) claims.push({ kind: "date", after: date });
  if (date === null && finding.result === "changed" && !known.postponed) {
    claims.push({ kind: "postponed" });
  }
  if (start !== null && start !== baseline.start) {
    claims.push({ kind: "time", field: "start", after: start });
  }
  if (end !== null && end !== baseline.end) claims.push({ kind: "time", field: "end", after: end });
  return claims;
}

function claimHolds(claim: Claim, evidence: PageEvidence, occurrence: string): boolean {
  const { added, lines } = evidence;
  const unchanged = lines.filter((line) => !added.includes(line));
  switch (claim.kind) {
    case "date":
      return (
        added.some((line) => announcesDate(line, claim.after)) ||
        // 新しい行で順延と言えていて、前から載っている予備日へ移るとき
        (added.some((line) => saysPostponed(line, occurrence)) &&
          unchanged.some((line) => mentionsDate(line, claim.after)))
      );
    case "time":
      return added.some((line) => announcesTime(line, claim.after));
    case "postponed":
      return added.some((line) => saysPostponed(line, occurrence));
    case "cancelled":
      return added.some((line) => saysCancelled(line, occurrence));
  }
}

/** 値が、変わっていない行にだけ書いてあるか（読むだけで変化と言っているとき） */
function valueOnUnchangedLine(claim: Claim, evidence: PageEvidence): boolean {
  const unchanged = evidence.lines.filter((line) => !evidence.added.includes(line));
  if (claim.kind === "date") return unchanged.some((line) => mentionsDate(line, claim.after));
  if (claim.kind === "time") return unchanged.some((line) => mentionsTime(line, claim.after));
  return false;
}

function fingerprintOf(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

const compact = (text: string) => text.replace(/\s+/g, "");

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
  /** 言っている値が読めるページのどこにもなく、新しい行に開催に関わる語もない */
  | "rejected"
  /** 新しい行に開催に関わる語があるが、公式でも確かでもないページだけなので知らせない */
  | "unconfirmed"
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
  /** 新しい延期の状態。変わらなければ null */
  postponed: boolean | null;
  /** 中止を出したページ。中止を認めたときだけ */
  cancelledBy: string[] | null;
  /** 写した文がページになかった（信用しないだけで、判定は止めない） */
  dateTextMismatch: boolean;
}

/** 1つの主張を支持するページの確度。公式か、別のサイトが2つそろうと確かとする */
function claimSources(
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

const uniquePages = (pages: readonly RunPage[]): RunPage[] =>
  pages.filter((page, index) => pages.indexOf(page) === index);

const isTrusted = (page: RunPage) =>
  page.confidence === "official" || page.confidence === "corroborated";

/**
 * 1つの対象の報告を確かめる。
 * - 読んだページは、依頼にあり、実際に開いたものだけを数える。1つもなければ not_read
 * - 変化は、値がコードで読んだ新しい行に書いてあるときだけ認める。指示に見える行は根拠にしない
 * - 開催の変更と中止は、主張ごとに、公式か2つのサイトで確かめられたときだけ。足りなければ値を持たないお知らせにする
 * - それ以外で新しい行に開催に関わる語があるか、報告が中止や日付なしの変更と言っていれば、
 *   公式か確かな出典のページなら、値を持たないお知らせにする
 * - 中止と知らせたあとは、確かなページに撤回と書いてあるか、中止を出したページから中止の言葉が消えたときだけ、
 *   中止の状態を戻し、撤回を知らせる。報告だけでは戻さない
 * - どれでもなければ通知にしない。ここだけが黙って比べる元を進める道になる
 */
export function checkFinding(input: {
  finding: PatrolFinding;
  target: RunTarget;
  known: KnownState;
  /** 同じ内容の変更を見分ける順番の値。日程が前の値に戻ったときに増える */
  sequence?: number;
  evidence: readonly PageEvidence[];
  fetchedUrls: readonly string[];
  now: number;
}): FindingCheck {
  const { finding, target, known, evidence, fetchedUrls } = input;
  const { baseline } = known;
  const sequence = input.sequence ?? 0;
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
  const verifiable = read.filter((page) => evidenceOf(page)?.verifiable === true);
  const unverifiable = read.filter((page) => evidenceOf(page)?.verifiable !== true);

  // 写した文は補助の項目なので、ページになくても信用しないだけで、判定は止めない
  const dateTextMismatch =
    finding.dateText !== null &&
    verifiable.length > 0 &&
    unverifiable.length === 0 &&
    !verifiable.some((page) =>
      compact((evidenceOf(page)?.lines ?? []).join("")).includes(
        compact(normalizeLine(finding.dateText ?? "")),
      ),
    );

  const result = (
    outcome: FindingOutcome,
    changes: CheckedChange[] = [],
    extra: Partial<FindingCheck> = {},
  ): FindingCheck => ({
    outcome,
    changes,
    readUrls: read.map((page) => page.url),
    baseline: null,
    cancelled: null,
    postponed: null,
    cancelledBy: null,
    dateTextMismatch,
    ...extra,
  });
  if (read.length === 0) return result("not_read");

  const addedOf = (page: RunPage) => evidenceOf(page)?.added ?? [];
  const claims = claimsOf(finding, known);

  /**
   * 値を持たないお知らせ。出典の確度はページごとに決め、別々の話を合わせて上げない。
   * 指紋は、種類とページと、知らせる理由（reason）から作る。お知らせは値を持たないので、
   * 見立てが揺れても、関係のない行が増えただけでも変わらず、読んだお知らせが未読に戻らない
   */
  const announcements = (
    topics: readonly NoticeTopic[],
    pages: readonly RunPage[],
    reason: unknown = [],
  ) => {
    const urls = pages.map((page) => page.url).sort();
    const sources = pages.map((page) => ({
      url: page.url,
      checkedAt: checkedOn,
      confidence: page.confidence === "official" ? ("official" as const) : ("single" as const),
    }));
    return topics.flatMap((topic) => {
      const change = checked(
        { kind: "announcement", festivalId: target.festivalId, date: target.date, topic },
        ["announcement", target.key, topic, urls, reason],
        sources,
        checkedAt,
      );
      return change === null ? [] : [change];
    });
  };
  const topicsOr = (fallback: NoticeTopic): readonly NoticeTopic[] =>
    finding.topics.length > 0 ? finding.topics : [fallback];

  // 主張を、確かなもの・確かでないもの・確かめられないもの・根拠のないものに分ける
  const firmClaims: { claim: Claim; pages: RunPage[]; sources: CheckedSource[] }[] = [];
  const weakPages: RunPage[] = [];
  let unknown = false;
  let unsupported = false;
  for (const claim of claims) {
    const pages = verifiable.filter((page) => {
      const item = evidenceOf(page);
      return item !== undefined && claimHolds(claim, item, target.date);
    });
    if (pages.length > 0) {
      const { sources, firm } = claimSources(pages, checkedOn);
      if (firm) firmClaims.push({ claim, pages, sources });
      else weakPages.push(...pages);
      continue;
    }
    if (claim.kind === "time" && baseline[claim.field] === null) continue;
    if (unverifiable.length > 0) {
      unknown = true;
      continue;
    }
    const stale = verifiable.some((page) => {
      const item = evidenceOf(page);
      return item !== undefined && valueOnUnchangedLine(claim, item);
    });
    if (!stale) unsupported = true;
  }

  const changes: CheckedChange[] = [];
  const state: Pick<FindingCheck, "baseline" | "cancelled" | "postponed" | "cancelledBy"> = {
    baseline: null,
    cancelled: null,
    postponed: null,
    cancelledBy: null,
  };
  const cancellation = firmClaims.find(({ claim }) => claim.kind === "cancelled");
  if (cancellation !== undefined) {
    const change = checked(
      { kind: "cancellation", festivalId: target.festivalId, date: target.date },
      ["cancellation", target.key, baseline.date, sequence],
      cancellation.sources,
      checkedAt,
    );
    if (change !== null) {
      changes.push(change);
      state.cancelled = true;
      state.cancelledBy = cancellation.pages.map((page) => page.url);
    }
  } else if (firmClaims.length > 0) {
    const list: FestivalChange[] = [];
    const next: ScheduleBaseline = { ...baseline };
    let postponed: boolean | null = null;
    for (const { claim } of firmClaims) {
      if (claim.kind === "date") {
        list.push({ field: "date", before: baseline.date, after: claim.after });
        next.date = claim.after;
        postponed = false;
      } else if (claim.kind === "postponed") {
        list.push({ field: "date", before: baseline.date, after: null });
        postponed = true;
      } else if (claim.kind === "time") {
        list.push({ field: claim.field, before: baseline[claim.field], after: claim.after });
        next[claim.field] = claim.after;
      }
    }
    const content: NoticeContent = {
      kind: "schedule_change",
      festivalId: target.festivalId,
      date: target.date,
      changes: list,
    };
    const sources = firmClaims
      .flatMap((item) => item.sources)
      .filter((source, index, all) => all.findIndex((one) => one.url === source.url) === index);
    const change = checked(content, [content, sequence], sources, checkedAt);
    if (change !== null) {
      changes.push(change);
      state.baseline = next;
      state.postponed = postponed;
      // 開催が動いたので、前の日の中止は持ち越さない
      state.cancelled = false;
    }
  }
  const firm = changes.length > 0;

  // 値を確かめた主張や、コードで読めないページの主張は、主張そのものが知らせる理由になる
  if (weakPages.length > 0) {
    changes.push(...announcements(topicsOr("other"), uniquePages(weakPages), claims));
  }
  if (unknown) changes.push(...announcements(topicsOr("other"), unverifiable, claims));

  if (firm) {
    return result(cancellation !== undefined ? "cancellation" : "schedule_change", changes, state);
  }

  // 報告は信用しない入力なので、「予定どおり」だけでは中止の状態を戻さない。コードで読んだ行で確かめる。
  // 新しい行に撤回と書いてあるか、中止を出したページからも読んだページからも、中止の言葉が消えたときだけ戻す
  if (known.cancelled && finding.result === "as_planned") {
    const trustedPages = verifiable.filter(isTrusted);
    const linesOf = (page: RunPage) => evidenceOf(page)?.lines ?? [];
    const notHeld = verifiable.some((page) =>
      linesOf(page).some((line) => saysNotHeld(line, target.date)),
    );
    const isSource = (page: RunPage) =>
      known.cancelledBy === undefined ||
      known.cancelledBy.some((url) => comparableUrl(url) === comparableUrl(page.url));
    const pages = trustedPages.filter(
      (page) => addedOf(page).some(saysWithdrawn) || (!notHeld && isSource(page)),
    );
    if (pages.length > 0) {
      changes.push(
        ...announcements(topicsOr("other"), pages, ["withdrawn", baseline.date, sequence]),
      );
      return result("announcement", changes, { cancelled: false });
    }
  }
  if (changes.length > 0) return result("announcement", changes);

  // 主張で決まらなかった。新しい行に開催に関わる語があれば、黙って捨てない
  const signalKnown = {
    occurrence: target.date,
    date: baseline.date,
    start: baseline.start,
    end: baseline.end,
    cancelled: known.cancelled,
    postponed: known.postponed || baseline.date !== target.date,
  };
  // 「予定どおり」の報告では、日付や時刻だけの行で知らせない（更新の記録や別の案内がほとんどのため）
  const wordsOnly = finding.result === "as_planned";
  const signalLines = (page: RunPage) =>
    addedOf(page).filter((line) => hasScheduleSignal(line, signalKnown, { wordsOnly }));
  // 中止や日付なしの変更の報告は、言い回しを読み取れなくても捨てない。言い換えは尽きないため
  const reportsChange = claims.some(
    (claim) => claim.kind === "cancelled" || claim.kind === "postponed",
  );
  const signalPages = verifiable.filter(
    (page) =>
      signalLines(page).length > 0 ||
      (evidenceOf(page)?.suspiciousSchedule ?? 0) > 0 ||
      (reportsChange && addedOf(page).some((line) => !talksOnlyAboutPast(line, target.date))),
  );
  const trusted = signalPages.filter(isTrusted);
  if (trusted.length > 0) {
    const reason = trusted.flatMap((page) => signalLines(page).map(lineHash)).sort();
    return result("announcement", announcements(topicsOr("other"), trusted, reason));
  }

  // お知らせは、読めるページなら新しい行があるときだけ、読めないページならそのまま受ける
  const topicPages = [...verifiable.filter((page) => addedOf(page).length > 0), ...unverifiable];
  if (finding.topics.length > 0 && topicPages.length > 0) {
    return result("announcement", announcements(finding.topics, topicPages));
  }
  if (signalPages.length > 0) return result("unconfirmed");
  return result(unsupported ? "rejected" : "no_change");
}
