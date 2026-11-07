import { checkPublicWebUrl } from "@matsuri-ikoka/agent-kit";
import { checkHostAddresses, type ResolveHost, resolveHost } from "../agent/addressGuard";
import { createRobotsChecker, ROBOTS_USER_AGENT, type RobotsChecker } from "../agent/robots";
import { pageLines } from "./lines";

// 見回りでコードが公開のページを読む。モデルは使わない。
// URL は転送のたびに確かめ直し、サイトが読まないでほしいと書いているページは読まない。

/** 1回の取得を打ち切る時間（ミリ秒） */
const PAGE_TIMEOUT_MS = 15_000;
/** 読むページの大きさの上限（バイト）。超えた分は読まない */
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
/** 同じサイトを読む間隔の下限（ミリ秒） */
const MIN_HOST_INTERVAL_MS = 1_000;
/** 本文がこれより短いページは、スクリプトで描かれていて比べられないとみなす */
const MIN_READABLE_CHARS = 200;

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

export interface PageFetcherOptions {
  fetch?: typeof fetch;
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
  const send = options.fetch ?? fetch;
  const resolve = options.resolve ?? resolveHost;
  const robots = options.robots ?? createRobotsChecker({ fetch: send });
  const clock = options.clock ?? Date.now;
  const minInterval = options.minHostIntervalMs ?? MIN_HOST_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? PAGE_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_PAGE_BYTES;
  const lastReadAt = new Map<string, number>();

  async function waitForHost(host: string): Promise<void> {
    const wait = (lastReadAt.get(host) ?? Number.NEGATIVE_INFINITY) + minInterval - clock();
    if (wait > 0) await new Promise((done) => setTimeout(done, wait));
    lastReadAt.set(host, clock());
  }

  /** 読んでよい URL なら URL を返す。転送先でも毎回確かめる */
  async function allowedUrl(raw: string): Promise<URL | null> {
    const check = checkPublicWebUrl(raw);
    if (!check.ok) return null;
    const address = await checkHostAddresses(check.url.hostname, resolve);
    if (!address.ok) return null;
    return (await robots.allowed(check.url)) ? check.url : null;
  }

  return {
    async read(raw) {
      let target = raw;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const url = await allowedUrl(target);
        if (url === null) return { status: "blocked" };
        await waitForHost(url.hostname);
        let response: Response;
        try {
          response = await send(url, {
            redirect: "manual",
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
          const lines = pageLines(decode(await readBytes(response, maxBytes), type));
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
