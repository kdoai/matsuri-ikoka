import { DEFAULT_PREFERENCES, FestivalSchema } from "@matsuri-ikoka/schema";
import { fictionalFestival } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it, vi } from "vitest";
import {
  createPasscodeHolder,
  createServerFestivalSource,
  createServerTransport,
  isSendablePasscode,
  PASSCODE_HEADER,
} from "./server";
import { errorFromResponse, TransportError, toClientError } from "./types";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

describe("SSE の前に断られたときの応答", () => {
  it("本文の code・message・retryable を読む", async () => {
    const error = await errorFromResponse(
      json({ code: "bad_request", message: "前の返事を作っています。", retryable: true }, 409),
      true,
    );
    expect(error).toMatchObject({
      code: "bad_request",
      status: 409,
      serverMessage: "前の返事を作っています。",
      retryable: true,
    });
  });

  it("相談に結びついた呼び出しの 404 は、相談が見つからない（新しく始める）", async () => {
    const response = json(
      { code: "bad_request", message: "相談が見つかりません。", retryable: false },
      404,
    );
    expect(await errorFromResponse(response, true)).toMatchObject({
      code: "session_lost",
      retryable: true,
    });
  });

  it("本文が読めなければ、状態コードから決める", async () => {
    expect(await errorFromResponse(new Response("too large", { status: 413 }), true)).toMatchObject(
      { code: "bad_request", serverMessage: null },
    );
    expect(await errorFromResponse(new Response("", { status: 401 }), false)).toMatchObject({
      code: "unauthorized",
    });
  });

  it("サーバーが送り直せるかを送らなければ、種類ごとの既定を使う", () => {
    expect(toClientError(new TransportError("timeout"))).toEqual({
      code: "timeout",
      message: null,
      retryable: true,
    });
    expect(toClientError(new Error("network"))).toMatchObject({ code: "connection_lost" });
  });
});

describe("合言葉の形", () => {
  it("ヘッダーで送れる半角の英数字と記号だけを受け付ける", () => {
    expect(isSendablePasscode("matsuri-2026!")).toBe(true);
    expect(isSendablePasscode("まつり")).toBe(false);
    expect(isSendablePasscode("ｍａｔｓｕｒｉ")).toBe(false);
    expect(isSendablePasscode("two words")).toBe(false);
    expect(isSendablePasscode("")).toBe(false);
  });
});

describe("相談の呼び出しの ID トークン", () => {
  const session = async () => json({ sessionId: "s-1" }, 201);

  it("ログインしていれば、相談の呼び出しに ID トークンを付ける", async () => {
    const fetchMock = vi.fn<typeof fetch>(session);
    const transport = createServerTransport({
      fetch: fetchMock,
      idToken: async () => "id-token",
    });

    await transport.startSession();
    await transport
      .searchFestivals({
        sessionId: "s-1",
        kinds: [],
        season: null,
        prefectures: [],
        excludeIds: [],
      })
      .catch(() => {});

    for (const call of fetchMock.mock.calls) {
      expect(headerOf(call[1], "authorization")).toBe("Bearer id-token");
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ログインしていないときは、付けずに送る", async () => {
    const fetchMock = vi.fn<typeof fetch>(session);

    await createServerTransport({ fetch: fetchMock }).startSession();
    await createServerTransport({ fetch: fetchMock, idToken: async () => null }).startSession();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(headerOf(call[1], "authorization")).toBeNull();
    }
  });

  describe("ログイン中にトークンを取れないとき", () => {
    const failing = (fetchMock: typeof fetch) =>
      createServerTransport({
        fetch: fetchMock,
        idToken: () => Promise.reject(new Error("つながらない")),
      });
    const retryable = { code: "connection_lost" };

    it("相談の呼び出しを送らず、再試行できるエラーにする", async () => {
      const fetchMock = vi.fn<typeof fetch>(session);
      const transport = failing(fetchMock);
      const signal = new AbortController().signal;
      const preferences = DEFAULT_PREFERENCES;

      await expect(transport.startSession()).rejects.toMatchObject(retryable);
      await expect(
        transport.chat({ sessionId: "s-1", message: "やあ", preferences }, () => {}, signal),
      ).rejects.toMatchObject(retryable);
      await expect(
        transport.updatePreferences({ sessionId: "s-1", preferences }, () => {}, signal),
      ).rejects.toMatchObject(retryable);
      await expect(
        transport.searchFestivals({
          sessionId: "s-1",
          kinds: [],
          season: null,
          prefectures: [],
          excludeIds: [],
        }),
      ).rejects.toMatchObject(retryable);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("相談が切れたものとして扱わない（画面は相談を作り直さない）", async () => {
      const error = await failing(vi.fn<typeof fetch>(session))
        .startSession()
        .catch((caught) => caught);

      expect(toClientError(error)).toMatchObject({ code: "connection_lost", retryable: true });
    });
  });

  it("祭りのデータと死活監視には付けない", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json({ status: "ok" }, 200));
    const transport = createServerTransport({
      fetch: fetchMock,
      idToken: async () => "id-token",
    });

    await transport.checkServer?.();

    expect(headerOf(fetchMock.mock.calls[0]?.[1], "authorization")).toBeNull();
  });
});

describe("接客サーバーとの通信", () => {
  it("合言葉を入れたら、相談を始める呼び出しにヘッダーで付け、記録の名前を本文で送る", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json({ sessionId: "s-1" }, 201));
    const passcode = createPasscodeHolder();
    const transport = createServerTransport({
      passcode,
      sample: "fictional-trip",
      fetch: fetchMock,
    });

    expect(transport.hasPasscode?.()).toBe(false);
    await transport.startSession();
    expect(headerOf(fetchMock.mock.calls[0]?.[1], PASSCODE_HEADER)).toBeNull();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      sample: "fictional-trip",
    });

    transport.setPasscode?.("matsuri");
    expect(transport.hasPasscode?.()).toBe(true);
    expect(await transport.startSession()).toBe("s-1");
    expect(headerOf(fetchMock.mock.calls[1]?.[1], PASSCODE_HEADER)).toBe("matsuri");
    // 合言葉は URL に入れない
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("/api/session");
  });

  describe("祭りから探す", () => {
    const request = {
      sessionId: "s-1",
      kinds: ["fireworks" as const],
      season: "summer" as const,
      prefectures: [],
      excludeIds: [],
    };
    const empty = { results: [], remaining: 0, nearMatches: [], next: [], reading: null };

    it("POST で条件を送り、合言葉をヘッダーで付け、応答をスキーマで確かめて返す", async () => {
      const fetchMock = vi.fn<typeof fetch>(async () => json(empty, 200));
      const transport = createServerTransport({ fetch: fetchMock });
      transport.setPasscode?.("matsuri");
      await expect(transport.searchFestivals(request)).resolves.toEqual(empty);
      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(String(url)).toBe("/api/festivals/search");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual(request);
      expect(headerOf(init, PASSCODE_HEADER)).toBe("matsuri");
    });

    it("形の違う応答は受け取らない", async () => {
      const transport = createServerTransport({
        fetch: async () => json({ ...empty, remaining: "たくさん" }, 200),
      });
      await expect(transport.searchFestivals(request)).rejects.toMatchObject({
        code: "invalid_event",
      });
    });

    it("断られたら本文のエラーを読み、404 は相談が切れたものとして扱う", async () => {
      const refused = createServerTransport({
        fetch: async () =>
          json({ code: "rate_limited", message: "今日はここまでです", retryable: false }, 429),
      });
      await expect(refused.searchFestivals(request)).rejects.toMatchObject({
        code: "rate_limited",
        serverMessage: "今日はここまでです",
      });
      const lost = createServerTransport({ fetch: async () => json({}, 404) });
      await expect(lost.searchFestivals(request)).rejects.toMatchObject({ code: "session_lost" });
    });
  });

  describe("祭りを決めたあとの旅の組み立ての確認", () => {
    const anchor = { festivalId: "kasou-matsuri", date: "2030-08-16" };
    const request = { sessionId: "s-1", anchor, origin: "みなと中央駅", nights: 1, wishes: [] };
    const plan = {
      anchor,
      festivalName: "架空の祭り",
      mustPrefectures: ["香川県"],
      visits: [],
      order: ["みなと中央駅", "架空の祭り"],
      startDate: "2030-08-16",
      endDate: "2030-08-17",
      minNights: null,
      warnings: [],
    };

    it("合言葉を付けて送り、結果を受け取る", async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () => json(plan, 200));
      const passcode = createPasscodeHolder();
      passcode.set("matsuri");
      const transport = createServerTransport({ fetch: fetchImpl, passcode });
      await expect(transport.previewFestivalTrip(request)).resolves.toEqual(plan);
      const [url, init] = fetchImpl.mock.calls[0] ?? [];
      expect(url).toBe("/api/festival-trips/preview");
      expect(JSON.parse(String(init?.body))).toEqual(request);
      expect(headerOf(init, PASSCODE_HEADER)).toBe("matsuri");
    });

    it("形の違う応答は受け取らない", async () => {
      const transport = createServerTransport({
        fetch: async () => json({ ...plan, order: [] }, 200),
      });
      await expect(transport.previewFestivalTrip(request)).rejects.toMatchObject({
        code: "invalid_event",
      });
    });

    it("404 は相談が切れたのでなく、祭りが見つからないものとして本文の一文を読む", async () => {
      const transport = createServerTransport({
        fetch: async () =>
          json({ code: "bad_request", message: "祭りが見つかりません。", retryable: false }, 404),
      });
      await expect(transport.previewFestivalTrip(request)).rejects.toMatchObject({
        code: "bad_request",
        serverMessage: "祭りが見つかりません。",
      });
    });
  });

  it("サーバーが知らせた動き方（mock・live）を覚える", async () => {
    const replies = [
      json({ sessionId: "s-1", mode: "mock" }, 201),
      json({ sessionId: "s-2", mode: "live" }, 201),
      json({ sessionId: "s-3" }, 201),
    ];
    const transport = createServerTransport({ fetch: async () => replies.shift() as Response });

    expect(transport.agentMode?.()).toBeNull();
    await transport.startSession();
    expect(transport.agentMode?.()).toBe("mock");
    await transport.startSession();
    expect(transport.agentMode?.()).toBe("live");
    // 知らせのない古いサーバーでは分からないまま
    await transport.startSession();
    expect(transport.agentMode?.()).toBeNull();
  });

  it("記録の名前がなければ、空の本文で始める", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json({ sessionId: "s-1" }, 201));
    await createServerTransport({ fetch: fetchMock }).startSession();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({});
  });

  it("相談を始められなければ、サーバーの一文つきのエラーにする", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      json({ code: "unauthorized", message: "合言葉が違います。", retryable: false }, 401),
    );
    await expect(createServerTransport({ fetch: fetchMock }).startSession()).rejects.toMatchObject({
      code: "unauthorized",
      serverMessage: "合言葉が違います。",
    });
  });

  it("祭りのデータも同じ合言葉で読み、見つからない・掲載停止（404）なら null", async () => {
    const festival = FestivalSchema.parse(fictionalFestival());
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith(festival.id)
        ? json(festival, 200)
        : json({ code: "bad_request", message: "見つかりません。", retryable: false }, 404),
    );
    const passcode = createPasscodeHolder();
    passcode.set("matsuri");
    const source = createServerFestivalSource({ passcode, fetch: fetchMock });
    expect((await source.load(festival.id))?.id).toBe(festival.id);
    expect(headerOf(fetchMock.mock.calls[0]?.[1], PASSCODE_HEADER)).toBe("matsuri");
    expect(await source.load("opted-out")).toBeNull();
  });

  it("豆知識に使う祭りは一覧の経路から読み、形の違うものと掲載停止の祭りは捨てる", async () => {
    const festival = fictionalFestival();
    const fetchMock = vi.fn<typeof fetch>(async () =>
      json(
        { festivals: [festival, { id: "broken" }, { ...festival, id: "opted-out", optOut: true }] },
        200,
      ),
    );
    const list = await createServerFestivalSource({ fetch: fetchMock }).initial();
    expect(list.map((item) => item.id)).toEqual([festival.id]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/festivals");
  });

  it("接続が切れたあとは、合言葉の要らない死活監視の口でサーバーが応答するかを確かめる", async () => {
    const up = vi.fn<typeof fetch>(async () => json({ status: "ok" }, 200));
    expect(await createServerTransport({ fetch: up }).checkServer?.()).toBe(true);
    expect(up.mock.calls[0]?.[0]).toBe("/health");

    const refused = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await createServerTransport({ fetch: refused }).checkServer?.()).toBe(false);

    // 開発の中継（Vite）は、サーバーが止まっていると 500 を返す
    const proxyError = vi.fn<typeof fetch>(async () => new Response("", { status: 500 }));
    expect(await createServerTransport({ fetch: proxyError }).checkServer?.()).toBe(false);
  });

  it("一覧の経路がないサーバーでは、豆知識に使う祭りは空のまま", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json({ code: "not_found" }, 404));
    expect(await createServerFestivalSource({ fetch: fetchMock }).initial()).toEqual([]);
  });
});
