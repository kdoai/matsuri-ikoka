import { isIP } from "node:net";
import { checkPublicWebUrl } from "@matsuri-ikoka/agent-kit";
import { Agent, fetch as undiciFetch } from "undici";
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
/** 本文がこれだけあれば、noscript の案内があっても読めるページとして扱う */
const ENOUGH_STATIC_CHARS = 1_000;
/** スクリプトで描くページかを調べる範囲（先頭から）。ページの文字を前から1度だけ読む */
const SCAN_LIMIT_CHARS = 300_000;
/** タグの属性を読む長さの上限 */
const MAX_TAG_CHARS = 500;
const MAX_COMMENT_CHARS = 2_000;

const APP_ROOT_ELEMENTS = ["div", "main", "section"];
const APP_ROOT_ID = /(?:^|\s)id\s*=\s*["']?(?:app|root|__next|__nuxt)(?:["'\s/]|$)/;

/** 空白とコメントを飛ばした位置 */
function skipBlank(lower: string, from: number): number {
  let at = from;
  while (at < lower.length) {
    const ch = lower[at] ?? "";
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") {
      at += 1;
    } else if (lower.startsWith("<!--", at)) {
      const end = lower.slice(at, at + MAX_COMMENT_CHARS).indexOf("-->");
      if (end < 0) return at;
      at += end + 3;
    } else {
      return at;
    }
  }
  return at;
}

/**
 * スクリプトで中身を描く空の入れ物があるか。タグを前から1度だけ読む。
 * サイトが書いた文字列なので、タグの中を広く読む正規表現にしない（「<div 」の繰り返しで時間が爆発する）
 */
function hasEmptyAppRoot(html: string): boolean {
  const lower = html.slice(0, SCAN_LIMIT_CHARS).toLowerCase();
  let at = lower.indexOf("<");
  while (at >= 0) {
    const name = APP_ROOT_ELEMENTS.find((element) => lower.startsWith(element, at + 1));
    if (name !== undefined) {
      const tag = lower.slice(at + 1 + name.length, at + 1 + name.length + MAX_TAG_CHARS);
      const close = tag.indexOf(">");
      const inner = close < 0 ? "" : tag.slice(0, close);
      if (close >= 0 && !inner.includes("<") && APP_ROOT_ID.test(inner)) {
        const body = skipBlank(lower, at + 1 + name.length + close + 1);
        if (lower.startsWith(`</${name}`, body)) return true;
      }
    }
    at = lower.indexOf("<", at + 1);
  }
  return false;
}

/** スクリプトを有効にするよう案内しているか */
function hasScriptNotice(html: string): boolean {
  const lower = html.slice(0, SCAN_LIMIT_CHARS).toLowerCase();
  let at = lower.indexOf("<noscript");
  while (at >= 0) {
    const part = lower.slice(at, at + MAX_TAG_CHARS + 600);
    const close = part.indexOf(">");
    if (close >= 0) {
      const end = part.indexOf("<", close);
      const text = part.slice(close + 1, end < 0 ? undefined : end);
      if (/javascript|スクリプト/.test(text) && /有効|オン|enable|required|必要/.test(text)) {
        return true;
      }
    }
    at = lower.indexOf("<noscript", at + 1);
  }
  return false;
}

/**
 * スクリプトで描くページか。空の入れ物があれば、本文が長くても読めないページにする。
 * noscript の案内だけなら、本文が十分にあれば読めるページとして扱う（静的なページにもよくあるため）
 */
export function looksScriptRendered(html: string, bodyChars: number): boolean {
  if (hasEmptyAppRoot(html)) return true;
  return bodyChars < ENOUGH_STATIC_CHARS && hasScriptNotice(html);
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

type LookupDone = (
  error: Error | null,
  address: string | { address: string; family: number }[],
  family?: number,
) => void;

/**
 * 名前を解決し直さず、渡したアドレスにつなぐ。TLS の確認は URL の名前で行う。
 * HTTP の処理（解凍・101 の扱い・打ち切り）は undici に任せる
 */
export const pinnedFetch: PinnedFetch = async (url, addresses, init) => {
  const entries = addresses.map((address) => ({ address, family: isIP(address) }));
  const first = entries[0];
  if (first === undefined) throw new Error("つなぐ先のアドレスがありません");
  const dispatcher = new Agent({
    pipelining: 0,
    connect: {
      lookup: (_host: string, options: { all?: boolean }, done: LookupDone) => {
        if (options.all) done(null, entries);
        else done(null, first.address, first.family);
      },
    },
  });
  try {
    const response = await undiciFetch(url, {
      redirect: "manual",
      headers: init.headers,
      signal: init.signal,
      dispatcher,
    });
    // 本文を読み終えたら閉じる
    void dispatcher.close().catch(() => {});
    return response as unknown as Response;
  } catch (error) {
    void dispatcher.destroy().catch(() => {});
    throw error;
  }
};

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
    /<meta[^<>]{0,300}charset=["']?([\w-]+)/i.exec(head)?.[1] ??
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
          const lines = pageLines(html);
          const chars = lines.reduce((total, line) => total + line.length, 0);
          return chars < MIN_READABLE_CHARS || looksScriptRendered(html, chars)
            ? { status: "unreadable" }
            : { status: "ok", lines };
        } catch {
          return { status: "failed" };
        }
      }
      return { status: "failed" };
    },
  };
}
