import {
  ChatRequestSchema,
  PreferencesRequestSchema,
  SessionRequestSchema,
  type SessionResponse,
} from "@matsuri-ikoka/schema";
import type { Context, Hono } from "hono";
import type { z } from "zod";
import { preferencesLabel } from "../agent/briefing";
import type { AgentRunner } from "../agent/runner";
import type { StoragePersistence } from "../session/persistence";
import type { Session, SessionStore } from "../session/sessionStore";
import { apiError } from "./errors";
import type { ConcurrencyLimiter, DailyLimiter } from "./guard";
import { streamTurn } from "./turnStream";

// 相談の API。返答は SSE（routes/turnStream.ts）で返す。
// SSE を始める前に断るとき（形の誤り・相談が見つからない・返答の途中・回数の上限・混雑）は、
// HTTP の状態コードと error イベントの data と同じ形の JSON で返す。

export interface ChatDeps {
  runner: AgentRunner & { sampleFor?(requested?: string): string | null };
  sessions: SessionStore;
  /** 相談の途中の状態を保存の口に残し、別のインスタンスでも続けられるようにする */
  persistence?: StoragePersistence;
  /** 1日の相談の回数の上限（全体） */
  limiter: DailyLimiter;
  /** 1日の相談の回数の上限（IP ごと） */
  ipLimiter?: DailyLimiter;
  /** live で同時に返事を作る数の上限 */
  concurrency?: ConcurrencyLimiter;
  /** 利用者の IP を決める関数（前に置いたプロキシの数で変わる） */
  clientIp?: (c: Context) => string;
  /** 進みのない時間の上限（ミリ秒） */
  turnIdleMs?: number;
  /** 相談1回の全体の上限（ミリ秒） */
  turnMaxMs?: number;
  heartbeatMs?: number;
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
 * 相談を引き、返答を作れる状態か確かめる。だめならエラーの Response を返す。
 * 通れば、回数を1回分使い、live なら同時に返事を作る枠を1つ取る（release で返す）
 */
function openSession(
  c: Context,
  deps: ChatDeps,
  sessionId: string,
): { session: Session; release: () => void } | Response {
  const session = deps.sessions.get(sessionId);
  if (session === undefined) {
    return c.json(
      apiError("bad_request", "相談が見つかりません。新しく始めてください。", false),
      404,
    );
  }
  if (session.busy) {
    return c.json(
      apiError("bad_request", "前の返事を作っています。終わってから送ってください。", true),
      409,
    );
  }
  const ip = deps.clientIp?.(c) ?? "unknown";
  if (!deps.limiter.allows() || (deps.ipLimiter !== undefined && !deps.ipLimiter.allows(ip))) {
    return c.json(
      apiError("rate_limited", "今日の相談の受付は終わりました。また明日お越しください。", false),
      429,
    );
  }
  let release = () => {};
  if (deps.runner.mode === "live" && deps.concurrency !== undefined) {
    const acquired = deps.concurrency.tryAcquire();
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
  deps.limiter.consume();
  deps.ipLimiter?.consume(ip);
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

function persistOf(deps: ChatDeps, session: Session): () => Promise<void> {
  return async () => {
    await deps.persistence?.saveSession(session);
  };
}

export function registerChatRoutes(app: Hono, deps: ChatDeps) {
  const timing = {
    ...(deps.turnIdleMs === undefined ? {} : { idleMs: deps.turnIdleMs }),
    ...(deps.turnMaxMs === undefined ? {} : { maxMs: deps.turnMaxMs }),
    ...(deps.heartbeatMs === undefined ? {} : { heartbeatMs: deps.heartbeatMs }),
  };

  app.post("/api/session", async (c) => {
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
    const session = deps.sessions.create({ replay });
    await deps.persistence?.saveSession(session);
    return c.json({ sessionId: session.id } satisfies SessionResponse, 201);
  });

  app.post("/api/chat", async (c) => {
    let request: z.infer<typeof ChatRequestSchema>;
    try {
      request = ChatRequestSchema.parse(await readJson(c));
    } catch {
      return badRequest(c);
    }
    // 別のインスタンスで始めた相談なら、保存の口から戻す
    await deps.persistence?.load(request.sessionId);
    const opened = openSession(c, deps, request.sessionId);
    if (opened instanceof Response) return opened;
    const { session, release } = opened;
    // 画面で選んでいるこだわりを正とする。会話で切り替わったら、ツールが相談の状態を書き換える
    session.preferences = request.preferences;
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
              signal,
              progress,
            },
            emit,
          ),
        persistOf(deps, session),
      ),
      timing,
    );
  });

  app.patch("/api/preferences", async (c) => {
    let request: z.infer<typeof PreferencesRequestSchema>;
    try {
      request = PreferencesRequestSchema.parse(await readJson(c));
    } catch {
      return badRequest(c);
    }
    await deps.persistence?.load(request.sessionId);
    const existing = deps.sessions.get(request.sessionId);
    // 旅程があるときだけ旅程係を動かす。記録の再生（mock）では、こだわりを変えるだけにする
    const replan = existing?.itineraryId != null && deps.runner.mode === "live";
    if (!replan) {
      if (existing === undefined) {
        return c.json(
          apiError("bad_request", "相談が見つかりません。新しく始めてください。", false),
          404,
        );
      }
      if (existing.busy) {
        return c.json(
          apiError("bad_request", "前の返事を作っています。終わってから送ってください。", true),
          409,
        );
      }
      existing.preferences = request.preferences;
      await deps.persistence?.saveSession(existing);
      return streamTurn(c, existing, async () => {}, timing);
    }
    const opened = openSession(c, deps, request.sessionId);
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
