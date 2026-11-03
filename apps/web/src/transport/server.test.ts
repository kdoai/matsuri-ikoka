import { FestivalSchema } from "@matsuri-ikoka/schema";
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
    expect(up.mock.calls[0]?.[0]).toBe("/healthz");

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
