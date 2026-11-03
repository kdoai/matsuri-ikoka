import {
  encodeSseEvent,
  type RecordedEvent,
  type SampleConversation,
  type SseEventOf,
} from "@matsuri-ikoka/schema";
import type { ChatTransport, OnSseMessage } from "../transport/types";

// テストで使う通信の口の代わり。記録した相談（data/samples/conversations）を、記録した間隔のとおりに
// 再生する。ストアのテストだけが使い、画面のビルドには含めない（画面はいつも接客サーバーと話す）。

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

function abortError(): DOMException {
  return new DOMException("中止しました", "AbortError");
}

export const sleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

export interface ReplayOptions {
  /** 再生の速さ。2 なら記録の倍の速さで流す */
  speed?: number;
  sleep?: Sleep;
}

/**
 * 1つの発言への返答を再生する。各イベントは atMs の時刻に、SSE の1件として渡す。
 * 送る前にスキーマで検証する（接客サーバーと同じ encodeSseEvent を通す）。
 */
export async function replayTurn(
  events: readonly RecordedEvent[],
  onMessage: OnSseMessage,
  signal: AbortSignal,
  { speed = 1, sleep: wait = sleep }: ReplayOptions = {},
): Promise<void> {
  let elapsed = 0;
  for (const { atMs, event } of events) {
    const delay = Math.max(0, atMs - elapsed) / speed;
    elapsed = atMs;
    if (delay > 0) {
      await wait(delay, signal);
    }
    if (signal.aborted) {
      throw abortError();
    }
    onMessage(encodeSseEvent(event));
  }
}

type DoneData = SseEventOf<"done">["data"];

/**
 * 記録した相談を再生する通信の口。何を送っても、記録の次の発言への返答を流す。
 * 記録が終わったあとは、その旨のエラーを返す。
 */
export function createReplayTransport(
  sample: SampleConversation,
  options: ReplayOptions = {},
): ChatTransport {
  let next = 0;
  let lastDone: DoneData | null = null;

  const remember: (onMessage: OnSseMessage) => OnSseMessage = (onMessage) => (message) => {
    if (message.event === "done") {
      lastDone = JSON.parse(message.data) as DoneData;
    }
    onMessage(message);
  };

  return {
    async startSession() {
      next = 0;
      lastDone = null;
      return `replay-${sample.id}`;
    },
    async chat(_request, onMessage, signal) {
      const turn = sample.turns[next];
      if (turn === undefined) {
        await replayTurn(
          [
            {
              atMs: 0,
              event: {
                type: "error",
                data: {
                  code: "bad_request",
                  message:
                    "記録した相談はここまでです。「最初から」で、もう一度はじめから再生できます。",
                  retryable: false,
                },
              },
            },
            ...(lastDone === null
              ? []
              : [{ atMs: 0, event: { type: "done" as const, data: lastDone } }]),
          ],
          onMessage,
          signal,
          options,
        );
        return;
      }
      next += 1;
      await replayTurn(turn.events, remember(onMessage), signal, options);
    },
    async updatePreferences(request, onMessage, signal) {
      // こだわりの切り替えの記録はないので、旅程はそのままにして、こだわりだけを返す
      const data: DoneData = {
        stage: lastDone?.stage ?? "hearing",
        conditions: lastDone?.conditions ?? {},
        preferences: request.preferences,
      };
      await replayTurn(
        [{ atMs: 300, event: { type: "done", data } }],
        remember(onMessage),
        signal,
        options,
      );
    },
  };
}
