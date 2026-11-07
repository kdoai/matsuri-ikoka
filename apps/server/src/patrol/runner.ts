import { randomUUID } from "node:crypto";
import { backoffMs, comparableUrl } from "@matsuri-ikoka/agent-kit";
import type { CheckedChange, PatrolPage, PatrolTarget } from "@matsuri-ikoka/schema";
import type { FestivalStore } from "../data/festivalStore";
import { daysBetween, nowInJapan, todayInJapan } from "../domain/calendar";
import { errorForLog } from "../log";
import type { LodgingService } from "../tools/lodging";
import type { PatrolAgent, PatrolSessionState } from "./agent";
import { checkFinding, type PageEvidence, parsePatrolReport } from "./checkpoint";
import type { PatrolConfig } from "./config";
import {
  changedLinesForAgent,
  diffLines,
  isInstructionLine,
  lineHashes,
  needsAgent,
} from "./lines";
import { checkTripLodging, type LodgingBudget } from "./lodging";
import { noticeExpiresAt, noticeFor } from "./notices";
import type { PageFetcher } from "./pageFetcher";
import { buildPatrolRequest, newPatrolId } from "./request";
import type { PatrolStore } from "./store";
import { type PatrolPlan, planTargets, type WatchedItinerary } from "./targets";
import type { PatrolPageRecord, PatrolRecord, PatrolRun, RunTarget } from "./types";

// 見回りの本体。
// 起動：頼まれた旅から対象を作り、コードがページを読んで前回と比べる。変わらなければモデルを呼ばない。
//       変わったページとコードで読めないページだけを、祭りごとにまとめて見回り係に渡す。
// 結果：終わったセッションの報告を検問に通し、確かな変化だけを、該当する旅の通知にする。
//       比べる元を進めるのは、実際に開いたと確かめられたページだけ。
// 祭りごとの作業には実行権を持たせる。起動が2回届いても同じ作業を二重に走らせず、止まった作業は別の実行が引き継ぐ。

/** 実行権の長さ。作業中はページを読むごとに延ばす */
const LEASE_TTL_MS = 5 * 60 * 1000;
/** 起動が新しい対象に取りかかってよい時間。Cloud Run の 300 秒より十分短くする */
const TICK_DEADLINE_MS = 180 * 1000;
/** 読めないページと、読まないページを見に行く間隔 */
const QUIET_PAGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 失敗が続いたときに空ける間隔の上限 */
const MAX_BACKOFF_MS = 7 * 24 * 60 * 60 * 1000;
/** 原因の対象が分からない失敗で空ける間隔の上限 */
const MAX_GROUP_BACKOFF_MS = 24 * 60 * 60 * 1000;
/** 開催がこの日数より近い対象は、空ける時間を短くする */
const SOON_DAYS = 3;
const NEAR_DAYS = 14;
const NEAR_BACKOFF_MS = 24 * 60 * 60 * 1000;
/** Webhook が届かなかったときに、定期の起動で結果を取りに行くまでの時間 */
const RECONCILE_AFTER_MS = 15 * 60 * 1000;
/** セッションができるまで対象を押さえておく時間。途中で止まっても、すぐに次の起動が引き継ぐ */
const PENDING_START_TTL_MS = 10 * 60 * 1000;
/** 結果を待つ時間の上限。超えたら失敗として、次の回に調べ直す */
const RUN_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** 実行の記録を残す期間 */
const RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** 配信の受け取りの印を残す期間 */
const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DELIVERY_TTL_MS = 5 * 60 * 1000;
const MAX_WATCHED_TRIPS = 2_000;
const MAX_RECORD_KEYS = 2_000;
const MAX_OPEN_RUNS = 10;

export interface PatrolDeps {
  store: PatrolStore;
  /** 見回り係。設定がなければ、見回りの入口ごと用意しない */
  agent: PatrolAgent;
  pages: PageFetcher;
  festivals: FestivalStore;
  lodging: LodgingService;
  config: Pick<
    PatrolConfig,
    "sessionBudgetCents" | "maxTargetsPerRun" | "maxLodgingChecksPerRun" | "checkIntervalMs"
  >;
  now: () => number;
  /** 間隔のずらし方（テストで決める） */
  random?: () => number;
}

export interface PatrolTickResult {
  /** 受け付けた対象の数（コードで調べた数） */
  targets: number;
  /** 見回り係に渡した対象の数 */
  sentToAgent: number;
  /** ほかの実行が動いている、結果を待っている、調べる時期でないので飛ばした数 */
  skipped: number;
  /** 宿の空きの変化から作った通知の数 */
  lodgingNotices: number;
  /** 定期の起動で受け取った、Webhook が届かなかった結果の数 */
  reconciled: number;
}

function log(kind: string, fields: object): void {
  console.log(JSON.stringify({ kind, ...fields }));
}

async function loadWatched(deps: PatrolDeps): Promise<{
  watched: WatchedItinerary[];
  complete: boolean;
}> {
  const trips = await deps.store.listWatchedTrips(MAX_WATCHED_TRIPS);
  const entries = await Promise.all(
    trips.map(async (trip) => ({ trip, itinerary: await deps.store.readItinerary(trip) })),
  );
  return {
    watched: entries.flatMap(({ trip, itinerary }) =>
      itinerary === null ? [] : [{ trip, itinerary }],
    ),
    complete: trips.length < MAX_WATCHED_TRIPS,
  };
}

function pageRecord(record: PatrolRecord, url: string): PatrolPageRecord {
  const existing = record.pages.find((page) => page.url === url);
  if (existing !== undefined) return existing;
  const page: PatrolPageRecord = {
    url,
    lineHashes: null,
    pendingHashes: null,
    failures: 0,
    nextTryAt: 0,
  };
  record.pages.push(page);
  return page;
}

/** 空ける時間の上限。開催が近い対象は長く空けない */
function backoffCap(deps: PatrolDeps, date: string): number {
  const days = daysBetween(todayInJapan(new Date(deps.now())), date);
  if (days <= SOON_DAYS) return deps.config.checkIntervalMs;
  return days <= NEAR_DAYS ? NEAR_BACKOFF_MS : MAX_BACKOFF_MS;
}

function failureDelay(deps: PatrolDeps, failures: number, date: string, cap = MAX_BACKOFF_MS) {
  return backoffMs(failures, {
    baseMs: deps.config.checkIntervalMs,
    maxMs: Math.min(cap, backoffCap(deps, date)),
    ...(deps.random === undefined ? {} : { random: deps.random }),
  });
}

interface DeliveryResult {
  created: number;
  /** 上限に達して届けられなかった旅の数 */
  full: number;
}

/** 通知を足す。同じ変化は同じ ID なので、2度は届かない */
async function deliver(
  deps: PatrolDeps,
  change: CheckedChange,
  festivalName: string,
  entries: readonly WatchedItinerary[],
): Promise<DeliveryResult> {
  const delivery: DeliveryResult = { created: 0, full: 0 };
  for (const { trip, itinerary } of entries) {
    const notice = noticeFor({
      change,
      tripId: trip.watch.tripId,
      itinerary,
      festivalName,
      now: deps.now(),
    });
    const result = await deps.store.addNotice(trip, notice, noticeExpiresAt(itinerary));
    if (result === "created" || result === "replaced") delivery.created += 1;
    if (result === "full") delivery.full += 1;
  }
  if (delivery.full > 0) log("patrol_notices_full", { kind_of: change.content.kind });
  return delivery;
}

/** 同じ順で枠を使うと後ろの旅がいつまでも調べられないので、起動ごとに始まりをずらす */
function rotated<T>(items: readonly T[], seed: number): T[] {
  if (items.length === 0) return [];
  const start = seed % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

/** 宿の空きを調べ、変化を旅の通知にする。失敗しても祭りの見回りは止めない */
async function checkLodging(
  deps: PatrolDeps,
  plan: PatrolPlan,
  budget: LodgingBudget,
): Promise<number> {
  const venue = deps.festivals.get(plan.festivalId)?.venue;
  const near = venue === undefined ? null : { lat: venue.lat, lng: venue.lng };
  const seed = Math.floor(deps.now() / deps.config.checkIntervalMs);
  let created = 0;
  for (const entry of rotated(plan.trips, seed)) {
    if (!entry.itinerary.days.some((day) => day.stay?.lodging !== undefined)) continue;
    try {
      const notices = await deps.store.listNotices(entry.trip);
      const changes = await checkTripLodging({
        itinerary: entry.itinerary,
        lodging: deps.lodging,
        venue: near,
        notices,
        now: deps.now(),
        budget,
        signal: AbortSignal.timeout(30_000),
      });
      for (const change of changes) {
        created += (await deliver(deps, change, plan.festivalName, [entry])).created;
      }
    } catch (error) {
      log("patrol_lodging_failed", errorForLog(error));
    }
  }
  return created;
}

type TargetResult =
  | { kind: "skipped" }
  | { kind: "checked"; target: PatrolTarget | null; run: RunTarget | null; lodging: number };

/** 1つの対象をコードで調べる。モデルは呼ばない。見回り係に渡すものがあれば返す */
async function checkTarget(
  deps: PatrolDeps,
  plan: PatrolPlan,
  holder: string,
  patrolId: string,
  lodgingBudget: LodgingBudget,
): Promise<TargetResult> {
  const seed = { festivalId: plan.festivalId, date: plan.date };
  const record = await deps.store.acquireLease(plan.key, seed, holder, deps.now(), LEASE_TTL_MS);
  if (record === null) return { kind: "skipped" };
  const release = () => deps.store.saveRecord(plan.key, holder, { ...record, lease: null });
  const unfinished = record.pending !== null;
  if (record.pending !== null && record.pending.until > deps.now()) {
    await release();
    return { kind: "skipped" };
  }
  // 期限が切れた待ちは、前の実行が途中で止まったもの。待たずに調べ直す
  record.pending = null;
  for (const page of record.pages) page.pendingHashes = null;
  if (!unfinished && record.nextCheckAt > deps.now()) {
    await release();
    return { kind: "skipped" };
  }

  const pages: PatrolPage[] = [];
  const runPages: RunTarget["pages"] = [];
  for (const planned of plan.pages) {
    if (!(await deps.store.renewLease(plan.key, holder, deps.now(), LEASE_TTL_MS))) {
      log("patrol_lease_lost", { festivalId: plan.festivalId });
      return { kind: "skipped" };
    }
    const page = pageRecord(record, planned.url);
    if (page.nextTryAt > deps.now()) continue;
    const read = await deps.pages.read(planned.url);
    if (read.status === "ok") {
      page.failures = 0;
      page.nextTryAt = 0;
      const hashes = lineHashes(read.lines);
      if (page.lineHashes === null) {
        // はじめて読めたページは、比べる元を残すだけにする
        page.lineHashes = hashes;
        continue;
      }
      const diff = diffLines(page.lineHashes, read.lines);
      if (diff.suspicious > 0) {
        log("patrol_suspicious_lines", { festivalId: plan.festivalId, lines: diff.suspicious });
      }
      if (!needsAgent(diff)) {
        page.lineHashes = hashes;
        continue;
      }
      page.pendingHashes = hashes;
      pages.push({ url: planned.url, reason: "changed", changedLines: changedLinesForAgent(diff) });
      runPages.push({ url: planned.url, reason: "changed", confidence: planned.confidence });
    } else if (read.status === "unreadable") {
      page.failures = 0;
      page.nextTryAt = deps.now() + QUIET_PAGE_INTERVAL_MS;
      pages.push({ url: planned.url, reason: "unreadable", changedLines: [] });
      runPages.push({ url: planned.url, reason: "unreadable", confidence: planned.confidence });
    } else if (read.status === "blocked") {
      page.nextTryAt = deps.now() + QUIET_PAGE_INTERVAL_MS;
    } else {
      page.failures += 1;
      page.nextTryAt = deps.now() + failureDelay(deps, page.failures, plan.date);
      log("patrol_page_failed", { festivalId: plan.festivalId, failures: page.failures });
    }
  }

  const lodging = await checkLodging(deps, plan, lodgingBudget);
  if (!(await deps.store.renewLease(plan.key, holder, deps.now(), LEASE_TTL_MS))) {
    log("patrol_lease_lost", { festivalId: plan.festivalId });
    return { kind: "skipped" };
  }

  const now = deps.now();
  record.lastCheckedAt = now;
  record.nextCheckAt = now + deps.config.checkIntervalMs;
  const send = pages.length > 0;
  // セッションができるまでは短く押さえる。途中で止まっても長く待たせない
  record.pending = send ? { patrolId, until: now + PENDING_START_TTL_MS } : null;
  const saved = await deps.store.saveRecord(plan.key, holder, { ...record, lease: null });
  if (!saved) {
    log("patrol_lease_lost", { festivalId: plan.festivalId });
    return { kind: "skipped" };
  }
  if (!send) return { kind: "checked", target: null, run: null, lodging };
  return {
    kind: "checked",
    target: {
      festivalId: plan.festivalId,
      festivalName: plan.festivalName,
      date: plan.date,
      pages,
    },
    run: { key: plan.key, festivalId: plan.festivalId, date: plan.date, pages: runPages },
    lodging,
  };
}

/** 見回りが失敗した対象：比べる元を変えず、間隔を空けて調べ直す */
function settleFailure(
  deps: PatrolDeps,
  record: PatrolRecord,
  cause: "target" | "group",
): PatrolRecord {
  const base = {
    ...record,
    pages: record.pages.map((page) => ({ ...page, pendingHashes: null })),
    pending: null,
    lease: null,
  };
  if (cause === "target") {
    const failures = record.failures + 1;
    return {
      ...base,
      failures,
      nextCheckAt: deps.now() + failureDelay(deps, failures, record.date),
    };
  }
  // 束ねた全部の失敗。原因の対象が分からないので、この対象の失敗には数えず、長くは空けない
  const groupFailures = record.groupFailures + 1;
  return {
    ...base,
    groupFailures,
    nextCheckAt: deps.now() + failureDelay(deps, groupFailures, record.date, MAX_GROUP_BACKOFF_MS),
  };
}

/** 検問のために、報告が読んだと言うページをコードで読み直す。ページの文章はこの関数の外に残さない */
async function readEvidence(
  deps: PatrolDeps,
  target: RunTarget,
  record: PatrolRecord,
  readByAgent: readonly string[],
): Promise<PageEvidence[]> {
  const claimed = new Set(readByAgent.map(comparableUrl));
  const pages = target.pages.filter((page) => claimed.has(comparableUrl(page.url)));
  return Promise.all(
    pages.map(async ({ url, reason }): Promise<PageEvidence> => {
      const none = {
        url,
        verifiable: false,
        transient: false,
        added: [],
        lines: [],
        suspiciousSchedule: 0,
      };
      const previous = record.pages.find(
        (page) => comparableUrl(page.url) === comparableUrl(url),
      )?.lineHashes;
      if (reason !== "changed" || previous === null || previous === undefined) return none;
      const read = await deps.pages.read(url);
      if (read.status === "failed") return { ...none, transient: true };
      if (read.status !== "ok") return none;
      const diff = diffLines(previous, read.lines);
      return {
        url,
        verifiable: true,
        transient: false,
        added: diff.added,
        lines: read.lines.filter((line) => !isInstructionLine(line)),
        suspiciousSchedule: diff.suspiciousSchedule,
      };
    }),
  );
}

async function settleTargets(
  deps: PatrolDeps,
  run: PatrolRun,
  holder: string,
  settle: (target: RunTarget, record: PatrolRecord) => Promise<PatrolRecord>,
): Promise<boolean> {
  let finished = true;
  for (const target of run.targets) {
    const seed = { festivalId: target.festivalId, date: target.date };
    const record = await deps.store.acquireLease(
      target.key,
      seed,
      holder,
      deps.now(),
      LEASE_TTL_MS,
    );
    if (record === null) {
      // ほかの実行が調べている途中。次の定期の起動で受け取り直す
      finished = false;
      continue;
    }
    const next =
      record.pending?.patrolId === run.patrolId
        ? await settle(target, record)
        : { ...record, lease: null };
    await deps.store.saveRecord(target.key, holder, next);
  }
  return finished;
}

/** 報告を検問に通し、確かな変化を該当する旅の通知にする */
async function acceptReport(
  deps: PatrolDeps,
  run: PatrolRun,
  holder: string,
  state: Extract<PatrolSessionState, { state: "finished" }>,
): Promise<{ finished: boolean; failure: string | null; counts: Record<string, number> }> {
  const counts: Record<string, number> = {};
  const count = (name: string, by = 1) => {
    counts[name] = (counts[name] ?? 0) + by;
  };
  const parsed =
    state.text === null
      ? ({ ok: false, reason: "unreadable" } as const)
      : parsePatrolReport(state.text, run.patrolId);
  if (!parsed.ok) {
    log("patrol_report_rejected", { reason: parsed.reason });
    const finished = await settleTargets(deps, run, holder, async (_target, record) =>
      settleFailure(deps, record, "group"),
    );
    return { finished, failure: `report_${parsed.reason}`, counts };
  }

  let plans: PatrolPlan[] | null = null;
  const finished = await settleTargets(deps, run, holder, async (target, record) => {
    const finding = parsed.report.findings.find(
      (item) => item.festivalId === target.festivalId && item.date === target.date,
    );
    if (finding === undefined) {
      count("no_finding");
      return settleFailure(deps, record, "target");
    }
    const occurrence = deps.festivals
      .get(target.festivalId)
      ?.occurrences.find((item) => item.date === target.date);
    const baseline = record.observed ?? {
      date: target.date,
      start: occurrence?.start ?? null,
      end: occurrence?.end ?? null,
    };
    const check = checkFinding({
      finding,
      target,
      baseline,
      cancelled: record.cancelled,
      changeCount: record.changeCount,
      evidence: await readEvidence(deps, target, record, finding.pages),
      fetchedUrls: state.fetchedUrls,
      now: deps.now(),
    });
    count(check.outcome);
    if (check.outcome === "not_read") return settleFailure(deps, record, "target");

    let undelivered = 0;
    if (check.changes.length > 0) {
      if (plans === null) {
        const { watched } = await loadWatched(deps);
        plans = planTargets(watched, deps.festivals, todayInJapan(new Date(deps.now()))).plans;
      }
      const plan = plans.find((item) => item.key === target.key);
      const festivalName = deps.festivals.get(target.festivalId)?.name.ja ?? target.festivalId;
      for (const change of check.changes) {
        const delivery = await deliver(deps, change, festivalName, plan?.trips ?? []);
        count("notices", delivery.created);
        undelivered += delivery.full;
      }
    }
    // 届けられなかった変化は比べる元を進めず、次の回に届け直す。届いた旅には同じ ID で重ならない
    if (undelivered > 0) {
      count("undelivered", undelivered);
      return settleFailure(deps, record, "target");
    }

    const read = new Set(check.readUrls.map(comparableUrl));
    return {
      ...record,
      observed: check.baseline ?? record.observed,
      cancelled: check.cancelled ?? record.cancelled,
      changeCount: record.changeCount + (check.firm ? 1 : 0),
      pages: record.pages.map((page) => {
        if (page.pendingHashes === null) return page;
        if (read.has(comparableUrl(page.url))) {
          return { ...page, lineHashes: page.pendingHashes, pendingHashes: null, failures: 0 };
        }
        // 開けなかったページは元のまま。間隔を空けて、同じ変化を調べ直す
        const failures = page.failures + 1;
        return {
          ...page,
          pendingHashes: null,
          failures,
          nextTryAt: deps.now() + failureDelay(deps, failures, record.date),
        };
      }),
      pending: null,
      failures: 0,
      groupFailures: 0,
      lease: null,
    };
  });
  return { finished, failure: null, counts };
}

/** 用が済んだセッションを止めて消す。消せなくても結果には響かないので、次の起動で消し直す */
async function disposeSession(
  deps: PatrolDeps,
  patrolId: string,
  sessionId: string,
): Promise<void> {
  try {
    const disposed = await deps.agent.dispose(sessionId);
    await deps.store.updateRun(patrolId, { needsDisposal: !disposed });
  } catch (error) {
    log("patrol_dispose_failed", errorForLog(error));
    await deps.store.updateRun(patrolId, { needsDisposal: true });
  }
}

/**
 * セッションの今の状態を見て、終わっていれば結果を受け取る。
 * Webhook と定期の起動の両方から呼ぶ。受け取りは実行権で1つに絞る
 */
export async function collectSession(
  deps: PatrolDeps,
  sessionId: string,
): Promise<"ignored" | "running" | "waiting" | "busy" | "collected" | "failed"> {
  const state = await deps.agent.read(sessionId);
  if (state.patrolId === null) return "ignored";
  if (state.state === "running") return "running";
  if (state.state === "waiting") {
    if (state.toolUseIds.length > 0) await deps.agent.deny(sessionId, state.toolUseIds);
    return "waiting";
  }
  const holder = `collect-${randomUUID()}`;
  const run = await deps.store.claimRun(state.patrolId, holder, deps.now(), LEASE_TTL_MS);
  if (run === null) {
    // もう終わった実行のセッションが残っていれば、消す
    const closed = await deps.store.readRun(state.patrolId);
    if (closed !== null && closed.status !== "open") {
      await disposeSession(deps, closed.patrolId, sessionId);
    }
    return "busy";
  }

  const costCents = state.costCents;
  if (state.state === "failed") {
    log("patrol_session_failed", { reason: state.reason, costCents });
    const finished = await settleTargets(deps, run, holder, async (_target, record) =>
      settleFailure(deps, record, "group"),
    );
    await deps.store.updateRun(run.patrolId, {
      sessionId,
      costCents,
      claim: null,
      failure: state.reason,
      ...(finished
        ? { status: "failed" as const, finishedAt: deps.now(), needsDisposal: true }
        : {}),
    });
    if (finished) await disposeSession(deps, run.patrolId, sessionId);
    return "failed";
  }
  const { finished, failure, counts } = await acceptReport(deps, run, holder, state);
  await deps.store.updateRun(run.patrolId, {
    sessionId,
    costCents,
    claim: null,
    failure,
    counts,
    ...(finished
      ? {
          status: failure === null ? ("done" as const) : ("failed" as const),
          finishedAt: deps.now(),
          needsDisposal: true,
        }
      : {}),
  });
  if (finished) await disposeSession(deps, run.patrolId, sessionId);
  log("patrol_collected", { targets: run.targets.length, failure, costCents, ...counts });
  return failure === null ? "collected" : "failed";
}

/** Webhook は届かないことがあるので、古い実行は定期の起動でも確かめる */
async function reconcileRuns(deps: PatrolDeps, holder: string): Promise<number> {
  let reconciled = 0;
  const now = deps.now();
  for (const run of await deps.store.listOpenRuns(MAX_OPEN_RUNS)) {
    const age = now - run.createdAt;
    const noSession = run.sessionId === null && age >= PENDING_START_TTL_MS;
    if (age < RECONCILE_AFTER_MS && !noSession) continue;
    try {
      if (run.sessionId !== null) {
        const result = await collectSession(deps, run.sessionId);
        if (result === "collected" || result === "failed") {
          reconciled += 1;
          continue;
        }
      }
      if (age >= RUN_MAX_AGE_MS || noSession) {
        const claimed = await deps.store.claimRun(run.patrolId, holder, now, LEASE_TTL_MS);
        if (claimed === null) continue;
        await settleTargets(deps, claimed, holder, async (_target, record) =>
          settleFailure(deps, record, "group"),
        );
        await deps.store.updateRun(run.patrolId, {
          status: "failed",
          failure: "timed_out",
          finishedAt: deps.now(),
          claim: null,
          needsDisposal: run.sessionId !== null,
        });
        if (run.sessionId !== null) await disposeSession(deps, run.patrolId, run.sessionId);
        reconciled += 1;
      }
    } catch (error) {
      log("patrol_reconcile_failed", errorForLog(error));
    }
  }
  return reconciled;
}

/** 前の回に消せなかったセッションを消す */
async function disposeLeftovers(deps: PatrolDeps): Promise<void> {
  for (const run of await deps.store.listRunsToDispose(MAX_OPEN_RUNS)) {
    if (run.sessionId === null) {
      await deps.store.updateRun(run.patrolId, { needsDisposal: false });
    } else {
      await disposeSession(deps, run.patrolId, run.sessionId);
    }
  }
}

/** 見回る旅がなくなった控えを消す */
async function pruneRecords(deps: PatrolDeps, plans: readonly PatrolPlan[]): Promise<void> {
  const live = new Set(plans.map((plan) => plan.key));
  for (const key of await deps.store.listRecordKeys(MAX_RECORD_KEYS)) {
    if (!live.has(key)) await deps.store.deleteRecord(key, deps.now());
  }
}

/** 定期の起動。2回届いても、同じ対象の作業は実行権で1つに絞られる */
export async function startPatrol(deps: PatrolDeps): Promise<PatrolTickResult> {
  const startedAt = deps.now();
  const holder = `tick-${randomUUID()}`;
  const reconciled = await reconcileRuns(deps, holder);
  await disposeLeftovers(deps);

  const { watched, complete } = await loadWatched(deps);
  const { plans, unmatched } = planTargets(
    watched,
    deps.festivals,
    todayInJapan(new Date(startedAt)),
  );
  if (unmatched > 0) log("patrol_plan_unmatched", { count: unmatched });
  if (complete) await pruneRecords(deps, plans);

  const patrolId = newPatrolId();
  const targets: PatrolTarget[] = [];
  const runTargets: RunTarget[] = [];
  const lodgingBudget: LodgingBudget = {
    remaining: deps.config.maxLodgingChecksPerRun,
    skipped: 0,
  };
  let checked = 0;
  let skipped = 0;
  let lodgingNotices = 0;
  for (const plan of plans) {
    if (checked >= deps.config.maxTargetsPerRun || deps.now() - startedAt > TICK_DEADLINE_MS) {
      skipped += 1;
      continue;
    }
    try {
      const result = await checkTarget(deps, plan, holder, patrolId, lodgingBudget);
      if (result.kind === "skipped") {
        skipped += 1;
        continue;
      }
      checked += 1;
      lodgingNotices += result.lodging;
      if (result.target !== null && result.run !== null) {
        targets.push(result.target);
        runTargets.push(result.run);
      }
    } catch (error) {
      // 1つの対象の失敗で、集めた分を捨てない。実行権が切れたら次の起動が引き継ぐ
      skipped += 1;
      log("patrol_target_failed", { festivalId: plan.festivalId, ...errorForLog(error) });
    }
  }
  if (lodgingBudget.skipped > 0) {
    log("patrol_lodging_skipped", { stays: lodgingBudget.skipped });
  }

  if (targets.length > 0) await sendToAgent(deps, patrolId, targets, runTargets);
  const summary: PatrolTickResult = {
    targets: checked,
    sentToAgent: targets.length,
    skipped,
    lodgingNotices,
    reconciled,
  };
  log("patrol_tick", { ...summary, ms: deps.now() - startedAt });
  return summary;
}

/** セッションができたので、結果を待つ間は同じ対象を調べ直さないようにする */
async function holdForResult(
  deps: PatrolDeps,
  patrolId: string,
  runTargets: readonly RunTarget[],
): Promise<void> {
  const holder = `hold-${randomUUID()}`;
  for (const target of runTargets) {
    const seed = { festivalId: target.festivalId, date: target.date };
    const record = await deps.store.acquireLease(
      target.key,
      seed,
      holder,
      deps.now(),
      LEASE_TTL_MS,
    );
    if (record === null) continue;
    const pending =
      record.pending?.patrolId === patrolId
        ? { patrolId, until: deps.now() + RUN_MAX_AGE_MS }
        : record.pending;
    await deps.store.saveRecord(target.key, holder, { ...record, pending, lease: null });
  }
}

async function sendToAgent(
  deps: PatrolDeps,
  patrolId: string,
  targets: readonly PatrolTarget[],
  runTargets: readonly RunTarget[],
): Promise<void> {
  const now = deps.now();
  const run: PatrolRun = {
    patrolId,
    sessionId: null,
    status: "open",
    targets: [...runTargets],
    createdAt: now,
    finishedAt: null,
    claim: null,
    failure: null,
    counts: {},
    costCents: null,
    needsDisposal: false,
  };
  try {
    await deps.store.createRun(run, now + RUN_RETENTION_MS);
    const request = buildPatrolRequest({
      patrolId,
      requestedAt: nowInJapan(new Date(now)),
      targets,
    });
    const sessionId = await deps.agent.start(request, deps.config.sessionBudgetCents);
    await deps.store.updateRun(patrolId, { sessionId });
    await holdForResult(deps, patrolId, runTargets);
  } catch (error) {
    // セッションを作れなければ、比べる元を変えずに次の回に調べ直す
    log("patrol_start_failed", errorForLog(error));
    const holder = `start-${randomUUID()}`;
    await settleTargets(deps, run, holder, async (_target, record) =>
      settleFailure(deps, record, "group"),
    );
    await deps.store.updateRun(patrolId, {
      status: "failed",
      failure: "start_failed",
      finishedAt: deps.now(),
    });
  }
}

/** Webhook の配信の受け取りの印を取る */
export function claimDelivery(deps: PatrolDeps, id: string) {
  const now = deps.now();
  return deps.store.claimDelivery(id, now, DELIVERY_TTL_MS, now + DELIVERY_RETENTION_MS);
}
