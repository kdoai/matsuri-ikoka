import { encodeSseEvent, type SseEvent } from "@matsuri-ikoka/schema";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { AgentError, type EmitEvent } from "../agent/runner";
import type { Session } from "../session/sessionStore";
import type { ErrorBody } from "./errors";

// 1つの発言への返答を、1本の SSE で返す。
// - 各イベントは送る前にスキーマで検証する（encodeSseEvent）
// - 15秒ごとに空のコメント行を送り、途中で接続が切られないようにする
// - 進みのない時間（イベントもエージェントの動きもない時間）が上限を超えたら止め、途中までの結果のあとに timeout を送る。
//   動き続けている相談は止めないが、全体の上限は別に持つ
// - 最後に必ず done を1回送って閉じる

/** 進みのない時間の上限 */
export const TURN_IDLE_MS = 90_000;
/** 相談1回の全体の上限。進みがあっても、これを超えたら止める */
export const TURN_MAX_MS = 360_000;
export const HEARTBEAT_MS = 15_000;

export class TurnTimeoutError extends Error {}
class ClientClosedError extends Error {}

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
  console.error("[turn] failed", error);
  return {
    code: "internal",
    message: "うまく返事を作れませんでした。もう一度送ってください。",
    retryable: true,
  };
}

export function doneEvent(session: Session): SseEvent {
  return {
    type: "done",
    data: {
      stage: session.stage,
      conditions: session.conditions,
      preferences: session.preferences,
    },
  };
}

export function streamTurn(
  c: Context,
  session: Session,
  run: (signal: AbortSignal, emit: EmitEvent, progress: () => void) => Promise<void>,
  options: { idleMs?: number; maxMs?: number; heartbeatMs?: number } = {},
): Response {
  session.busy = true;
  return streamSSE(c, async (stream) => {
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
    const emit: EmitEvent = (event) => {
      let message: ReturnType<typeof encodeSseEvent>;
      try {
        message = encodeSseEvent(event);
      } catch (error) {
        // 形の違うイベントは送らない（画面のストアを壊さない）
        console.error(`[sse] invalid ${event.type} event`, error);
        return;
      }
      progress();
      write(() => stream.writeSSE(message));
    };

    try {
      await run(controller.signal, emit, progress);
    } catch (error) {
      const body = toErrorBody(error, controller.signal);
      if (body !== null) emit({ type: "error", data: body });
    } finally {
      clearTimeout(idle);
      clearTimeout(overall);
      clearInterval(heartbeat);
      emit(doneEvent(session));
      await writes;
      session.busy = false;
    }
  });
}
