import {
  DoneEventSchema,
  encodeSseEvent,
  type SseEvent,
  type SseMessage,
} from "@matsuri-ikoka/schema";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { AgentError, type EmitEvent } from "../agent/runner";
import { errorForLog } from "../log";
import type { Session } from "../session/sessionStore";
import type { ErrorBody } from "./errors";

// 1つの発言への返答を、1本の SSE で返す。
// - 各イベントは送る前にスキーマで検証する（encodeSseEvent）
// - 15秒ごとに空のコメント行を送り、途中で接続が切られないようにする
// - 進みのない時間（イベントもエージェントの動きもない時間）が上限を超えたら止め、途中までの結果のあとに timeout を送る。
//   動き続けている相談は止めないが、全体の上限は別に持つ
// - 最後に必ず done を1回送って閉じる。相談の状態が done の形に合わなくても、done は落とさない
// - 閉じたら、どう終わったか（done・error・timeout・利用者が切った）をログに1行残す。会話の本文は残さない

/** 進みのない時間の上限 */
export const TURN_IDLE_MS = 90_000;
/** 相談1回の全体の上限。進みがあっても、これを超えたら止める */
export const TURN_MAX_MS = 360_000;
export const HEARTBEAT_MS = 15_000;

export class TurnTimeoutError extends Error {}
class ClientClosedError extends Error {}

/** 返答の終わり方。client_closed は、done を送る前に利用者の側から接続が切れた */
export type TurnEnding = "done" | "error" | "timeout" | "client_closed";

/** 利用者の側から接続が切れて止まったか（時間切れで止まったときは false） */
export function isClientClosed(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason instanceof ClientClosedError;
}

/** 返答の終わり方を決める（ログに残す） */
export function turnEnding(signal: AbortSignal, errorBody: ErrorBody | null): TurnEnding {
  if (signal.aborted && signal.reason instanceof ClientClosedError) return "client_closed";
  if (errorBody?.code === "timeout") return "timeout";
  return errorBody === null ? "done" : "error";
}

/** 失敗を、利用者に見せる error イベントの中身にする。利用者が接続を切ったときは null */
export function toErrorBody(error: unknown, signal: AbortSignal): ErrorBody | null {
  if (signal.aborted && signal.reason instanceof ClientClosedError) return null;
  if (signal.aborted && signal.reason instanceof TurnTimeoutError) {
    return {
      code: "timeout",
      message: "時間がかかりすぎたので、ここで止めました。もう一度送ってください。",
      retryable: true,
    };
  }
  if (error instanceof AgentError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  console.error(JSON.stringify({ kind: "turn_failed", ...errorForLog(error) }));
  return {
    code: "internal",
    message: "うまく返事を作れませんでした。もう一度送ってください。",
    retryable: true,
  };
}

export function doneEvent(session: Session): SseEvent {
  const event: SseEvent = {
    type: "done",
    data: {
      stage: session.stage,
      conditions: session.conditions,
      preferences: session.preferences,
    },
  };
  if (DoneEventSchema.safeParse(event).success) return event;
  // done が届かないと、画面は接続が切れたと受け取る。読み取れた条件は送らず、会話の状態だけを返す
  console.error("[sse] done の形が正しくないので、条件を空にして送ります", {
    stage: session.stage,
  });
  return {
    type: "done",
    data: { stage: session.stage, conditions: {}, preferences: session.preferences },
  };
}

export interface TurnTiming {
  idleMs?: number;
  maxMs?: number;
  heartbeatMs?: number;
}

/** イベントの種類（店内の相談・ガイド）ごとの、SSE の作り方 */
export interface TurnEvents<E extends { type: string }> {
  /** 送る前に検証する。形が違えば例外を投げる */
  encode(event: E): SseMessage;
  error(body: ErrorBody): E;
  /** 最後に必ず送るイベント。失敗で落とさない */
  done(): E | Promise<E>;
  /** 失敗を送る前に、それまでに送ったイベントの種類を見て、文を変える */
  adjustError?(body: ErrorBody, sent: ReadonlySet<string>): ErrorBody;
}

/** 店内の相談の SSE。done は相談の状態から作る */
export function streamTurn(
  c: Context,
  session: Session,
  run: (signal: AbortSignal, emit: EmitEvent, progress: () => void) => Promise<void>,
  options: TurnTiming = {},
): Response {
  return streamEvents<SseEvent>(c, session, run, options, {
    encode: encodeSseEvent,
    error: (data) => ({ type: "error", data }),
    done: () => doneEvent(session),
    adjustError: (body, sent) =>
      // 旅程の案は届いているので、送り直しを求めず、案を見てもらう
      body.code === "timeout" && sent.has("itinerary.updated")
        ? {
            ...body,
            retryable: false,
            message:
              "旅程の案はできています。説明の途中で時間がかかったので、ここで止めました。変えたいところがあれば教えてください。",
          }
        : body,
  });
}

export function streamEvents<E extends { type: string }>(
  c: Context,
  session: Session,
  run: (signal: AbortSignal, emit: (event: E) => void, progress: () => void) => Promise<void>,
  options: TurnTiming,
  kinds: TurnEvents<E>,
): Response {
  session.busy = true;
  return streamSSE(c, async (stream) => {
    const started = Date.now();
    let events = 0;
    const sent = new Set<string>();
    const controller = new AbortController();
    const timeout = () => controller.abort(new TurnTimeoutError());
    const idleMs = options.idleMs ?? TURN_IDLE_MS;
    let idle = setTimeout(timeout, idleMs);
    const overall = setTimeout(timeout, options.maxMs ?? TURN_MAX_MS);
    /** 進みがあった。進みのない時間を数え直す */
    const progress = () => {
      if (controller.signal.aborted) return;
      clearTimeout(idle);
      idle = setTimeout(timeout, idleMs);
    };
    stream.onAbort(() => controller.abort(new ClientClosedError()));
    let writes = Promise.resolve();
    const write = (task: () => Promise<unknown>) => {
      writes = writes.then(task).then(
        () => undefined,
        () => undefined,
      );
    };
    const heartbeat = setInterval(
      () => write(() => stream.write(": keep-alive\n\n")),
      options.heartbeatMs ?? HEARTBEAT_MS,
    );
    const emit = (event: E): boolean => {
      let message: SseMessage;
      try {
        message = kinds.encode(event);
      } catch (error) {
        // 形の違うイベントは送らない（画面のストアを壊さない）
        console.error(
          JSON.stringify({ kind: "sse_invalid", event: event.type, ...errorForLog(error) }),
        );
        return false;
      }
      progress();
      events += 1;
      sent.add(event.type);
      write(() => stream.writeSSE(message));
      return true;
    };

    let errorBody: ErrorBody | null = null;
    try {
      await run(controller.signal, emit, progress);
    } catch (error) {
      errorBody = toErrorBody(error, controller.signal);
      if (errorBody !== null) {
        errorBody = kinds.adjustError?.(errorBody, sent) ?? errorBody;
        emit(kinds.error(errorBody));
      }
    } finally {
      clearTimeout(idle);
      clearTimeout(overall);
      clearInterval(heartbeat);
      // done を送れないと、画面は「接続が切れた」と受け取る。送れなかったこともログに残す
      const doneSent = emit(await kinds.done());
      await writes;
      session.busy = false;
      console.info(
        JSON.stringify({
          kind: "turn_end",
          ending: turnEnding(controller.signal, errorBody),
          ...(errorBody === null ? {} : { code: errorBody.code }),
          doneSent,
          events,
          durationMs: Date.now() - started,
        }),
      );
    }
  });
}
