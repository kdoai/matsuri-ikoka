import { describe, expect, it, vi } from "vitest";
import type { ResolveHost } from "../agent/addressGuard";
import { createPageFetcher, type PageFetcherOptions } from "./pageFetcher";

// ページの取得。ネットワークには出ない。URL は example.com の架空のページ。

const BODY = `<html><body>${"<p>架空の祭りの案内の文章です。開催は8月16日です。</p>".repeat(1)}${Array.from(
  { length: 12 },
  (_, i) => `<p>架空の祭りの案内の行 その${i}。屋台と灯籠流しがあります。</p>`,
).join("")}</body></html>`;

const html = (body = BODY, init: ResponseInit = {}) =>
  new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
    ...init,
  });

const publicAddress: ResolveHost = async () => ["93.184.216.34"];

function fetcher(
  send: (url: string) => Response | Promise<Response>,
  over: PageFetcherOptions = {},
) {
  const calls: string[] = [];
  const pages = createPageFetcher({
    fetch: (async (input: string | URL | Request) => {
      calls.push(String(input));
      return send(String(input));
    }) as typeof fetch,
    resolve: publicAddress,
    robots: { allowed: async () => true },
    minHostIntervalMs: 0,
    ...over,
  });
  return { pages, calls };
}

describe("createPageFetcher", () => {
  it("読めたページを行にして返す", async () => {
    const { pages } = fetcher(() => html());

    const read = await pages.read("https://example.com/matsuri");

    expect(read.status).toBe("ok");
    expect(read.status === "ok" && read.lines[0]).toContain("開催は8月16日です");
  });

  it.each([
    ["ループバック", "http://localhost/"],
    ["IP アドレスの直接指定", "http://127.0.0.1/"],
    ["メタデータ", "http://metadata.google.internal/"],
    ["ポート番号つき", "https://example.com:8080/"],
    ["ファイル", "file:///etc/passwd"],
  ])("%sの URL は読みに行かない", async (_name, url) => {
    const { pages, calls } = fetcher(() => html());

    expect(await pages.read(url)).toEqual({ status: "blocked" });
    expect(calls).toEqual([]);
  });

  it("名前の向き先が内側のアドレスなら読みに行かない", async () => {
    const { pages, calls } = fetcher(() => html(), { resolve: async () => ["169.254.169.254"] });

    expect(await pages.read("https://example.com/matsuri")).toEqual({ status: "blocked" });
    expect(calls).toEqual([]);
  });

  it("robots.txt で断られているページは読みに行かない", async () => {
    const { pages, calls } = fetcher(() => html(), { robots: { allowed: async () => false } });

    expect(await pages.read("https://example.com/matsuri")).toEqual({ status: "blocked" });
    expect(calls).toEqual([]);
  });

  it("転送先も確かめ直す", async () => {
    const { pages, calls } = fetcher((url) =>
      url.endsWith("/old")
        ? new Response(null, { status: 302, headers: { location: "/new" } })
        : html(),
    );
    expect((await pages.read("https://example.com/old")).status).toBe("ok");
    expect(calls).toEqual(["https://example.com/old", "https://example.com/new"]);

    const inner = fetcher(
      () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } }),
    );
    expect(await inner.pages.read("https://example.com/old")).toEqual({ status: "blocked" });
    expect(inner.calls).toEqual(["https://example.com/old"]);
  });

  it("転送が続くページは失敗にする", async () => {
    const { pages, calls } = fetcher(
      () => new Response(null, { status: 302, headers: { location: "/again" } }),
    );

    expect(await pages.read("https://example.com/again")).toEqual({ status: "failed" });
    expect(calls).toHaveLength(4);
  });

  it.each([
    ["スクリプトで描くページ", () => html("<html><body><div id='app'></div></body></html>")],
    ["PDF", () => new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } })],
    ["機械を断るページ", () => html("forbidden", { status: 403 })],
  ])("%sは、コードでは読めないページとして返す", async (_name, respond) => {
    const { pages } = fetcher(respond);

    expect(await pages.read("https://example.com/matsuri")).toEqual({ status: "unreadable" });
  });

  it("サーバーの失敗と通信の失敗は、失敗として返す", async () => {
    const down = fetcher(() => html("error", { status: 503 }));
    expect(await down.pages.read("https://example.com/")).toEqual({ status: "failed" });

    const offline = fetcher(() => {
      throw new Error("fetch failed");
    });
    expect(await offline.pages.read("https://example.com/")).toEqual({ status: "failed" });
  });

  it("上限を超えた分は読まない", async () => {
    const { pages } = fetcher(() => html(), { maxBytes: 40 });

    // 上限までの本文は短いので、読めないページになる
    expect(await pages.read("https://example.com/")).toEqual({ status: "unreadable" });
  });

  it("Shift_JIS のページも読める", async () => {
    const hex = "8a4a8dc393fa8146"; // 「開催日：」
    const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
    const padding = Array.from(
      { length: 8 },
      (_, i) => `<p>abcdefghij klmnopqrst uvwxyz 0123456789 ${i}</p>`,
    ).join("");
    const body = Buffer.concat([Buffer.from("<p>"), bytes, Buffer.from(`</p>${padding}`)]);
    const { pages } = fetcher(
      () =>
        new Response(body, {
          headers: { "content-type": "text/html; charset=Shift_JIS" },
        }),
    );

    const read = await pages.read("https://example.com/");

    expect(read.status === "ok" && read.lines[0]).toBe("開催日:");
  });

  it("同じサイトは間隔を空けて読む", async () => {
    let clock = 1_000;
    const timer = vi.spyOn(globalThis, "setTimeout");
    const { pages } = fetcher(() => html(), { minHostIntervalMs: 5, clock: () => clock });

    await pages.read("https://example.com/a");
    await pages.read("https://example.com/b");
    clock += 10;
    timer.mockClear();
    await pages.read("https://example.com/c");

    expect(timer).not.toHaveBeenCalledWith(expect.any(Function), 5);
    timer.mockRestore();
  });
});
