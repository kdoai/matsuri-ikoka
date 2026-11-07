import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ResolveHost } from "../agent/addressGuard";
import {
  createPageFetcher,
  looksScriptRendered,
  type PageFetcherOptions,
  type PinnedFetch,
  pinnedFetch,
} from "./pageFetcher";

// ページの取得。外のネットワークには出ない。URL は example.com の架空のページ。

const BODY = `<html><body><p>架空の祭りの案内の文章です。開催は8月16日です。</p>${Array.from(
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
  const calls: { url: string; addresses: readonly string[] }[] = [];
  const stub: PinnedFetch = async (url, addresses) => {
    calls.push({ url: String(url), addresses });
    return send(String(url));
  };
  const pages = createPageFetcher({
    fetch: stub,
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

  it("確かめたアドレスにつなぐ", async () => {
    const { pages, calls } = fetcher(() => html());

    await pages.read("https://example.com/matsuri");

    expect(calls).toEqual([{ url: "https://example.com/matsuri", addresses: ["93.184.216.34"] }]);
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

  it("robots.txt も確かめたアドレスから読む", async () => {
    const seen: string[] = [];
    const stub: PinnedFetch = async (url, addresses) => {
      seen.push(`${url.pathname} ${addresses.join(",")}`);
      return url.pathname === "/robots.txt"
        ? new Response("User-agent: *\nDisallow: /secret\n")
        : html();
    };
    const pages = createPageFetcher({ fetch: stub, resolve: publicAddress, minHostIntervalMs: 0 });

    expect(await pages.read("https://example.com/secret")).toEqual({ status: "blocked" });
    expect(seen).toEqual(["/robots.txt 93.184.216.34"]);
  });

  it("転送先も確かめ直す", async () => {
    const { pages, calls } = fetcher((url) =>
      url.endsWith("/old")
        ? new Response(null, { status: 302, headers: { location: "/new" } })
        : html(),
    );
    expect((await pages.read("https://example.com/old")).status).toBe("ok");
    expect(calls.map((call) => call.url)).toEqual([
      "https://example.com/old",
      "https://example.com/new",
    ]);

    const inner = fetcher(
      () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } }),
    );
    expect(await inner.pages.read("https://example.com/old")).toEqual({ status: "blocked" });
    expect(inner.calls).toHaveLength(1);
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
    [
      "ナビが長くても中身が空のページ",
      () =>
        html(
          `<html><body><nav>${Array.from({ length: 30 }, (_, i) => `<a href="/${i}">観光案内のメニュー ${i}</a>`).join("")}</nav><div id="__next"></div></body></html>`,
        ),
    ],
    [
      "スクリプトを有効にするよう案内するページ",
      () =>
        html(
          `<html><body><noscript>このページの表示には JavaScript を有効にしてください</noscript>${BODY}</body></html>`,
        ),
    ],
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

describe("looksScriptRendered", () => {
  it.each([
    '<div id="app"></div>',
    "<div id='root'>  </div>",
    '<div class="a" id="__nuxt"></div>',
    "<main id=app></main>",
    '<div id="app"><!-- --></div>',
    '<div id="__next"><!-- app --> <!-- shell --></div>',
    "<noscript>JavaScript を有効にしてご覧ください</noscript>",
    "<noscript>You need to enable JavaScript to run this app.</noscript>",
  ])("%s は、スクリプトで描くページ", (html) => {
    expect(looksScriptRendered(html, 10)).toBe(true);
  });

  it.each([
    '<div id="app"><p>開催日 8月16日</p></div>',
    '<div id="root"><h1>鈴鳴灯籠まつり</h1></div>',
    "<noscript><img src='/pixel.gif'></noscript>",
    '<div id="content"></div>',
    '<div data-id="app"></div>',
  ])("%s は、スクリプトで描くページではない", (html) => {
    expect(looksScriptRendered(html, 10)).toBe(false);
  });

  it("本文が十分にあれば、noscript の案内だけでは読めないとしない", () => {
    const notice = "<noscript>JavaScript を有効にしてご覧ください</noscript>";

    expect(looksScriptRendered(notice, 100)).toBe(true);
    expect(looksScriptRendered(notice, 5_000)).toBe(false);
  });

  it("本文が長くても、空の入れ物があれば読めないページにする", () => {
    expect(looksScriptRendered('<div id="app"></div>', 5_000)).toBe(true);
  });

  it.each([
    ["「<div 」の繰り返し", "<div ".repeat(400_000)],
    ["「<div id=app 」の繰り返し", "<div id=app ".repeat(200_000)],
    ["「<div id=app>」の繰り返し", "<div id=app>".repeat(200_000)],
    ["閉じないコメントの繰り返し", "<div id=app><!-- ".repeat(100_000)],
    ["「<noscript 」の繰り返し", "<noscript ".repeat(200_000)],
  ])("%sでも、すぐに終わる", (_name, html) => {
    const started = performance.now();

    expect(looksScriptRendered(html, 10)).toBe(false);

    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("pinnedFetch", () => {
  let server: http.Server;
  let port = 0;
  const hosts: (string | undefined)[] = [];

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      hosts.push(request.headers.host);
      if (request.url === "/moved") {
        response.writeHead(302, { location: "/next" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("確かめたアドレスから読みました");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((done) => server.close(done));
  });

  const init = () => ({ headers: {}, signal: AbortSignal.timeout(5_000) });

  it("名前を解決し直さず、渡したアドレスにつなぐ", async () => {
    // festival.example.com は解決できても別の先を指す名前。渡した 127.0.0.1 につながる
    const url = new URL(`http://festival.example.com:${port}/page`);

    const response = await pinnedFetch(url, ["127.0.0.1"], init());

    expect(await response.text()).toBe("確かめたアドレスから読みました");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(hosts.at(-1)).toBe(`festival.example.com:${port}`);
  });

  it("転送はたどらない", async () => {
    const url = new URL(`http://festival.example.com:${port}/moved`);

    const response = await pinnedFetch(url, ["127.0.0.1"], init());

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/next");
  });

  it("アドレスがなければ、つながない", async () => {
    await expect(pinnedFetch(new URL("http://example.com/"), [], init())).rejects.toThrow();
  });

  it("交渉を無視して gzip を返すサーバーのページも、文字化けせずに読める", async () => {
    const zipped = http.createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-encoding": "gzip",
      });
      response.end(gzipSync("<p>開催日 8月23日</p>"));
    });
    await new Promise<void>((done) => zipped.listen(0, "127.0.0.1", done));
    const { port: zippedPort } = zipped.address() as AddressInfo;

    const response = await pinnedFetch(
      new URL(`http://festival.example.com:${zippedPort}/`),
      ["127.0.0.1"],
      init(),
    );

    expect(await response.text()).toBe("<p>開催日 8月23日</p>");
    await new Promise((done) => zipped.close(done));
  });

  it("101 を返すサーバーでも、返らなくなることがない", async () => {
    const upgrading = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.once("data", () => {
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        );
      });
    });
    await new Promise<void>((done) => upgrading.listen(0, "127.0.0.1", done));
    const { port: upgradingPort } = upgrading.address() as AddressInfo;

    await expect(
      pinnedFetch(new URL(`http://festival.example.com:${upgradingPort}/`), ["127.0.0.1"], {
        headers: {},
        signal: AbortSignal.timeout(1_000),
      }),
    ).rejects.toThrow();

    await new Promise((done) => upgrading.close(done));
  });

  it("応答を返さないサーバーは、打ち切りで止める", async () => {
    const silent = net.createServer((socket) => {
      socket.on("error", () => {});
      // 読み続けるので、相手が切ったことに気づいて閉じられる
      socket.resume();
    });
    await new Promise<void>((done) => silent.listen(0, "127.0.0.1", done));
    const { port: silentPort } = silent.address() as AddressInfo;

    await expect(
      pinnedFetch(new URL(`http://festival.example.com:${silentPort}/`), ["127.0.0.1"], {
        headers: {},
        signal: AbortSignal.timeout(200),
      }),
    ).rejects.toThrow();

    await new Promise((done) => silent.close(done));
  });
});
