import { FestivalSchema } from "@matsuri-ikoka/schema";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import type { ChatTransport, FestivalSource, OnSseMessage } from "./types";
import { errorCodeForStatus, TransportError } from "./types";

// 接客サーバーとの通信。返答は POST で送りながら SSE で受け取る（docs/spec/api.md）。

const EVENT_STREAM = "text/event-stream";

async function postStream(
  path: string,
  method: "POST" | "PATCH",
  body: unknown,
  onMessage: OnSseMessage,
  signal: AbortSignal,
): Promise<void> {
  await fetchEventSource(path, {
    method,
    headers: { "Content-Type": "application/json", Accept: EVENT_STREAM },
    body: JSON.stringify(body),
    signal,
    // 別のタブに移っても接続を張り直さない（張り直すと、同じ発言をもう一度送ってしまう）
    openWhenHidden: true,
    async onopen(response) {
      if (!response.ok) {
        throw new TransportError(errorCodeForStatus(response.status), response.status);
      }
      if (!response.headers.get("content-type")?.startsWith(EVENT_STREAM)) {
        throw new TransportError("invalid_event", response.status);
      }
    },
    onmessage(message) {
      // 種類のない行（空のコメントで接続を保つ行など）は読み飛ばす
      if (message.event !== "") {
        onMessage({ event: message.event, data: message.data });
      }
    },
    onerror(error) {
      // 自動では再接続しない。会話欄に「もう一度送る」を出す
      throw error instanceof TransportError ? error : new TransportError("connection_lost");
    },
  });
}

export function createServerTransport(): ChatTransport {
  return {
    kind: "server",
    async startSession(signal) {
      const response = await fetch("/api/session", { method: "POST", signal });
      if (!response.ok) {
        throw new TransportError(errorCodeForStatus(response.status), response.status);
      }
      const body: unknown = await response.json();
      if (
        typeof body !== "object" ||
        body === null ||
        !("sessionId" in body) ||
        typeof body.sessionId !== "string"
      ) {
        throw new TransportError("invalid_event", response.status);
      }
      return body.sessionId;
    },
    chat(request, onMessage, signal) {
      return postStream("/api/chat", "POST", request, onMessage, signal);
    },
    updatePreferences(request, onMessage, signal) {
      return postStream("/api/preferences", "PATCH", request, onMessage, signal);
    },
  };
}

/** 祭りのデータを接客サーバーから読む。掲載停止の祭りはサーバーが返さない */
export function createServerFestivalSource(): FestivalSource {
  return {
    async load(id) {
      try {
        const response = await fetch(`/api/festivals/${encodeURIComponent(id)}`);
        if (!response.ok) {
          return null;
        }
        const parsed = FestivalSchema.safeParse(await response.json());
        return parsed.success && !parsed.data.optOut ? parsed.data : null;
      } catch {
        return null;
      }
    },
    async initial() {
      return [];
    },
  };
}
