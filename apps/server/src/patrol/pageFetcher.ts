import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { checkPublicWebUrl } from "@matsuri-ikoka/agent-kit";
import { checkHostAddresses, type ResolveHost, resolveHost } from "../agent/addressGuard";
import { createRobotsChecker, ROBOTS_USER_AGENT, type RobotsChecker } from "../agent/robots";
import { pageLines } from "./lines";

// 見回りでコードが公開のページを読む。モデルは使わない。
// URL は転送のたびに確かめ直し、サイトが読まないでほしいと書いているページは読まない。
// 確かめたあとに名前の向き先を変えられないよう、確かめたアドレスにだけつなぐ（名前を解決し直さない）。

/** 1回の取得を打ち切る時間（ミリ秒） */
const PAGE_TIMEOUT_MS = 15_000;
/** 読むページの大きさの上限（バイト）。超えた分は読まない */
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
/** 同じサイトを読む間隔の下限（ミリ秒） */
const MIN_HOST_INTERVAL_MS = 1_000;
/** 本文がこれより短いページは、スクリプトで描かれていて比べられないとみなす */
const MIN_READABLE_CHARS = 200;

/** スクリプトで中身を描くページの、空の入れ物 */
const EMPTY_APP_ROOT =
  /<(?:div|main|section)\b[^>]*\bid\s*=\s*["']?(?:app|root|__next|__nuxt)["']?[^>]*>\s*<\/(?:div|main|section)>/i;
/** スクリプトを有効にするよう案内するページ */
const NOSCRIPT_NOTICE =
  /<noscript\b[^>]*>(?=[^<]{0,600}(?:javascript|スクリプト))(?=[^<]{0,600}(?:有効|オン|enable|required|必要))/i;

/** スクリプトで描くページか。迷うときは読めないページに倒す（ナビだけ読んで変化なしとしない） */
export function looksScriptRendered(html: string): boolean {
  return EMPTY_APP_ROOT.test(html) || NOSCRIPT_NOTICE.test(html);
}

export type PageRead =
  /** コードで読めた。比べるための行 */
  | { status: "ok"; lines: string[] }
  /** コードでは読めない（スクリプトで描くページ・PDF・機械を断るページ）。見回り係に任せる */
  | { status: "unreadable" }
  /** 読みに行けなかった（通信・サーバーの失敗）。間隔を空けて調べ直す */
  | { status: "failed" }
  /** 読まない（URL の形や向き先が公開の Web でない、robots.txt で断られている） */
  | { status: "blocked" };

export interface PageFetcher {
  read(url: string): Promise<PageRead>;
}

export interface PinnedRequest {
  headers: Record<string, string>;
  signal: AbortSignal;
}

/** 確かめたアドレスにだけつないで取得する。転送はたどらない */
export type PinnedFetch = (
  url: URL,
  addresses: readonly string[],
  init: PinnedRequest,
) => Promise<Response>;

/** 名前を解決し直さず、渡したアドレスにつなぐ。TLS の確認は URL の名前で行う */
export const pinnedFetch: PinnedFetch = (url, addresses, init) =>
  new Promise((resolve, reject) => {
    const entries = addresses.map((address) => ({ address, family: isIP(address) }));
    const first = entries[0];
    if (first === undefined) {
      reject(new Error("つなぐ先のアドレスがありません"));
      return;
    }
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: "GET",
        headers: init.headers,
        signal: init.signal,
        lookup: (_host, options, done) => {
          if (options.all) done(null, entries);
          else done(null, first.address, first.family);
        },
      },
      (response) => {
        const status = response.statusCode ?? 502;
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (typeof value === "string") headers.set(name, value);
          else if (Array.isArray(value)) headers.set(name, value.join(", "));
        }
        const empty = status === 204 || status === 205 || status === 304;
        if (empty) response.resume();
        resolve(
          new Response(
            empty ? null : (Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>),
            { status: status < 200 || status > 599 ? 502 : status, headers },
          ),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });

export interface PageFetcherOptions {
  /** テストで差し替える。省略すると確かめたアドレスにつなぐ */
  fetch?: PinnedFetch;
  resolve?: ResolveHost;
  robots?: RobotsChecker;
  clock?: () => number;
  minHostIntervalMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
}

async function readBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  const bytes = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.byteLength - offset);
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

/** 文字コードは、見出し・ページの meta の順に見る（小さな町のサイトには Shift_JIS も多い） */
function decode(bytes: Uint8Array, contentType: string): string {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const label =
    /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ??
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ??
    "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export function createPageFetcher(options: PageFetcherOptions = {}): PageFetcher {
  const send = options.fetch ?? pinnedFetch;
  const resolve = options.resolve ?? resolveHost;
  const clock = options.clock ?? Date.now;
  const minInterval = options.minHostIntervalMs ?? MIN_HOST_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? PAGE_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_PAGE_BYTES;
  const lastReadAt = new Map<string, number>();

  /** 名前の向き先を確かめ、確かめたアドレスを返す。公開の Web でなければ null */
  async function verifiedAddresses(host: string): Promise<string[] | null> {
    let addresses: string[] = [];
    const check = await checkHostAddresses(host, async (name) => {
      addresses = await resolve(name);
      return addresses;
    });
    return check.ok ? addresses : null;
  }

  // robots.txt も、確かめたアドレスから読む。転送はたどらない
  const robots =
    options.robots ??
    createRobotsChecker({
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const addresses = await verifiedAddresses(url.hostname);
        if (addresses === null) throw new Error("公開の Web ではありません");
        return send(url, addresses, {
          headers: { "User-Agent": `${ROBOTS_USER_AGENT}/0.1` },
          signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
        });
      }) as typeof fetch,
    });

  async function waitForHost(host: string): Promise<void> {
    const wait = (lastReadAt.get(host) ?? Number.NEGATIVE_INFINITY) + minInterval - clock();
    if (wait > 0) await new Promise((done) => setTimeout(done, wait));
    lastReadAt.set(host, clock());
  }

  return {
    async read(raw) {
      let target = raw;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        // 読んでよい URL か。転送先でも毎回確かめる
        const check = checkPublicWebUrl(target);
        if (!check.ok) return { status: "blocked" };
        const url = check.url;
        const addresses = await verifiedAddresses(url.hostname);
        if (addresses === null || !(await robots.allowed(url))) return { status: "blocked" };
        await waitForHost(url.hostname);
        let response: Response;
        try {
          response = await send(url, addresses, {
            headers: { "User-Agent": `${ROBOTS_USER_AGENT}/0.1` },
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch {
          return { status: "failed" };
        }
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          await response.body?.cancel().catch(() => {});
          if (location === null) return { status: "failed" };
          try {
            target = new URL(location, url).toString();
          } catch {
            return { status: "failed" };
          }
          continue;
        }
        // 機械を断るページは、人が読むブラウザと同じ取り方の見回り係に任せる
        if (response.status === 401 || response.status === 403 || response.status === 451) {
          await response.body?.cancel().catch(() => {});
          return { status: "unreadable" };
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          return { status: "failed" };
        }
        const type = response.headers.get("content-type") ?? "";
        if (type !== "" && !/text\/|html|xml/i.test(type)) {
          await response.body?.cancel().catch(() => {});
          return { status: "unreadable" };
        }
        try {
          const html = decode(await readBytes(response, maxBytes), type);
          if (looksScriptRendered(html)) return { status: "unreadable" };
          const lines = pageLines(html);
          const chars = lines.reduce((total, line) => total + line.length, 0);
          return chars < MIN_READABLE_CHARS ? { status: "unreadable" } : { status: "ok", lines };
        } catch {
          return { status: "failed" };
        }
      }
      return { status: "failed" };
    },
  };
}
