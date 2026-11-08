import {
  type DecideProposalRequest,
  DecideProposalRequestSchema,
  type DecideProposalResponse,
  encodeGuideSseEvent,
  type GuideChatRequest,
  GuideChatRequestSchema,
  GuideMemoItemSchema,
  GuideOpenRequestSchema,
  GuideSessionRefSchema,
  type GuideSseEvent,
  type GuideSseEventOf,
  type GuideStateResponse,
  GuideStateResponseSchema,
  type Itinerary,
  isTrialAccount,
  MAX_MEMO_ITEMS,
  MAX_NOTICES_PER_TRIP,
  MAX_PENDING_PROPOSALS,
  MarkNoticesReadRequestSchema,
  type MarkNoticesReadResponse,
  RevertTripRequestSchema,
  roundLocation,
  type SessionResponse,
  SetTripWatchRequestSchema,
  type TripChange,
  type TripWatch,
  tripPhase,
  UpdateGuideMemoRequestSchema,
} from "@matsuri-ikoka/schema";
import type { Context } from "hono";
import { CostMeter } from "../agent/costMeter";
import type { GuideTrip, GuideTripResult, TripGuideData } from "../guide/data";
import { openGuideTrip, ownerUsageLedger } from "../guide/data";
import {
  planApproval,
  proposalChange,
  remindersWatch,
  revertedItinerary,
  settleProposal,
  startedWatch,
  stoppedWatch,
} from "../guide/decision";
import {
  DEFAULT_GUIDE_LIMITS,
  type GuideLimits,
  type GuideUsageLedger,
  guideTurnBudgetUsd,
  MemoryGuideUsage,
  overGuideLimit,
  ownerAndIpLedger,
  trialLedger,
} from "../guide/limits";
import { memoContentRefusal, memoRefusalMessage } from "../guide/memo";
import { isLivePendingProposal, proposalContentHash, samePlan } from "../guide/proposal";
import { type GuideRunner, newGuideTurn, nextResumeSummary } from "../guide/runner";
import { errorForLog } from "../log";
import type { Consultations } from "../session/consultations";
import {
  type GuideTripRead,
  parseStoredItinerary,
  type StoragePersistence,
} from "../session/persistence";
import { type ItineraryStore, randomId, type Session } from "../session/sessionStore";
import { type DailyGuideUsage, TripGoneError } from "../storage/types";
import { apiError, type ErrorBody } from "./errors";
import { type ConcurrencyLimiter, type DailyLimiter, type TurnQuota, turnQuota } from "./guard";
import { routeParam, type SecureRoutes } from "./policy";
import { streamEvents, type TurnTiming } from "./turnStream";

// 旅のガイドの API（docs/spec/guide.md）。
// - 旅は相談から決める。本文に旅の ID や利用者の ID を持たない（open だけは、残した旅を自分の口から開く）
// - ガイドを用意していなければ（live でモデルの設定がない）、この入口だけが 404 で断る。今の相談は動く
// - 利用者のデータは、決まり（routes/policy.ts）が渡した相談の中の旅と、持ち主で絞った口だけで読み書きする

export interface GuideOptions {
  runner: GuideRunner;
  limits?: GuideLimits;
}

export interface GuideDeps {
  guide?: GuideOptions | undefined;
  consultations: Consultations;
  persistence: StoragePersistence;
  itineraries: ItineraryStore;
  limiter: DailyLimiter;
  clientLimiter?: DailyLimiter | undefined;
  trialLimiter?: DailyLimiter | undefined;
  concurrency?: ConcurrencyLimiter | undefined;
  clientIp?: ((c: Context) => string) | undefined;
  turnIdleMs?: number | undefined;
  turnMaxMs?: number | undefined;
  heartbeatMs?: number | undefined;
  /** 見回りの部品。組み立てられなかった環境では null で、見回りを頼めない（頼んでも、だれも見回らない） */
  patrol?: object | null | undefined;
}

/** 断るときの状態と本文。HTTP の応答にする */
interface TurnRefusal {
  ok: false;
  status: 404 | 409 | 429 | 503;
  body: ErrorBody;
}

const refusal = (
  status: TurnRefusal["status"],
  code: ErrorBody["code"],
  message: string,
  retryable: boolean,
): TurnRefusal => ({ ok: false, status, body: apiError(code, message, retryable) });

/** ない相談も、ほかの人の相談も、同じ応答で断る（あるかどうかを見せない） */
const SESSION_NOT_FOUND = refusal(
  404,
  "bad_request",
  "相談が見つかりません。新しく始めてください。",
  false,
);
const NO_ITINERARY = refusal(409, "bad_request", "まだ旅程がありません。", false);
const TRIP_NOT_FOUND = refusal(404, "bad_request", "旅が見つかりません。", false);
const TRIP_UNAVAILABLE = refusal(
  503,
  "upstream_unavailable",
  "いま旅を読めません。少し待ってから、もう一度送ってください。",
  true,
);
const DECISION_BUSY = refusal(
  409,
  "bad_request",
  "いま返事を作っています。終わってから、もう一度お試しください。",
  true,
);
const TURN_BUSY = refusal(
  409,
  "bad_request",
  "前の返事を作っています。終わってから送ってください。",
  true,
);
const DAILY_LIMIT = refusal(
  429,
  "rate_limited",
  "今日のガイドへの相談の受付は終わりました。また明日お越しください。",
  false,
);
const CROWDED = refusal(
  503,
  "upstream_unavailable",
  "いま混み合っています。少し待ってから、もう一度送ってください。",
  true,
);

const refuse = (c: Context, { body, status }: TurnRefusal) => c.json(body, status);

const notAvailable = (c: Context) =>
  c.json(apiError("bad_request", "ガイドは用意していません。", false), 404);

const sessionNotFound = (c: Context) => refuse(c, SESSION_NOT_FOUND);

const badRequest = (c: Context, message = "送った内容の形が正しくありません。") =>
  c.json(apiError("bad_request", message, false), 400);

async function readJson(c: Context): Promise<unknown> {
  return c.req.json().catch(() => undefined);
}

/** 旅を開けなかったときの断り方 */
function tripRefusalOf(result: Exclude<GuideTripResult, { status: "ok" }>): TurnRefusal {
  switch (result.status) {
    case "no_itinerary":
      return NO_ITINERARY;
    case "unavailable":
      return TRIP_UNAVAILABLE;
    case "missing":
      return TRIP_NOT_FOUND;
  }
}

const tripRefusal = (c: Context, result: Exclude<GuideTripResult, { status: "ok" }>) =>
  refuse(c, tripRefusalOf(result));

function turnTiming(deps: GuideDeps): TurnTiming {
  return {
    ...(deps.turnIdleMs === undefined ? {} : { idleMs: deps.turnIdleMs }),
    ...(deps.turnMaxMs === undefined ? {} : { maxMs: deps.turnMaxMs }),
    ...(deps.heartbeatMs === undefined ? {} : { heartbeatMs: deps.heartbeatMs }),
  };
}

/** いま承認を待てる提案 */
async function pendingProposals(data: TripGuideData, itinerary: Itinerary, now: string) {
  return (await data.proposals()).filter((proposal) =>
    isLivePendingProposal(proposal, itinerary.version, now),
  );
}

/** 数を読めないときの、返答の終わりのイベント */
const uncountedDone = (runner: GuideRunner, trip: GuideTrip): GuideSseEventOf<"guide.done"> => ({
  type: "guide.done",
  data: {
    phase: tripPhase(trip.itinerary, runner.today()),
    unreadNotices: 0,
    pendingProposals: 0,
  },
});

/** 返答の終わりのイベント。保存の口が失敗しても、必ず送れる形で返す */
async function doneEvent(
  runner: GuideRunner,
  trip: GuideTrip,
): Promise<GuideSseEventOf<"guide.done">> {
  try {
    const [notices, pending] = await Promise.all([
      trip.data.notices(),
      pendingProposals(trip.data, trip.itinerary, runner.now()),
    ]);
    return {
      type: "guide.done",
      data: {
        phase: tripPhase(trip.itinerary, runner.today()),
        unreadNotices: notices.filter((notice) => notice.readAt === null).length,
        pendingProposals: pending.length,
      },
    };
  } catch (error) {
    console.error(
      JSON.stringify({ kind: "storage_failed", what: "guide_done", ...errorForLog(error) }),
    );
    return uncountedDone(runner, trip);
  }
}

/** 相談と旅を開いて、使った量を読んだ発言。発言のうち、保存の口を待つのはここまで */
interface OpenedTurn {
  ok: true;
  session: Session;
  trip: GuideTrip;
  ledger: GuideUsageLedger;
  usage: DailyGuideUsage;
}

/** 受け付けた発言。返事を作り終えたら release を呼ぶ */
interface AdmittedTurn extends OpenedTurn {
  release: () => void;
  budgetUsd: number;
  todayBudgetUsd: number;
}

/** 発言の本文 */
interface TurnRequest {
  message: GuideChatRequest["message"];
  location: GuideChatRequest["location"];
}

export function registerGuideRoutes(routes: SecureRoutes, deps: GuideDeps) {
  const limits = deps.guide?.limits ?? DEFAULT_GUIDE_LIMITS;
  const anonymousUsage = new MemoryGuideUsage(() => deps.guide?.runner.today() ?? "");
  /** 見回りが動く環境か。動かなければ、見回りを始められない */
  const watchAvailable = deps.patrol !== undefined && deps.patrol !== null;

  /** 相談の旅を開き、mock では記録の通知と提案を届ける */
  const openTrip = async (runner: GuideRunner, session: Session): Promise<GuideTripResult> => {
    // mock の記録の旅は日付が実際の今日と関係がないので、通知と提案の期限を付けない
    const result = await openGuideTrip(deps, session, { keepTripData: runner.mode === "mock" });
    if (result.status === "ok") await runner.prepare?.(session, result.trip);
    return result;
  };

  /**
   * だれの分を数えるか。ログインしていれば保存の口と IP に、していなければ IP に残す。
   * お試し用のアカウントは IP ごとに数え、全員の費用の上限も持つ
   */
  const usageLedger = (
    runner: GuideRunner,
    session: Session,
    tripId: string,
    ip: string,
  ): GuideUsageLedger => {
    if (session.ownerUid === null) return anonymousUsage.ledger(ip, tripId);
    if (isTrialAccount(session.ownerUid)) return trialLedger(anonymousUsage, ip, tripId, limits);
    return ownerAndIpLedger(
      ownerUsageLedger(deps.persistence, session.ownerUid, tripId, runner.today()),
      anonymousUsage.ledger(ip, tripId),
    );
  };

  /** 相談と旅を開き、使った量を読む */
  const openTurn = async (
    runner: GuideRunner,
    sessionId: string,
    quota: TurnQuota,
    open: (id: string) => Promise<Session | undefined>,
  ): Promise<OpenedTurn | TurnRefusal> => {
    const session = await open(sessionId);
    if (session === undefined) return SESSION_NOT_FOUND;
    const result = await openTrip(runner, session);
    if (result.status !== "ok") return tripRefusalOf(result);
    const { trip } = result;
    const ledger = usageLedger(runner, session, trip.itinerary.id, quota.ip);
    const usage = await ledger.read().catch((error: unknown) => {
      // 数えられなくても相談は止めない。全体の回数の上限と同時に作る数の上限は効いたまま
      console.error(
        JSON.stringify({ kind: "storage_failed", what: "guide_usage", ...errorForLog(error) }),
      );
      return { user: { turns: 0, costUsd: 0 }, trip: { turns: 0, costUsd: 0 } };
    });
    return { ok: true, session, trip, ledger, usage };
  };

  /**
   * 発言を受け付けるかを決める。受け付けたら、相談を「返事を作っている途中」にする。
   * ここでは待たない。同じ相談の2つの発言が、どちらも返事を作り始めないように
   */
  const admitTurn = (
    runner: GuideRunner,
    opened: OpenedTurn,
    quota: TurnQuota,
  ): AdmittedTurn | TurnRefusal => {
    const { session, usage } = opened;
    if (session.busy) return TURN_BUSY;
    if (overGuideLimit(usage, limits) || !quota.allows()) return DAILY_LIMIT;
    let release = () => {};
    if (runner.mode === "live" && deps.concurrency !== undefined) {
      const acquired = deps.concurrency.tryAcquire(quota.client);
      if (acquired === null) return CROWDED;
      release = acquired;
    }
    quota.consume();
    session.busy = true;
    return {
      ...opened,
      release,
      budgetUsd: guideTurnBudgetUsd(usage, limits, runner.maxBudgetUsd),
      // ツールの中の調べは、今日の残りで抑える（調べごとの上限は、それぞれの調べ役が持つ）
      todayBudgetUsd: guideTurnBudgetUsd(usage, limits, undefined),
    };
  };

  /** 受け付けた発言の返事を作り、使った量を数える */
  const runAdmitted = async (
    runner: GuideRunner,
    admitted: AdmittedTurn,
    request: TurnRequest,
    stream: {
      signal: AbortSignal;
      emit: (event: GuideSseEvent) => void;
      progress: () => void;
    },
  ): Promise<void> => {
    const { session, trip, ledger, release, budgetUsd, todayBudgetUsd } = admitted;
    const { signal, emit, progress } = stream;
    const turn = newGuideTurn();
    const meter = new CostMeter(todayBudgetUsd);
    try {
      await runner.runTurn(
        {
          session,
          trip,
          message: request.message,
          location: request.location,
          budgetUsd,
          turn,
          meter,
          signal,
          progress,
        },
        emit,
      );
    } finally {
      release();
      // すべて消した人のデータを、止まった返事の片付けで書き戻さない
      if (!session.discarded) {
        await settleTurn({ session, trip, runner, ledger, turn, meter });
      }
      await deps.persistence.saveSession(session);
    }
  };

  // 残した旅を開いて、ガイドと話す相談を作る。読めるのは自分の旅だけ
  routes.owner("POST", "/api/guide/open", async (c, { owner, trips }) => {
    const guide = deps.guide;
    if (guide === undefined) return notAvailable(c);
    const request = GuideOpenRequestSchema.safeParse(await readJson(c));
    if (!request.success) return badRequest(c);
    const { tripId } = request.data;
    await deps.persistence.flush(tripId);
    const detail = await trips.getTrip(tripId);
    const itinerary = detail === null ? undefined : parseStoredItinerary(detail.itinerary);
    if (itinerary === undefined) {
      return c.json(apiError("bad_request", "旅が見つかりません。", false), 404);
    }
    // 手元の写しのほうが新しければ、そちらの版で開く
    const latest = deps.itineraries.rememberLatest(itinerary);
    const session = await deps.consultations.resumeTrip(owner, latest, { stage: "shiori" });
    return c.json(
      { sessionId: session.id, mode: guide.runner.mode } satisfies SessionResponse,
      201,
    );
  });

  routes.consultation("POST", "/api/guide/state", async (c, { open }) => {
    const guide = deps.guide;
    if (guide === undefined) return notAvailable(c);
    const request = GuideSessionRefSchema.safeParse(await readJson(c));
    if (!request.success) return badRequest(c);
    const session = await open(request.data.sessionId);
    if (session === undefined) return sessionNotFound(c);
    const result = await openTrip(guide.runner, session);
    if (result.status !== "ok") return tripRefusal(c, result);
    const { itinerary, data } = result.trip;
    const [watch, notices, pending, memo] = await Promise.all([
      data.watch(),
      data.notices(),
      pendingProposals(data, itinerary, guide.runner.now()),
      data.memo(),
    ]);
    const state: GuideStateResponse = GuideStateResponseSchema.parse({
      tripId: itinerary.id,
      version: itinerary.version,
      phase: tripPhase(itinerary, guide.runner.today()),
      watch,
      watchAvailable,
      notices: notices.slice(0, MAX_NOTICES_PER_TRIP),
      proposals: pending.slice(0, MAX_PENDING_PROPOSALS),
      memo: memo.slice(0, MAX_MEMO_ITEMS),
    });
    c.header("Cache-Control", "private, no-store");
    return c.json(state);
  });

  routes.consultation("POST", "/api/guide/chat", async (c, { viewer, open }) => {
    const guide = deps.guide;
    if (guide === undefined) return notAvailable(c);
    const request = GuideChatRequestSchema.safeParse(await readJson(c));
    if (!request.success) return badRequest(c);
    const { sessionId, message, location } = request.data;
    const { runner } = guide;
    const quota = turnQuota(deps, viewer, deps.clientIp?.(c) ?? "unknown");
    // 現在地は、端末が丸めていなくても、ここで要る細かさに丸めてから使う
    const said: TurnRequest = {
      message,
      location: location === undefined ? undefined : roundLocation(location),
    };
    const opened = await openTurn(runner, sessionId, quota, open);
    if (!opened.ok) return refuse(c, opened);
    // ここから返答を始めるまで待たない
    const admitted = admitTurn(runner, opened, quota);
    if (!admitted.ok) return refuse(c, admitted);
    return streamEvents<GuideSseEvent>(
      c,
      admitted.session,
      (signal, emit, progress) => runAdmitted(runner, admitted, said, { signal, emit, progress }),
      turnTiming(deps),
      {
        encode: encodeGuideSseEvent,
        error: (data) => ({ type: "error", data }),
        done: () => doneEvent(runner, admitted.trip),
      },
    );
  });

  /** 相談の旅のガイドのデータを開く。旅は相談から決めるので、ほかの旅の手帳・通知・提案には届かない */
  const openGuideData = async (
    c: Context,
    sessionId: string,
    open: (id: string) => Promise<Session | undefined>,
  ) => {
    const guide = deps.guide;
    if (guide === undefined) return notAvailable(c);
    const session = await open(sessionId);
    if (session === undefined) return sessionNotFound(c);
    const result = await openTrip(guide.runner, session);
    if (result.status !== "ok") return tripRefusal(c, result);
    return { session, data: result.trip.data, runner: guide.runner };
  };

  const memoNotFound = (c: Context) =>
    c.json(apiError("bad_request", "手帳の項目が見つかりません。", false), 404);

  routes.consultation("POST", "/api/guide/memo/:id", async (c, { open }) => {
    if (deps.guide === undefined) return notAvailable(c);
    const request = UpdateGuideMemoRequestSchema.safeParse(await readJson(c));
    if (!request.success) return badRequest(c);
    const opened = await openGuideData(c, request.data.sessionId, open);
    if (opened instanceof Response) return opened;
    const { session, data, runner } = opened;
    const id = routeParam(c, "id");
    const item = (await data.memo()).find((entry) => entry.id === id);
    if (item === undefined) return memoNotFound(c);
    const refusal = memoContentRefusal(request.data.text);
    if (refusal !== null) return badRequest(c, memoRefusalMessage(refusal));
    const updated = GuideMemoItemSchema.parse({
      ...item,
      text: request.data.text,
      updatedAt: runner.now(),
    });
    try {
      await data.putMemo(updated);
    } catch (error) {
      if (!(error instanceof TripGoneError)) throw error;
      return tripRefusal(c, { status: "missing" });
    }
    await deps.persistence.saveSession(session);
    c.header("Cache-Control", "private, no-store");
    return c.json(updated);
  });

  routes.consultation("POST", "/api/guide/memo/:id/delete", async (c, { open }) => {
    if (deps.guide === undefined) return notAvailable(c);
    const request = GuideSessionRefSchema.safeParse(await readJson(c));
    if (!request.success) return badRequest(c);
    const opened = await openGuideData(c, request.data.sessionId, open);
    if (opened instanceof Response) return opened;
    const deleted = await opened.data.deleteMemo(routeParam(c, "id"));
    if (!deleted) return memoNotFound(c);
    await deps.persistence.saveSession(opened.session);
    return c.body(null, 204);
  });

  /**
   * 同じ旅の承認と戻す操作を、このインスタンスの中で1つずつ行う。
   * 同じ承認が2回届いても、2回目は1回目の結果を見てから決めるので、版は1つしか増えない
   */
  const tripLocks = new Map<string, Promise<unknown>>();
  const withTripLock = async <T>(tripId: string, work: () => Promise<T>): Promise<T> => {
    const previous = tripLocks.get(tripId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    tripLocks.set(tripId, next);
    try {
      return await next;
    } finally {
      if (tripLocks.get(tripId) === next) tripLocks.delete(tripId);
    }
  };

  /**
   * 承認と戻すの判断に使う旅を開く。今の版は手元の写しでなく、保存の口から読み直した版にする
   * （書き込みに失敗すると、手元の写しだけが先の版になっていることがある）。
   * 写しの版が違えば、写しを読んだ版に戻す。保存の口を読めなければ、判断しない
   */
  const openStoredTrip = async (
    runner: GuideRunner,
    session: Session,
  ): Promise<GuideTripResult> => {
    const result = await openTrip(runner, session);
    if (result.status !== "ok") return result;
    const { itinerary } = result.trip;
    let read: GuideTripRead;
    try {
      read = await deps.persistence.readGuideTrip(itinerary.id, session.ownerUid);
    } catch (error) {
      console.error(
        JSON.stringify({ kind: "storage_failed", what: "guide_decide", ...errorForLog(error) }),
      );
      return { status: "unavailable" };
    }
    if (read.status !== "found") return { status: "missing" };
    if (read.itinerary.version !== itinerary.version) {
      console.error(JSON.stringify({ kind: "guide_copy_reset" }));
      deps.itineraries.remember(read.itinerary);
    }
    return { status: "ok", trip: { ...result.trip, itinerary: read.itinerary } };
  };

  /**
   * 新しい版を保存し、保存の口から読み直して確かめる。確かめられなければ、自動でやり直さず unknown にし、
   * 手元の写しを保存の口の版（読めなければ当てる前の版）に戻す。保存されていない版を、次の判断で今の版にしない。
   * gone は、返事の途中に旅が消された（消した旅を作り直さない）
   */
  const applyVersion = async (
    session: Session,
    current: Itinerary,
    next: Itinerary,
  ): Promise<"applied" | "gone" | { unknown: number | null }> => {
    if (!deps.itineraries.saveForSession(session, next)) return "gone";
    try {
      const read = await deps.persistence.readGuideTrip(next.id, session.ownerUid);
      if (read.status !== "found") {
        deps.itineraries.remember(current);
        return { unknown: null };
      }
      const same =
        read.itinerary.version === next.version &&
        proposalContentHash(read.itinerary) === proposalContentHash(next);
      if (same) return "applied";
      deps.itineraries.remember(read.itinerary);
      return { unknown: read.itinerary.version };
    } catch (error) {
      console.error(
        JSON.stringify({ kind: "storage_failed", what: "guide_apply", ...errorForLog(error) }),
      );
      deps.itineraries.remember(current);
      return { unknown: null };
    }
  };

  /**
   * 返事を作っている途中の相談では、承認と戻すを断る（返事が旅程を書くのと重ならないように）。
   * 受け付けたら、終わるまで相談を「途中」にして、そのあいだの発言を待たせる
   */
  const whileIdle = async (
    c: Context,
    session: Session,
    work: () => Promise<Response>,
  ): Promise<Response> => {
    if (session.busy) return refuse(c, DECISION_BUSY);
    session.busy = true;
    try {
      return await work();
    } finally {
      session.busy = false;
    }
  };

  /** 状態の書き換えに失敗しても、結果は変えない（次の承認で、今の旅程から決め直せる） */
  const settleQuietly = async (work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      if (error instanceof TripGoneError) throw error;
      console.error(
        JSON.stringify({ kind: "storage_failed", what: "guide_proposal", ...errorForLog(error) }),
      );
    }
  };

  const decided = (c: Context, response: DecideProposalResponse) => {
    c.header("Cache-Control", "private, no-store");
    return c.json(response);
  };

  // 通知を読んだと知らせる。この旅の通知だけを読んだことにし、ほかの ID は、ないものとして扱う
  routes.consultation("POST", "/api/guide/notices/read", async (c, { open }) => {
    if (deps.guide === undefined) return notAvailable(c);
    const request = MarkNoticesReadRequestSchema.safeParse(await readJson(c));
    if (!request.success) return badRequest(c);
    const opened = await openGuideData(c, request.data.sessionId, open);
    if (opened instanceof Response) return opened;
    const { session, data, runner } = opened;
    const wanted = new Set(request.data.noticeIds);
    const notices = await data.notices();
    const found = notices.filter((notice) => wanted.has(notice.id));
    if (found.length === 0) {
      return c.json(apiError("bad_request", "通知が見つかりません。", false), 404);
    }
    const now = runner.now();
    try {
      for (const notice of found) {
        if (notice.readAt === null) await data.putNotice({ ...notice, readAt: now });
      }
    } catch (error) {
      if (!(error instanceof TripGoneError)) throw error;
      return tripRefusal(c, { status: "missing" });
    }
    await deps.persistence.saveSession(session);
    const unread = notices.filter(
      (notice) => notice.readAt === null && !wanted.has(notice.id),
    ).length;
    c.header("Cache-Control", "private, no-store");
    return c.json({ unread } satisfies MarkNoticesReadResponse);
  });

  /**
   * 見回りを始める・止める。見回りは残した旅の下の依頼だけを探すので、始めるのにログインが要る
   * （ログインしていなければ、どの環境でも 401。相談の中に書いても、だれも見回らない）。
   * ログインしていて、まだ残していない旅なら、旅を残してから旅の下に書く
   */
  routes.consultation("POST", "/api/guide/watch", async (c, { open }) => {
    const guide = deps.guide;
    if (guide === undefined) return notAvailable(c);
    const request = SetTripWatchRequestSchema.safeParse(await readJson(c));
    if (!request.success) return badRequest(c);
    const { runner } = guide;
    const session = await open(request.data.sessionId);
    if (session === undefined) return sessionNotFound(c);
    const starting = request.data.action === "start";
    if (starting && !watchAvailable) {
      return c.json(apiError("bad_request", "この環境では、見回りを頼めません。", false), 409);
    }
    if (starting && session.ownerUid === null) {
      return c.json(
        apiError("unauthorized", "見回りを頼むには、ログインして旅を残してください。", false),
        401,
      );
    }
    let result = await openTrip(runner, session);
    if (result.status !== "ok") return tripRefusal(c, result);
    const now = runner.now();
    if (starting) {
      if (tripPhase(result.trip.itinerary, runner.today()) === "after") {
        return c.json(
          apiError("bad_request", "旅は終わったので、見回りは頼めません。", false),
          409,
        );
      }
      if (session.ownerUid !== null) {
        const claimed = await deps.persistence
          .forOwner(session.ownerUid)
          .claimTrip(result.trip.itinerary.id);
        if (claimed.status !== "saved") return tripRefusal(c, { status: "missing" });
        // 残した旅として開き直す（相談の中に持っていたものは、旅の下へ移る）
        result = await openTrip(runner, session);
        if (result.status !== "ok") return tripRefusal(c, result);
      }
    }
    const { itinerary, data } = result.trip;
    const existing = await data.watch();
    let watch: TripWatch;
    if (starting) {
      watch = startedWatch(existing, itinerary, now);
    } else {
      if (existing === null) {
        return c.json(apiError("bad_request", "見回りは頼まれていません。", false), 404);
      }
      const { action } = request.data;
      watch =
        action === "stop"
          ? stoppedWatch(existing, now)
          : remindersWatch(existing, action === "reminders_on");
    }
    try {
      if (watch !== existing) await data.putWatch(watch);
    } catch (error) {
      if (!(error instanceof TripGoneError)) throw error;
      return tripRefusal(c, { status: "missing" });
    }
    await deps.persistence.saveSession(session);
    c.header("Cache-Control", "private, no-store");
    return c.json(watch);
  });

  const proposalNotFound = (c: Context) =>
    c.json(apiError("bad_request", "組み直しの案が見つかりません。", false), 404);

  /** 承認・却下を、旅の順番待ちのあとで決める。今の版は保存の口から読み直した版 */
  const decideLocked = async (
    c: Context,
    session: Session,
    runner: GuideRunner,
    id: string,
    request: DecideProposalRequest,
  ): Promise<Response> => {
    const result = await openStoredTrip(runner, session);
    if (result.status !== "ok") return tripRefusal(c, result);
    const { itinerary, data } = result.trip;
    const proposal = (await data.proposals()).find((entry) => entry.id === id);
    if (proposal === undefined) return proposalNotFound(c);
    const now = runner.now();
    const settle = async (status: Parameters<typeof settleProposal>[1]) => {
      await settleQuietly(() => data.putProposal(settleProposal(proposal, status, now)));
      await deps.persistence.saveSession(session);
    };
    if (request.decision === "reject") {
      if (proposal.status === "approved") {
        return c.json(
          apiError(
            "bad_request",
            "この案はもう承認しました。前の旅程に戻すときは、前の版に戻してください。",
            false,
          ),
          409,
        );
      }
      if (proposal.status !== "rejected") await settle("rejected");
      return decided(c, { outcome: "rejected" });
    }
    const plan = planApproval(proposal, request, itinerary, now);
    switch (plan.kind) {
      case "rejected":
        return decided(c, { outcome: "rejected" });
      case "stale":
        if (plan.mark) await settle("stale");
        return decided(c, { outcome: "stale", currentVersion: itinerary.version });
      case "expired":
        if (plan.mark) await settle("expired");
        return decided(c, { outcome: "expired" });
      case "applied":
        if (plan.mark) await settle("approved");
        return decided(c, { outcome: "applied", change: proposalChange(proposal) });
      case "apply": {
        const change = proposalChange(proposal);
        const applied = await applyVersion(session, itinerary, change.itinerary);
        if (applied === "gone") return tripRefusal(c, { status: "missing" });
        if (applied !== "applied") {
          console.error(JSON.stringify({ kind: "guide_apply_unknown" }));
          return decided(c, { outcome: "unknown", currentVersion: applied.unknown });
        }
        await settle("approved");
        return decided(c, { outcome: "applied", change });
      }
    }
  };

  // 提案を承認する・断る。承認は、見た提案の版とハッシュを照らし合わせてから、新しい版にする
  routes.consultation("POST", "/api/guide/proposals/:id/decision", async (c, { open }) => {
    if (deps.guide === undefined) return notAvailable(c);
    const parsed = DecideProposalRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return badRequest(c);
    const request = parsed.data;
    const opened = await openGuideData(c, request.sessionId, open);
    if (opened instanceof Response) return opened;
    const { session, runner } = opened;
    const id = routeParam(c, "id");
    const tripId = session.itineraryId ?? "";
    try {
      return await withTripLock(tripId, () =>
        whileIdle(c, session, () => decideLocked(c, session, runner, id, request)),
      );
    } catch (error) {
      if (!(error instanceof TripGoneError)) throw error;
      return tripRefusal(c, { status: "missing" });
    }
  });
  // 前の版に戻す。戻す操作も新しい版として残し、履歴は消さない。差分は今の旅程から計算する
  routes.consultation("POST", "/api/guide/revert", async (c, { open }) => {
    if (deps.guide === undefined) return notAvailable(c);
    const request = RevertTripRequestSchema.safeParse(await readJson(c));
    if (!request.success) return badRequest(c);
    const opened = await openGuideData(c, request.data.sessionId, open);
    if (opened instanceof Response) return opened;
    const { session, runner } = opened;
    const { toVersion } = request.data;
    return withTripLock(session.itineraryId ?? "", () =>
      whileIdle(c, session, async () => {
        const result = await openStoredTrip(runner, session);
        if (result.status !== "ok") return tripRefusal(c, result);
        const { itinerary } = result.trip;
        if (toVersion >= itinerary.version) {
          return c.json(
            apiError("bad_request", "いまの版より前の版を選んでください。", false),
            409,
          );
        }
        let target: Itinerary | undefined;
        try {
          target = await deps.persistence.readGuideTripVersion(
            itinerary.id,
            session.ownerUid,
            toVersion,
          );
        } catch (error) {
          console.error(
            JSON.stringify({ kind: "storage_failed", what: "guide_revert", ...errorForLog(error) }),
          );
          return refuse(c, TRIP_UNAVAILABLE);
        }
        if (target === undefined) {
          return c.json(apiError("bad_request", "その版はもう残っていません。", false), 404);
        }
        if (samePlan(itinerary, target)) {
          return c.json(apiError("bad_request", "いまの旅程と同じです。", false), 409);
        }
        const change: TripChange = revertedItinerary(itinerary, target);
        const applied = await applyVersion(session, itinerary, change.itinerary);
        if (applied === "gone") return tripRefusal(c, { status: "missing" });
        if (applied !== "applied") {
          console.error(JSON.stringify({ kind: "guide_apply_unknown" }));
          // 自動でやり直さない。旅程を読み直してもらう
          return c.json(
            apiError(
              "upstream_unavailable",
              "戻せたか確かめられませんでした。旅程を読み直してから、もう一度お試しください。",
              false,
            ),
            503,
          );
        }
        await deps.persistence.saveSession(session);
        c.header("Cache-Control", "private, no-store");
        return c.json(change);
      }),
    );
  });
}

/** 発言のあとの片付け。使った量を数え、続きの要約を書く。失敗しても返答は止めない */
async function settleTurn(input: {
  session: Session;
  trip: GuideTrip;
  runner: GuideRunner;
  ledger: GuideUsageLedger;
  turn: ReturnType<typeof newGuideTurn>;
  meter: CostMeter;
}): Promise<void> {
  const { session, trip, runner, ledger, turn, meter } = input;
  try {
    await ledger.add({ turns: 1, costUsd: meter.usd });
    const now = runner.now();
    const pending = await pendingProposals(trip.data, trip.itinerary, now);
    session.guide.resume = nextResumeSummary(session.guide.resume, {
      turn,
      pendingProposalIds: pending.slice(0, MAX_PENDING_PROPOSALS).map((proposal) => proposal.id),
      now,
    });
  } catch (error) {
    console.error(
      JSON.stringify({ kind: "storage_failed", what: "guide_settle", ...errorForLog(error) }),
    );
  }
}
