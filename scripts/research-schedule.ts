// 週ごとに調べる祭りを選ぶ規則と、調べた結果から調査の台帳（フラグ）を更新する規則。
// ファイルの読み込みも調査もしない（呼ぶ側が渡す）ので、テストではファイルなしで使える。
import {
  type Festival,
  type IsoDate,
  isOccurrenceConfirmed,
  type ResearchLedger,
  type ResearchResult,
} from "../packages/schema/src";
import type { RefreshRequest } from "./festival-refresh";
import { daysBetween } from "./festival-validation";

/** 開催まで何日以内なら、まだ調べていない祭りを必ず調べるか */
export const MUST_RESEARCH_WITHIN_DAYS = 14;
/** 週に調べる最低の件数。待ちのフラグのほうを優先するので、対象が足りなければ下回る */
export const MINIMUM_WEEKLY_TARGETS = 20;
/** 最低の件数を満たすために、どこまで先の祭りを足すか */
export const FILL_LOOKAHEAD_DAYS = 120;
/** 見つからなかったときに、次に調べる節目（開催の何日前か）。長いものから並べる */
export const RESEARCH_CHECKPOINT_DAYS = [30, 14, 7] as const;
/** 続けて何回失敗したら、翌週に調べ直すのをやめて節目を進めるか */
export const MAX_CONSECUTIVE_FAILURES = 2;
const RETRY_AFTER_DAYS = 7;

export const EMPTY_RESEARCH_LEDGER: ResearchLedger = { festivals: {}, officialNotFound: [] };

/**
 * 調べる理由。
 * request 掲載・訂正・掲載停止の依頼や、接客中に見つかった公式情報との食い違い /
 * due_soon 開催が近く、まだ調べていない / checkpoint 前は確かめられず、次の節目が来た /
 * retry 前回は最後まで調べられなかった / fill 最低の件数を満たすために足した
 */
export const REFRESH_REASONS = ["request", "due_soon", "checkpoint", "retry", "fill"] as const;
export type RefreshReason = (typeof REFRESH_REASONS)[number];

export interface RefreshTarget {
  id: string;
  reasons: RefreshReason[];
  /** 調べる開催回の初日。データに次の開催回がなければ、前回の1年後の仮の日付 */
  nextDate: IsoDate;
  /** 調べる人に渡す手がかり（依頼の種類、仮の日付であることなど） */
  notes: string[];
}

export interface SelectOptions {
  today: IsoDate;
  ledger?: ResearchLedger;
  requests?: readonly RefreshRequest[];
  /** 確認待ちの PR にある祭り。マージか却下で結果が決まるまで調べない */
  underReview?: readonly string[];
  minimum?: number;
  lookaheadDays?: number;
}

type Occurrence = Festival["occurrences"][number];

/** いま調べる開催回。data にこれから先の回がなければ occurrence は null で、日付は前回の1年後 */
export interface CurrentOccurrence {
  date: IsoDate;
  endDate: IsoDate;
  occurrence: Occurrence | null;
}

export function currentOccurrence(festival: Festival, today: IsoDate): CurrentOccurrence {
  const sorted = [...festival.occurrences].sort((a, b) => (a.date < b.date ? -1 : 1));
  let date = "";
  let endDate = "";
  for (const occurrence of sorted) {
    date = occurrence.date;
    endDate = occurrence.endDate ?? occurrence.date;
    if (endDate >= today) return { date, endDate, occurrence };
  }
  while (endDate < today) {
    date = nextYear(date);
    endDate = nextYear(endDate);
  }
  return { date, endDate, occurrence: null };
}

/** 開催が確定しているか、中止と決まっていて、開催が終わるまで調べなくてよいか */
function isSettled(occurrence: Occurrence): boolean {
  return occurrence.status === "cancelled" || isOccurrenceConfirmed(occurrence);
}

function scheduleReason(
  festival: Festival,
  current: CurrentOccurrence,
  ledger: ResearchLedger,
  today: IsoDate,
  lookaheadDays: number,
): RefreshReason | null {
  if (current.occurrence !== null && isSettled(current.occurrence)) return null;
  const days = daysBetween(today, current.date);
  if (days < 0) return null;
  const entry = ledger.festivals[festival.id];
  // 別の開催回の記録は使わない（開催が終わった、日付が直された）
  if (entry !== undefined && entry.occurrenceDate === current.date) {
    if (entry.nextResearchOn === null || today < entry.nextResearchOn) return null;
    return entry.result === "failed" ? "retry" : "checkpoint";
  }
  if (days <= MUST_RESEARCH_WITHIN_DAYS) return "due_soon";
  return days <= lookaheadDays ? "fill" : null;
}

/**
 * 今週調べる祭りを選ぶ。開催の近いものと節目の来たものは件数の上限なしで全部選び、
 * 最低の件数に満たなければ、まだ調べていない祭りを近い順に足す。対象がなければ空を返す。
 * 掲載停止の祭りと確認待ちの PR にある祭りは、どの理由があっても選ばない。
 * 依頼のある祭りは、確定済みや待ちのフラグがあっても選ぶ。
 */
export function selectRefreshTargets(
  festivals: readonly Festival[],
  {
    today,
    ledger = EMPTY_RESEARCH_LEDGER,
    requests = [],
    underReview = [],
    minimum = MINIMUM_WEEKLY_TARGETS,
    lookaheadDays = FILL_LOOKAHEAD_DAYS,
  }: SelectOptions,
): RefreshTarget[] {
  const reviewing = new Set(underReview);
  const must: RefreshTarget[] = [];
  const fill: RefreshTarget[] = [];
  for (const festival of festivals) {
    if (festival.optOut || reviewing.has(festival.id)) continue;
    const current = currentOccurrence(festival, today);
    const reason = scheduleReason(festival, current, ledger, today, lookaheadDays);
    const asked = requests.filter((request) => request.festivalId === festival.id);
    if (reason === null && asked.length === 0) continue;

    const reasons = new Set<RefreshReason>(asked.length > 0 ? ["request"] : []);
    if (reason !== null) reasons.add(reason);
    const target: RefreshTarget = {
      id: festival.id,
      reasons: REFRESH_REASONS.filter((name) => reasons.has(name)),
      nextDate: current.date,
      notes: [
        ...asked.map((request) => `依頼：${REQUEST_LABELS[request.kind]}`),
        ...(current.occurrence === null
          ? [`次の開催回がデータにありません。${current.date} は前回の1年後の仮の日付です`]
          : []),
      ],
    };
    (reason === "fill" && asked.length === 0 ? fill : must).push(target);
  }
  const room = Math.max(0, minimum - must.length);
  return [...must, ...fill.sort(compareTargets).slice(0, room)].sort(compareTargets);
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
  if (a.nextDate !== b.nextDate) return a.nextDate < b.nextDate ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 調べた結果から台帳を更新する

/** 残りの日数より短い、次の節目の日。なければ null（この開催回はこれ以上調べない） */
export function nextCheckpointOn(occurrenceDate: IsoDate, today: IsoDate): IsoDate | null {
  const days = daysBetween(today, occurrenceDate);
  const gate = RESEARCH_CHECKPOINT_DAYS.find((checkpoint) => checkpoint < days);
  return gate === undefined ? null : addDays(occurrenceDate, -gate);
}

export interface ResearchOutcome {
  festivalId: string;
  occurrenceDate: IsoDate;
  result: ResearchResult;
  today: IsoDate;
}

/**
 * 調べた結果を台帳に書く。確定かどうかはデータの開催回で決まるので、found でも次の節目を残す
 * （確認待ちの PR が却下されたら、節目からまた調べられる）。失敗は節目を進めず翌週に調べ直す
 */
export function recordResearchResult(
  ledger: ResearchLedger,
  { festivalId, occurrenceDate, result, today }: ResearchOutcome,
): ResearchLedger {
  const previous = ledger.festivals[festivalId];
  const sameOccurrence = previous?.occurrenceDate === occurrenceDate;
  const failures = result === "failed" ? (sameOccurrence ? previous.failures : 0) + 1 : 0;
  let nextResearchOn = nextCheckpointOn(occurrenceDate, today);
  if (result === "failed" && failures < MAX_CONSECUTIVE_FAILURES) {
    const retryOn = addDays(today, RETRY_AFTER_DAYS);
    nextResearchOn = retryOn <= occurrenceDate ? retryOn : null;
  }
  return {
    ...ledger,
    festivals: {
      ...ledger.festivals,
      [festivalId]: { occurrenceDate, lastResearchedAt: today, result, nextResearchOn, failures },
    },
  };
}

/**
 * 開催が終わった回の記録を外す。確定しないまま終わった回は「公式情報が見つからなかった」記録に移す。
 * 日付が直された回（同じ年に別の開催回がある）とデータから消えた祭りは、記録に移さず外すだけにする
 */
export function retireEndedOccurrences(
  festivals: readonly Festival[],
  ledger: ResearchLedger,
  today: IsoDate,
): ResearchLedger {
  const byId = new Map(festivals.map((festival) => [festival.id, festival]));
  const kept: ResearchLedger["festivals"] = {};
  const officialNotFound = [...ledger.officialNotFound];
  for (const [festivalId, entry] of Object.entries(ledger.festivals)) {
    const festival = byId.get(festivalId);
    if (festival === undefined) continue;
    const { occurrenceDate, lastResearchedAt } = entry;
    const occurrence = festival.occurrences.find((o) => o.date === occurrenceDate);
    if ((occurrence?.endDate ?? occurrenceDate) >= today) {
      kept[festivalId] = entry;
      continue;
    }
    const year = occurrenceDate.slice(0, 4);
    const unconfirmed =
      occurrence === undefined
        ? !festival.occurrences.some((o) => o.date.startsWith(year))
        : !isSettled(occurrence);
    const recorded = officialNotFound.some(
      (item) => item.festivalId === festivalId && item.occurrenceDate === occurrenceDate,
    );
    if (unconfirmed && !recorded) {
      officialNotFound.push({ festivalId, occurrenceDate, lastResearchedAt });
    }
  }
  return { festivals: kept, officialNotFound };
}

/** 差分が読みやすいよう、祭りの ID と開催日の順に並べて書き出す */
export function serializeResearchLedger(ledger: ResearchLedger): string {
  const festivals = Object.fromEntries(
    Object.entries(ledger.festivals).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  const officialNotFound = [...ledger.officialNotFound].sort(
    (a, b) =>
      a.festivalId.localeCompare(b.festivalId) || a.occurrenceDate.localeCompare(b.occurrenceDate),
  );
  return `${JSON.stringify({ festivals, officialNotFound }, null, 2)}\n`;
}

function addDays(date: IsoDate, days: number): IsoDate {
  return new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);
}

function nextYear(date: IsoDate): IsoDate {
  const [year, month, day] = date.split("-");
  // 2月29日は、次の年には2月28日にする
  const sameDay = month === "02" && day === "29" ? "28" : day;
  return `${Number(year) + 1}-${month}-${sameDay}`;
}
