import {
  encodeGuideSseEvent,
  GuideChatRequestSchema,
  GuideMemoItemSchema,
  GuideOpenRequestSchema,
  GuideSessionRefSchema,
  type GuideSseEvent,
  type GuideSseEventOf,
  type GuideStateResponse,
  GuideStateResponseSchema,
  type Itinerary,
  MAX_MEMO_ITEMS,
  MAX_NOTICES_PER_TRIP,
  MAX_PENDING_PROPOSALS,
  type SessionResponse,
  tripPhase,
  UpdateGuideMemoRequestSchema,
} from "@matsuri-ikoka/schema";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { CostMeter } from "../agent/costMeter";
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
} from "../guide/limits";
import { memoContentRefusal, memoRefusalMessage } from "../guide/memo";
import { isLivePendingProposal } from "../guide/proposal";
import { type GuideRunner, newGuideTurn, nextResumeSummary } from "../guide/runner";
import { errorForLog } from "../log";
import type { Consultations } from "../session/consultations";
import { parseStoredItinerary, type StoragePersistence } from "../session/persistence";
import { type ItineraryStore, randomId, type Session } from "../session/sessionStore";
import { TripGoneError } from "../storage/types";
import { apiError } from "./errors";
import { type ConcurrencyLimiter, type DailyLimiter, limitKey } from "./guard";
import { routeParam, type SecureRoutes } from "./policy";
import { isClientClosed, streamEvents, type TurnTiming } from "./turnStream";

// 旅のガイドの API（docs/spec/guide.md）。
// - 旅は相談から決める。本文に旅の ID や利用者の ID を持たない（open だけは、残した旅を自分の口から開く）
// - ガイドを用意していなければ（live でモデルの設定がない）、この入口だけが 404 で断る。今の相談は動く
// - 緊急の相談は、上限や混雑でも、相談や旅を開けないときも断らない。公的な連絡先を先に送る
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
  concurrency?: ConcurrencyLimiter | undefined;
  clientIp?: ((c: Context) => string) | undefined;
  turnIdleMs?: number | undefined;
  turnMaxMs?: number | undefined;
  heartbeatMs?: number | undefined;
}

const notAvailable = (c: Context) =>
  c.json(apiError("bad_request", "ガイドは用意していません。", false), 404);

/** ない相談も、ほかの人の相談も、同じ応答で断る（あるかどうかを見せない） */
const sessionNotFound = (c: Context) =>
  c.json(apiError("bad_request", "相談が見つかりません。新しく始めてください。", false), 404);

const badRequest = (c: Context, message = "送った内容の形が正しくありません。") =>
  c.json(apiError("bad_request", message, false), 400);

async function readJson(c: Context): Promise<unknown> {
  return c.req.json().catch(() => undefined);
}

/** 旅を開けなかったときの応答 */
function tripRefusal(c: Context, result: Exclude<GuideTripResult, { status: "ok" }>) {
  return result.status === "no_itinerary"
    ? c.json(apiError("bad_request", "まだ旅程がありません。", false), 409)
    : c.json(apiError("bad_request", "旅が見つかりません。", false), 404);
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

/** 返答の終わりのイベント。保存の口が失敗しても、必ず送れる形で返す */
async function doneEvent(
  runner: GuideRunner,
  trip: GuideTrip,
): Promise<GuideSseEventOf<"guide.done">> {
  const phase = tripPhase(trip.itinerary, runner.today());
  try {
    const [notices, pending] = await Promise.all([
      trip.data.notices(),
      pendingProposals(trip.data, trip.itinerary, runner.now()),
    ]);
    return {
      type: "guide.done",
      data: {
        phase,
        unreadNotices: notices.filter((notice) => notice.readAt === null).length,
        pendingProposals: pending.length,
      },
    };
  } catch (error) {
    console.error(
      JSON.stringify({ kind: "storage_failed", what: "guide_done", ...errorForLog(error) }),
    );
    return { type: "guide.done", data: { phase, unreadNotices: 0, pendingProposals: 0 } };
  }
}

/** 相談や旅を開けないときの終わりのイベント。旅が分からないので、数は0で返す */
const NO_TRIP_DONE: GuideSseEventOf<"guide.done"> = {
  type: "guide.done",
  data: { phase: "during", unreadNotices: 0, pendingProposals: 0 },
};

/**
 * 返事を作れないときの緊急の案内。断る代わりに、連絡先と決まった文だけを送る。
 * 連絡先は保存の口を待たずに先に送る。相談の状態には触れない（前の返事を作っている途中でも送れる）。
 * 旅が null なら、ない相談もほかの人の相談も同じ応答になる（あるかどうかを見せない）
 */
function emergencyOnly(c: Context, runner: GuideRunner, trip: GuideTrip | null): Response {
  return streamSSE(c, async (stream) => {
    await stream.writeSSE(encodeGuideSseEvent(emergencyEvent()));
    await stream.writeSSE(
      encodeGuideSseEvent({
        type: "message.delta",
        data: { messageId: randomId("emergency"), text: EMERGENCY_FALLBACK_TEXT },
      }),
    );
    const done = trip === null ? NO_TRIP_DONE : await doneEvent(runner, trip);
    await stream.writeSSE(encodeGuideSseEvent(done));
  });
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

  /** だれの分を数えるか。ログインしていれば保存の口に、していなければメモリに残す */
  const usageLedger = (
    c: Context,
    runner: GuideRunner,
    session: Session,
    tripId: string,
  ): GuideUsageLedger =>
    session.ownerUid === null
      ? anonymousUsage.ledger(limitKey(null, deps.clientIp?.(c) ?? "unknown"), tripId)
      : ownerUsageLedger(deps.persistence, session.ownerUid, tripId, runner.today());

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
    const { message, location } = request.data;
    const { runner } = guide;
    // 緊急の言葉は、モデルを待たず、相談や旅を開けなくても、上限や混雑でも断らずに、公的な連絡先を先に出す
    const emergency = isEmergencyMessage(message);
    let session: Session | undefined;
    let result: GuideTripResult | undefined;
    try {
      session = await open(request.data.sessionId);
      result = session === undefined ? undefined : await openTrip(runner, session);
    } catch (error) {
      if (!emergency) throw error;
      console.error(JSON.stringify({ kind: "guide_emergency_open_failed", ...errorForLog(error) }));
      return emergencyOnly(c, runner, null);
    }
    if (session === undefined || result === undefined) {
      return emergency ? emergencyOnly(c, runner, null) : sessionNotFound(c);
    }
    if (result.status !== "ok") {
      return emergency ? emergencyOnly(c, runner, null) : tripRefusal(c, result);
    }
    const { trip } = result;
    const client = limitKey(viewer, deps.clientIp?.(c) ?? "unknown");
    const ledger = usageLedger(c, runner, session, trip.itinerary.id);
    const usage = await ledger.read().catch((error: unknown) => {
      // 数えられなくても相談は止めない。全体の回数の上限と同時に作る数の上限は効いたまま
      console.error(
        JSON.stringify({ kind: "storage_failed", what: "guide_usage", ...errorForLog(error) }),
      );
      return { user: { turns: 0, costUsd: 0 }, trip: { turns: 0, costUsd: 0 } };
    });
    // ここから返答を始めるまで待たない。同じ相談の2つの発言が、どちらも返事を作り始めないように
    if (session.busy) {
      if (emergency) return emergencyOnly(c, runner, trip);
      return c.json(
        apiError("bad_request", "前の返事を作っています。終わってから送ってください。", true),
        409,
      );
    }
    if (
      overGuideLimit(usage, limits) ||
      !deps.limiter.allows() ||
      deps.clientLimiter?.allows(client) === false
    ) {
      if (emergency) return emergencyOnly(c, runner, trip);
      return c.json(
        apiError(
          "rate_limited",
          "今日のガイドへの相談の受付は終わりました。また明日お越しください。",
          false,
        ),
        429,
      );
    }
    let release = () => {};
    if (runner.mode === "live" && deps.concurrency !== undefined) {
      const acquired = deps.concurrency.tryAcquire(client);
      if (acquired === null) {
        if (emergency) return emergencyOnly(c, runner, trip);
        return c.json(
          apiError(
            "upstream_unavailable",
            "いま混み合っています。少し待ってから、もう一度送ってください。",
            true,
          ),
          503,
        );
      }
      release = acquired;
    }
    deps.limiter.consume();
    deps.clientLimiter?.consume(client);
    const budgetUsd = guideTurnBudgetUsd(usage, limits, runner.maxBudgetUsd);
    // ツールの中の調べは、今日の残りで抑える（調べごとの上限は、それぞれの調べ役が持つ）
    const todayBudgetUsd = guideTurnBudgetUsd(usage, limits, undefined);

    return streamEvents<GuideSseEvent>(
      c,
      session,
      async (signal, emit, progress) => {
        const turn = newGuideTurn();
        const meter = new CostMeter(todayBudgetUsd);
        try {
          if (emergency) emit(emergencyEvent());
          await runner.runTurn(
            {
              session,
              trip,
              message,
              location,
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
          // 緊急の相談では、返事を作れなくても（時間切れも）、失敗の知らせの代わりに決まった文を添える。
          // 利用者が接続を切ったときだけは、届かないので何も送らない
          if (!emergency || isClientClosed(signal)) throw error;
          console.error(
            JSON.stringify({ kind: "guide_emergency_reply_failed", ...errorForLog(error) }),
          );
          emit({
            type: "message.delta",
            data: { messageId: randomId("emergency"), text: EMERGENCY_FALLBACK_TEXT },
          });
        } finally {
          release();
          await settleTurn({ session, trip, runner, ledger, turn, meter, emergency });
          await deps.persistence.saveSession(session);
        }
      },
      turnTiming(deps),
      {
        encode: encodeGuideSseEvent,
        error: (data) => ({ type: "error", data }),
        done: () => doneEvent(runner, trip),
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
