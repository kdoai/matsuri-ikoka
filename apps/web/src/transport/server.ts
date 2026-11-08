import {
  type AgentMode,
  AnchorPlanSchema,
  FestivalSchema,
  FestivalSearchResponseSchema,
  type GuideStateResponse,
  GuideStateResponseSchema,
  type SessionRequest,
  SessionResponseSchema,
  type SessionStateResponse,
  SessionStateResponseSchema,
  TripResponseSchema,
} from "@matsuri-ikoka/schema";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import type { ChatTransport, FestivalSource, OnSseMessage } from "./types";
import { errorFromResponse, TransportError } from "./types";

// 接客サーバーとの通信。返答は POST で送りながら SSE で受け取る（docs/spec/api.md）。
// 公開している URL では、/api のすべての呼び出しに合言葉のヘッダーを付ける。合言葉は URL に入れない。
// ログインしていれば、相談の呼び出しに ID トークンを付ける。サーバーは相談をその人に結びつける。

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
  /** ログインしていれば ID トークンを返す。していなければ null。ログイン中に取れなければ例外 */
  idToken?: () => Promise<string | null>;
}

export function createServerTransport(options: ServerTransportOptions = {}): ChatTransport {
  const passcode = options.passcode ?? createPasscodeHolder();
  const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  /**
   * 相談の呼び出しのヘッダー。ログイン中にトークンを取れなければ、送らずに再試行できるエラーにする。
   * ログインなしとして送ると、持ち主のある相談が 404 になり、画面が相談を作り直してしまう
   */
  const consultHeaders = async (): Promise<Record<string, string>> => {
    let token: string | null;
    try {
      token = (await options.idToken?.()) ?? null;
    } catch (error) {
      throw error instanceof TransportError ? error : new TransportError("connection_lost");
    }
    return {
      "Content-Type": "application/json",
      ...authHeaders(passcode),
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
    };
  };

  const postStream = async (
    path: string,
    method: "POST" | "PATCH",
    body: unknown,
    onMessage: OnSseMessage,
    signal: AbortSignal,
    sessionBound = true,
  ): Promise<void> => {
    await fetchEventSource(path, {
      method,
      headers: { ...(await consultHeaders()), Accept: EVENT_STREAM },
      body: JSON.stringify(body),
      signal,
      fetch: fetchImpl,
      // 別のタブに移っても接続を張り直さない（張り直すと、同じ発言をもう一度送ってしまう）
      openWhenHidden: true,
      async onopen(response) {
        if (!response.ok) {
          // SSE を始める前に断られた。本文の code・message・retryable を読む
          throw await errorFromResponse(response, sessionBound);
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
  let mode: AgentMode | null = null;

  /** 相談の続きの応答を読む。404 はない相談（呼ぶ側が状態コードで見分ける） */
  const readSessionState = async (response: Response): Promise<SessionStateResponse> => {
    if (!response.ok) {
      throw await errorFromResponse(response, false);
    }
    const parsed = SessionStateResponseSchema.safeParse(
      await response.json().catch(() => undefined),
    );
    if (!parsed.success) {
      throw new TransportError("invalid_event", { status: response.status });
    }
    mode = parsed.data.mode ?? null;
    return parsed.data;
  };

  return {
    async startSession(signal) {
      const response = await fetchImpl("/api/session", {
        method: "POST",
        headers: await consultHeaders(),
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
      mode = parsed.data.mode ?? null;
      return parsed.data.sessionId;
    },
    async resumeSession(sessionId, signal) {
      const response = await fetchImpl("/api/session/resume", {
        method: "POST",
        headers: await consultHeaders(),
        body: JSON.stringify({ sessionId }),
        ...(signal === undefined ? {} : { signal }),
      });
      return readSessionState(response);
    },
    async resumeSavedTrip(tripId) {
      const response = await fetchImpl(`/api/trips/${encodeURIComponent(tripId)}/resume`, {
        method: "POST",
        headers: await consultHeaders(),
      });
      return readSessionState(response);
    },
    agentMode() {
      return mode;
    },
    chat(request, onMessage, signal) {
      return postStream("/api/chat", "POST", request, onMessage, signal);
    },
    updatePreferences(request, onMessage, signal) {
      return postStream("/api/preferences", "PATCH", request, onMessage, signal);
    },
    async searchFestivals(request, signal) {
      const response = await fetchImpl("/api/festivals/search", {
        method: "POST",
        headers: await consultHeaders(),
        body: JSON.stringify(request),
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) {
        throw await errorFromResponse(response, true);
      }
      const parsed = FestivalSearchResponseSchema.safeParse(
        await response.json().catch(() => undefined),
      );
      if (!parsed.success) {
        throw new TransportError("invalid_event", { status: response.status });
      }
      return parsed.data;
    },
    async previewFestivalTrip(request, signal) {
      const response = await fetchImpl("/api/festival-trips/preview", {
        method: "POST",
        headers: await consultHeaders(),
        body: JSON.stringify(request),
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) {
        // 404 は相談でなく祭りが見つからないとき。本文の一文をそのまま伝える
        throw await errorFromResponse(response, false);
      }
      const parsed = AnchorPlanSchema.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success) {
        throw new TransportError("invalid_event", { status: response.status });
      }
      return parsed.data;
    },
    async guideState(sessionId, signal): Promise<GuideStateResponse> {
      const response = await fetchImpl("/api/guide/state", {
        method: "POST",
        headers: await consultHeaders(),
        body: JSON.stringify({ sessionId }),
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) {
        // 404 はガイドがない環境や、もう話せない相談。呼ぶ側が状態コードで見分ける
        throw await errorFromResponse(response, false);
      }
      const parsed = GuideStateResponseSchema.safeParse(
        await response.json().catch(() => undefined),
      );
      if (!parsed.success) {
        throw new TransportError("invalid_event", { status: response.status });
      }
      return parsed.data;
    },
    guideChat(request, onMessage, signal) {
      return postStream("/api/guide/chat", "POST", request, onMessage, signal, false);
    },
    async markNoticesRead(request) {
      const response = await fetchImpl("/api/guide/notices/read", {
        method: "POST",
        headers: await consultHeaders(),
        body: JSON.stringify(request),
      });
      if (!response.ok) {
        throw await errorFromResponse(response, false);
      }
    },
    async openSavedTrip(tripId) {
      const headers = await consultHeaders();
      const tripResponse = await fetchImpl(`/api/trips/${encodeURIComponent(tripId)}`, { headers });
      if (!tripResponse.ok) {
        throw await errorFromResponse(tripResponse, false);
      }
      const trip = TripResponseSchema.safeParse(await tripResponse.json().catch(() => undefined));
      if (!trip.success || trip.data.itinerary === null) {
        throw new TransportError("invalid_event", { status: tripResponse.status });
      }
      const opened = await fetchImpl("/api/guide/open", {
        method: "POST",
        headers,
        body: JSON.stringify({ tripId }),
      });
      // ガイドを用意していない環境でも、屋台の情報は読めるようにする
      if (opened.status === 404) {
        return { sessionId: null, itinerary: trip.data.itinerary };
      }
      if (!opened.ok) {
        throw await errorFromResponse(opened, false);
      }
      const session = SessionResponseSchema.safeParse(await opened.json().catch(() => undefined));
      if (!session.success) {
        throw new TransportError("invalid_event", { status: opened.status });
      }
      mode = session.data.mode ?? null;
      return { sessionId: session.data.sessionId, itinerary: trip.data.itinerary };
    },
    async checkServer() {
      // 死活監視の口は合言葉が要らない。応答があれば、サーバーは動いている。
      // 公開の URL（Cloud Run の既定の URL）では /healthz が外から届かないので、/health を呼ぶ
      try {
        const response = await fetchImpl("/health", {
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
