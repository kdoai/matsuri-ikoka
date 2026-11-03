import { FestivalSchema, type SessionRequest, SessionResponseSchema } from "@matsuri-ikoka/schema";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import type { ChatTransport, FestivalSource, OnSseMessage } from "./types";
import { errorFromResponse, TransportError } from "./types";

// 接客サーバーとの通信。返答は POST で送りながら SSE で受け取る（docs/spec/api.md）。
// 公開している URL では、/api のすべての呼び出しに合言葉のヘッダーを付ける。合言葉は URL に入れない。

const EVENT_STREAM = "text/event-stream";

/** 接続が切れたあとに、サーバーが応答するかを確かめるときの待ち時間 */
export const SERVER_CHECK_TIMEOUT_MS = 3000;

/** 合言葉を送るヘッダー（接客サーバーの routes/guard.ts と同じ名前） */
export const PASSCODE_HEADER = "x-access-passcode";

/** HTTP のヘッダーで送れる合言葉か（半角の英数字と記号だけ） */
export function isSendablePasscode(value: string): boolean {
  return /^[!-~]+$/.test(value);
}

/** 合言葉をメモリにだけ持つ。通信の口と祭りのデータの読み込み口で共有する */
export interface PasscodeHolder {
  get(): string | null;
  set(passcode: string): void;
}

export function createPasscodeHolder(): PasscodeHolder {
  let passcode: string | null = null;
  return {
    get: () => passcode,
    set(value) {
      passcode = value === "" ? null : value;
    },
  };
}

function authHeaders(passcode: PasscodeHolder): Record<string, string> {
  const value = passcode.get();
  return value === null ? {} : { [PASSCODE_HEADER]: value };
}

export interface ServerTransportOptions {
  passcode?: PasscodeHolder;
  /** 接客サーバーが記録の再生（mock）で動いているとき、再生する記録の名前 */
  sample?: string | null;
  fetch?: typeof fetch;
}

export function createServerTransport(options: ServerTransportOptions = {}): ChatTransport {
  const passcode = options.passcode ?? createPasscodeHolder();
  const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  const postStream = async (
    path: string,
    method: "POST" | "PATCH",
    body: unknown,
    onMessage: OnSseMessage,
    signal: AbortSignal,
  ): Promise<void> => {
    await fetchEventSource(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: EVENT_STREAM,
        ...authHeaders(passcode),
      },
      body: JSON.stringify(body),
      signal,
      fetch: fetchImpl,
      // 別のタブに移っても接続を張り直さない（張り直すと、同じ発言をもう一度送ってしまう）
      openWhenHidden: true,
      async onopen(response) {
        if (!response.ok) {
          // SSE を始める前に断られた。本文の code・message・retryable を読む
          throw await errorFromResponse(response, true);
        }
        if (!response.headers.get("content-type")?.startsWith(EVENT_STREAM)) {
          throw new TransportError("invalid_event", { status: response.status });
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
  };

  const sessionRequest: SessionRequest = options.sample ? { sample: options.sample } : {};

  return {
    async startSession(signal) {
      const response = await fetchImpl("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(passcode) },
        body: JSON.stringify(sessionRequest),
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) {
        throw await errorFromResponse(response, false);
      }
      const parsed = SessionResponseSchema.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success) {
        throw new TransportError("invalid_event", { status: response.status });
      }
      return parsed.data.sessionId;
    },
    chat(request, onMessage, signal) {
      return postStream("/api/chat", "POST", request, onMessage, signal);
    },
    updatePreferences(request, onMessage, signal) {
      return postStream("/api/preferences", "PATCH", request, onMessage, signal);
    },
    async checkServer() {
      // 死活監視の口は合言葉が要らない。応答があれば、サーバーは動いている
      try {
        const response = await fetchImpl("/healthz", {
          signal: AbortSignal.timeout(SERVER_CHECK_TIMEOUT_MS),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
    setPasscode(value) {
      passcode.set(value);
    },
    hasPasscode() {
      return passcode.get() !== null;
    },
  };
}

/** 祭りのデータを接客サーバーから読む。掲載停止・見つからない祭りは 404 で、null を返す */
export function createServerFestivalSource(
  options: { passcode?: PasscodeHolder; fetch?: typeof fetch } = {},
): FestivalSource {
  const passcode = options.passcode ?? createPasscodeHolder();
  const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  return {
    async load(id) {
      try {
        const response = await fetchImpl(`/api/festivals/${encodeURIComponent(id)}`, {
          headers: authHeaders(passcode),
        });
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
      // 待ち時間の豆知識に使う祭り。一覧の経路（GET /api/festivals）がないサーバーでは空のまま
      try {
        const response = await fetchImpl("/api/festivals", { headers: authHeaders(passcode) });
        if (!response.ok) {
          return [];
        }
        const body: unknown = await response.json();
        const list = Array.isArray(body)
          ? body
          : typeof body === "object" && body !== null && "festivals" in body
            ? (body as { festivals: unknown }).festivals
            : [];
        if (!Array.isArray(list)) {
          return [];
        }
        return list.flatMap((item) => {
          const parsed = FestivalSchema.safeParse(item);
          return parsed.success && !parsed.data.optOut ? [parsed.data] : [];
        });
      } catch {
        return [];
      }
    },
  };
}
