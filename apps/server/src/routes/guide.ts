import {
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
  type SessionResponse,
  tripPhase,
  UpdateGuideMemoRequestSchema,
} from "@matsuri-ikoka/schema";
import type { Context } from "hono";
import { CostMeter } from "../agent/costMeter";
import { AgentError } from "../agent/runner";
import type { GuideTrip, GuideTripResult, TripGuideData } from "../guide/data";
import { openGuideTrip, ownerUsageLedger } from "../guide/data";
import { EMERGENCY_FALLBACK_TEXT, emergencyEvent, isEmergencyMessage } from "../guide/emergency";
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
import { isLivePendingProposal } from "../guide/proposal";
import { type GuideRunner, newGuideTurn, nextResumeSummary } from "../guide/runner";
import { errorForLog } from "../log";
import type { Consultations } from "../session/consultations";
import { parseStoredItinerary, type StoragePersistence } from "../session/persistence";
import { type ItineraryStore, randomId, type Session } from "../session/sessionStore";
import { type DailyGuideUsage, TripGoneError } from "../storage/types";
import { apiError, type ErrorBody } from "./errors";
import { type ConcurrencyLimiter, type DailyLimiter, type TurnQuota, turnQuota } from "./guard";
import { routeParam, type SecureRoutes } from "./policy";
import { isClientClosed, openEventStream, streamEvents, type TurnTiming } from "./turnStream";

// 旅のガイドの API（docs/spec/guide.md）。
// - 旅は相談から決める。本文に旅の ID や利用者の ID を持たない（open だけは、残した旅を自分の口から開く）
// - ガイドを用意していなければ（live でモデルの設定がない）、この入口だけが 404 で断る。今の相談は動く
// - 緊急の言葉がある発言は、保存の口を待たずに SSE を開いて、公的な連絡先を先に送る。上限や混雑でも、
//   相談や旅を開けないときも、連絡先と決まった文を返し、いつもの案内（新しく始める、もう一度送るなど）を添える
// - 利用者のデータは、決まり（routes/policy.ts）が渡した相談の中の旅と、持ち主で絞った口だけで読み書きする

/** 緊急の発言で、保存の口を待つ上限。連絡先は待つ前に送ってある。止まったら、決まった文と案内で閉じる */
const EMERGENCY_WAIT_MS = 5_000;

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
  emergencyWaitMs?: number | undefined;
}

/** 断るときの状態と本文。ふつうの発言は HTTP の応答に、緊急の発言は連絡先のあとの error イベントにする */
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

/** 上限までに終わらなければ late の値を返す。処理そのものは止めない（終わったら、結果は捨てる） */
function settleWithin<T>(work: Promise<T>, ms: number, late: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(late()), ms);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

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

/** 相談や旅を開けないときの終わりのイベント。旅が分からないので、数は0で返す */
const NO_TRIP_DONE: GuideSseEventOf<"guide.done"> = {
  type: "guide.done",
  data: { phase: "during", unreadNotices: 0, pendingProposals: 0 },
};

/** モデルの返事がないときに、連絡先に添える決まった文 */
const emergencyFallback = (): GuideSseEvent => ({
  type: "message.delta",
  data: { messageId: randomId("emergency"), text: EMERGENCY_FALLBACK_TEXT },
});

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
    emergency: boolean,
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
          emergency,
          budgetUsd,
          turn,
          meter,
          signal,
          progress,
        },
        emit,
      );
    } catch (error) {
      // 緊急の相談では、返事を作れなくても（時間切れも）、決まった文を添える。そのあとの error でいつもの案内も届く。
      // 利用者が接続を切ったときだけは、届かないので何も送らない
      if (emergency && !isClientClosed(signal)) {
        console.error(
          JSON.stringify({ kind: "guide_emergency_reply_failed", ...errorForLog(error) }),
        );
        emit(emergencyFallback());
      }
      throw error;
    } finally {
      release();
      const settled = (async () => {
        // すべて消した人のデータを、止まった返事の片付けで書き戻さない
        if (!session.discarded) {
          await settleTurn({ session, trip, runner, ledger, turn, meter, emergency });
        }
        await deps.persistence.saveSession(session);
      })();
      // 緊急の発言は、保存の口が止まっても閉じる
      await (emergency
        ? settleWithin(settled, deps.emergencyWaitMs ?? EMERGENCY_WAIT_MS, () => {
            console.error(JSON.stringify({ kind: "storage_failed", what: "guide_settle_late" }));
          })
        : settled);
    }
  };

  /**
   * 緊急の言葉がある発言。保存の口を待たずに SSE を開いて、公的な連絡先を先に送る。
   * 受け付けられないときは、決まった文と、ふつうの発言と同じ案内を error で送る（緊急の言葉が
   * たまたま当たった発言でも、案内を失わない）。ない相談もほかの人の相談も同じ応答になる。
   * 受け付けられなかった発言は、相談の状態に触れない（前の返事を作っている途中でも送れる）
   */
  const emergencyTurn = (
    c: Context,
    runner: GuideRunner,
    sessionId: string,
    request: TurnRequest,
    quota: TurnQuota,
    open: (id: string) => Promise<Session | undefined>,
  ): Response => {
    const waitMs = deps.emergencyWaitMs ?? EMERGENCY_WAIT_MS;
    let openedTrip: GuideTrip | null = null;
    let admittedSession: Session | null = null;
    let stopTurn: (() => void) | null = null;
    return openEventStream<GuideSseEvent>(
      c,
      async (signal, emit, progress) => {
        emit(emergencyEvent());
        const refuseAfterContacts = ({ body }: TurnRefusal): never => {
          emit(emergencyFallback());
          throw new AgentError(body.code, body.message, body.retryable);
        };
        const opened = await settleWithin(openTurn(runner, sessionId, quota, open), waitMs, () => {
          console.error(JSON.stringify({ kind: "guide_emergency_open_late" }));
          return TRIP_UNAVAILABLE;
        }).catch((error: unknown) => {
          console.error(
            JSON.stringify({ kind: "guide_emergency_open_failed", ...errorForLog(error) }),
          );
          return TRIP_UNAVAILABLE;
        });
        if (!opened.ok) return refuseAfterContacts(opened);
        openedTrip = opened.trip;
        const admitted = admitTurn(runner, opened, quota);
        if (!admitted.ok) return refuseAfterContacts(admitted);
        admittedSession = admitted.session;
        admittedSession.stopTurn = stopTurn;
        await runAdmitted(runner, admitted, request, true, { signal, emit, progress });
      },
      turnTiming(deps),
      {
        encode: encodeGuideSseEvent,
        error: (data) => ({ type: "error", data }),
        done: () => {
          const trip = openedTrip;
          return trip === null
            ? NO_TRIP_DONE
            : settleWithin(doneEvent(runner, trip), waitMs, () => uncountedDone(runner, trip));
        },
        started: (stop) => {
          stopTurn = stop;
        },
        finished: () => {
          if (admittedSession !== null) {
            admittedSession.stopTurn = null;
            admittedSession.busy = false;
          }
        },
      },
    );
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
    const session = await deps.consultations.start(owner, null);
    session.itineraryId = latest.id;
    session.selectedFestivalId = latest.mainFestivalId;
    session.stage = "shiori";
    session.preferences = latest.preferences;
    // 組み直しの提案を、今の旅程の条件で確かめられるようにする
    session.conditions = {
      origin: latest.origin,
      returnTo: latest.returnTo,
      party: latest.party,
      ...(latest.budget === undefined ? {} : { budget: latest.budget }),
    };
    await deps.persistence.saveSession(session);
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
    const said: TurnRequest = { message, location };
    if (isEmergencyMessage(message)) {
      return emergencyTurn(c, runner, sessionId, said, quota, open);
    }
    const opened = await openTurn(runner, sessionId, quota, open);
    if (!opened.ok) return refuse(c, opened);
    // ここから返答を始めるまで待たない
    const admitted = admitTurn(runner, opened, quota);
    if (!admitted.ok) return refuse(c, admitted);
    return streamEvents<GuideSseEvent>(
      c,
      admitted.session,
      (signal, emit, progress) =>
        runAdmitted(runner, admitted, said, false, { signal, emit, progress }),
      turnTiming(deps),
      {
        encode: encodeGuideSseEvent,
        error: (data) => ({ type: "error", data }),
        done: () => doneEvent(runner, admitted.trip),
      },
    );
  });

  /** 手帳の項目を開く。旅は相談から決めるので、ほかの旅の項目には届かない */
  const openMemo = async (
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
    const opened = await openMemo(c, request.data.sessionId, open);
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
    const opened = await openMemo(c, request.data.sessionId, open);
    if (opened instanceof Response) return opened;
    const deleted = await opened.data.deleteMemo(routeParam(c, "id"));
    if (!deleted) return memoNotFound(c);
    await deps.persistence.saveSession(opened.session);
    return c.body(null, 204);
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
  emergency: boolean;
}): Promise<void> {
  const { session, trip, runner, ledger, turn, meter, emergency } = input;
  try {
    await ledger.add({ turns: 1, costUsd: meter.usd });
    const now = runner.now();
    const pending = await pendingProposals(trip.data, trip.itinerary, now);
    session.guide.resume = nextResumeSummary(session.guide.resume, {
      turn,
      emergency,
      pendingProposalIds: pending.slice(0, MAX_PENDING_PROPOSALS).map((proposal) => proposal.id),
      now,
    });
  } catch (error) {
    console.error(
      JSON.stringify({ kind: "storage_failed", what: "guide_settle", ...errorForLog(error) }),
    );
  }
}
