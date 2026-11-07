import {
  ChatRequestSchema,
  PreferencesRequestSchema,
  SessionRequestSchema,
  type SessionResponse,
  type TripAnchor,
} from "@matsuri-ikoka/schema";
import type { Context } from "hono";
import type { z } from "zod";
import { preferencesLabel } from "../agent/briefing";
import type { AgentRunner } from "../agent/runner";
import type { FestivalStore } from "../data/festivalStore";
import { refreshAnchorPlan, refuseAnchor } from "../domain/anchorPlan";
import { todayInJapan } from "../domain/calendar";
import type { StationPointIndex } from "../domain/travelEstimate";
import type { Consultations } from "../session/consultations";
import type { StoragePersistence } from "../session/persistence";
import type { Session } from "../session/sessionStore";
import type { OwnerId } from "../storage/owner";
import { apiError } from "./errors";
import { type ConcurrencyLimiter, type DailyLimiter, turnQuota } from "./guard";
import type { SecureRoutes } from "./policy";
import { streamTurn } from "./turnStream";

// 相談の API。返答は SSE（routes/turnStream.ts）で返す。
// SSE を始める前に断るとき（形の誤り・相談が見つからない・返答の途中・回数の上限・混雑）は、
// HTTP の状態コードと error イベントの data と同じ形の JSON で返す。

export interface ChatOptions {
  runner: AgentRunner & { sampleFor?(requested?: string): string | null };
  /** 祭りのデータ。祭りを固定するときに、祭りと日を確かめる */
  festivals: FestivalStore;
  /** 駅の位置。祭りを固定した旅の組み立てで、移動を見積もる */
  stations?: StationPointIndex;
  /** 今日の日付。省略すると日本の今日 */
  today?: () => string;
  /** 1日の相談の回数の上限（全体） */
  limiter: DailyLimiter;
  /** 1日の相談の回数の上限（IP ごとと、ログインしていれば利用者ごと） */
  clientLimiter?: DailyLimiter;
  /** 1日に相談を始められる回数の上限（IP ごと）。なければ数えない */
  sessionLimiter?: DailyLimiter;
  /** お試し用のアカウントの、1日の相談の回数の上限（全体）。なければ全体の枠で数える */
  trialLimiter?: DailyLimiter;
  /** live で同時に返事を作る数の上限（全体と、利用者ごと） */
  concurrency?: ConcurrencyLimiter;
  /** 利用者の IP を決める関数（前に置いたプロキシの数で変わる） */
  clientIp?: (c: Context) => string;
  /** 進みのない時間の上限（ミリ秒） */
  turnIdleMs?: number;
  /** 相談1回の全体の上限（ミリ秒） */
  turnMaxMs?: number;
  heartbeatMs?: number;
}

export interface ChatDeps extends ChatOptions {
  /** 相談の入口。相談はここからだけ受け取る */
  consultations: Consultations;
  /** 相談の途中の状態を保存の口に残し、別のインスタンスでも続けられるようにする */
  persistence: StoragePersistence;
}

/** ない相談も、ほかの人の相談も、同じ応答で断る（あるかどうかを見せない） */
function sessionNotFound(c: Context) {
  return c.json(
    apiError("bad_request", "相談が見つかりません。新しく始めてください。", false),
    404,
  );
}

async function readJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === "") return undefined;
  return JSON.parse(text);
}

function badRequest(c: Context, message = "送った内容の形が正しくありません。") {
  return c.json(apiError("bad_request", message, false), 400);
}

/**
 * 開いた相談が返答を作れる状態か確かめる。だめならエラーの Response を返す。
 * 通れば、回数を1回分使い、live なら同時に返事を作る枠を1つ取る（release で返す）
 */
function reserveTurn(
  c: Context,
  deps: ChatDeps,
  session: Session | undefined,
  viewer: OwnerId | null,
): { session: Session; release: () => void } | Response {
  if (session === undefined) return sessionNotFound(c);
  if (session.busy) {
    return c.json(
      apiError("bad_request", "前の返事を作っています。終わってから送ってください。", true),
      409,
    );
  }
  const quota = turnQuota(deps, viewer, deps.clientIp?.(c) ?? "unknown");
  if (!quota.allows()) {
    return c.json(
      apiError("rate_limited", "今日の相談の受付は終わりました。また明日お越しください。", false),
      429,
    );
  }
  let release = () => {};
  if (deps.runner.mode === "live" && deps.concurrency !== undefined) {
    const acquired = deps.concurrency.tryAcquire(quota.client);
    if (acquired === null) {
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
  quota.consume();
  return { session, release };
}

/**
 * 返事を作り終えたら（失敗・時間切れでも）、同時に返事を作る枠を返し、相談の途中の状態を残す
 */
function releasing(
  release: () => void,
  run: Parameters<typeof streamTurn>[2],
  persist: () => Promise<void> = async () => {},
): Parameters<typeof streamTurn>[2] {
  return async (signal, emit, progress) => {
    try {
      await run(signal, emit, progress);
    } finally {
      release();
      await persist();
    }
  };
}

export const todayOf = (deps: Pick<ChatDeps, "today">): string => deps.today?.() ?? todayInJapan();

/** 過ぎた日のアンカーを断るための今日。記録の再生は日付が記録のまま動かないので断らない */
export const pastCheckDay = (deps: Pick<ChatDeps, "today" | "runner">): string | null =>
  deps.runner.mode === "mock" ? null : todayOf(deps);

/** 相談に必ず行く祭りを残す。祭りか日が変われば、開催の確かめからやり直す */
function fixAnchor(session: Session, anchor: TripAnchor): void {
  const same =
    session.anchor?.festivalId === anchor.festivalId && session.anchor.date === anchor.date;
  if (!same) session.anchorCheck = null;
  session.anchor = anchor;
  session.selectedFestivalId = anchor.festivalId;
  session.cancelledAnchor = null;
}

function persistOf(deps: ChatDeps, session: Session): () => Promise<void> {
  return async () => {
    await deps.persistence.saveSession(session);
  };
}

export function registerChatRoutes(routes: SecureRoutes, deps: ChatDeps) {
  const timing = {
    ...(deps.turnIdleMs === undefined ? {} : { idleMs: deps.turnIdleMs }),
    ...(deps.turnMaxMs === undefined ? {} : { maxMs: deps.turnMaxMs }),
    ...(deps.heartbeatMs === undefined ? {} : { heartbeatMs: deps.heartbeatMs }),
  };

  // だれでも相談を始められる。ログインしていれば、はじめからその人の相談にする
  routes.public("POST", "/api/session", async (c, { viewer }) => {
    let body: z.infer<typeof SessionRequestSchema>;
    try {
      // 本文は省略できる
      body = SessionRequestSchema.parse((await readJson(c)) ?? {});
    } catch {
      return badRequest(c);
    }
    let replay: Session["replay"] = null;
    if (deps.runner.mode === "mock") {
      const sampleId = deps.runner.sampleFor?.(body.sample) ?? null;
      if (sampleId === null) return badRequest(c, "そのサンプルの相談はありません。");
      replay = { sampleId, nextTurn: 0 };
    }
    // 始めた相談はメモリと保存の口に残るので、IP ごとに回数を抑える
    if (deps.sessionLimiter?.consume(deps.clientIp?.(c) ?? "unknown") === false) {
      return c.json(
        apiError(
          "rate_limited",
          "今日はこれ以上、新しい相談を始められません。また明日お越しください。",
          false,
        ),
        429,
      );
    }
    const session = await deps.consultations.start(await viewer(), replay);
    return c.json({ sessionId: session.id, mode: deps.runner.mode } satisfies SessionResponse, 201);
  });

  routes.consultation("POST", "/api/chat", async (c, { viewer, open }) => {
    let request: z.infer<typeof ChatRequestSchema>;
    try {
      request = ChatRequestSchema.parse(await readJson(c));
    } catch {
      return badRequest(c);
    }
    // 別のインスタンスで始めた相談なら、保存の口から戻す
    const found = await open(request.sessionId);
    if (found !== undefined && !found.busy) await deps.persistence.releaseDeletedTrip(found);
    const { anchor } = request;
    if (anchor !== undefined) {
      const refusal = refuseAnchor(
        deps.festivals.get(anchor.festivalId),
        anchor.date,
        pastCheckDay(deps),
      );
      if (refusal !== null) {
        return c.json(apiError("bad_request", refusal.message, false), refusal.status);
      }
    }
    const opened = reserveTurn(c, deps, found, viewer);
    if (opened instanceof Response) return opened;
    const { session, release } = opened;
    // 流し始める前に失敗しても、同時に返事を作る枠を返す（流し始めたら、終わったときに返す）
    try {
      // 画面で選んでいるこだわりを正とする。会話で切り替わったら、ツールが相談の状態を書き換える
      session.preferences = request.preferences;
      // 次の手（ボタン）から探し直すときは、変えた条件を先に書き留める（コンシェルジュの要約にも出す）
      const retry = request.search;
      if (retry !== undefined) {
        session.conditions = {
          ...session.conditions,
          ...(retry.when === undefined ? {} : { when: retry.when }),
          ...(retry.nights === undefined ? {} : { nights: retry.nights }),
          ...(retry.maxTravelMinutes === undefined
            ? {}
            : { maxTravelMinutes: retry.maxTravelMinutes }),
        };
      }
      // 祭りを固定する。送られなかった発言でも、固定は相談の状態に残っている
      if (anchor !== undefined) fixAnchor(session, anchor);
      if (session.anchor !== null) {
        refreshAnchorPlan(session, {
          festival: deps.festivals.get(session.anchor.festivalId),
          stations: deps.stations,
          today: todayOf(deps),
        });
      }
      return streamTurn(
        c,
        session,
        releasing(
          release,
          (signal, emit, progress) =>
            deps.runner.runTurn(
              {
                session,
                message: request.message,
                preferences: request.preferences,
                ...(retry === undefined ? {} : { searchRetry: retry }),
                signal,
                progress,
              },
              emit,
            ),
          persistOf(deps, session),
        ),
        timing,
      );
    } catch (error) {
      release();
      throw error;
    }
  });

  routes.consultation("PATCH", "/api/preferences", async (c, { viewer, open }) => {
    let request: z.infer<typeof PreferencesRequestSchema>;
    try {
      request = PreferencesRequestSchema.parse(await readJson(c));
    } catch {
      return badRequest(c);
    }
    const existing = await open(request.sessionId);
    if (existing !== undefined && !existing.busy) {
      await deps.persistence.releaseDeletedTrip(existing);
    }
    // 旅程があるときだけ旅程係を動かす。記録の再生（mock）では、こだわりを変えるだけにする
    const replan = existing?.itineraryId != null && deps.runner.mode === "live";
    if (!replan) {
      if (existing === undefined) return sessionNotFound(c);
      if (existing.busy) {
        return c.json(
          apiError("bad_request", "前の返事を作っています。終わってから送ってください。", true),
          409,
        );
      }
      existing.preferences = request.preferences;
      await deps.persistence.saveSession(existing);
      return streamTurn(c, existing, async () => {}, timing);
    }
    const opened = reserveTurn(c, deps, existing, viewer);
    if (opened instanceof Response) return opened;
    const { session, release } = opened;
    session.preferences = request.preferences;
    const message = `画面でこだわりを「${preferencesLabel(request.preferences)}」に切り替えました。旅程係にだけ頼んで、この切り替えに合わせて旅程を組み直してください。`;
    return streamTurn(
      c,
      session,
      releasing(
        release,
        (signal, emit, progress) =>
          deps.runner.runTurn(
            { session, message, preferences: request.preferences, signal, progress },
            emit,
          ),
        persistOf(deps, session),
      ),
      timing,
    );
  });
}
