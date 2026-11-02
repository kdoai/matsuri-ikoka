import { createHash } from "node:crypto";
import type { ShioriAsset } from "./assets";

// しおりの PDF。HTML のテンプレートを Chromium（Playwright）で A4 の PDF にする。
// - 描くときは外へのリクエストを一切させない（ページと素材は手元から返し、ほかはすべて止める）。スクリプトも止める
// - 作った PDF は、旅程の id・版・HTML の中身ごとにとっておく
// - 同時に作る数・待たせる数・時間に上限を置く

export interface ShioriPdfConfig {
  /** 同時に作る数 */
  concurrency: number;
  /** 空きを待たせる数。超えたら断る */
  queue: number;
  /** 1つを作る時間の上限 */
  timeoutMs: number;
  /** とっておく PDF の合計の大きさ */
  cacheBytes: number;
  /** Chromium の実行ファイル。なければ Playwright が入れたもの */
  executablePath: string | undefined;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function readShioriPdfConfig(env: NodeJS.ProcessEnv = process.env): ShioriPdfConfig {
  return {
    concurrency: positiveInt(env.MATSURI_SHIORI_PDF_CONCURRENCY, 2),
    queue: positiveInt(env.MATSURI_SHIORI_PDF_QUEUE, 6),
    timeoutMs: positiveInt(env.MATSURI_SHIORI_PDF_TIMEOUT_MS, 30_000),
    cacheBytes: positiveInt(env.MATSURI_SHIORI_PDF_CACHE_MB, 64) * 1024 * 1024,
    executablePath: env.MATSURI_SHIORI_CHROMIUM_PATH?.trim() || undefined,
  };
}

/** 混んでいて、いまは作れない */
export class ShioriPdfBusyError extends Error {
  constructor() {
    super("しおりの PDF を作る順番待ちがいっぱいです");
    this.name = "ShioriPdfBusyError";
  }
}

/** 時間の上限を超えた */
export class ShioriPdfTimeoutError extends Error {
  constructor(ms: number) {
    super(`しおりの PDF を ${ms}ms で作り終えられませんでした`);
    this.name = "ShioriPdfTimeoutError";
  }
}

export interface PdfRenderResult {
  pdf: Buffer;
  /** 止めた外へのリクエストの数（ふつうは 0） */
  blocked: number;
}

/** HTML と素材から PDF を作るもの（テストでは差し替える） */
export interface PdfEngine {
  render(
    html: string,
    files: ReadonlyMap<string, ShioriAsset>,
    signal: AbortSignal,
  ): Promise<PdfRenderResult>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Chromium

/** ページを開く架空のオリジン。この中のパスだけを手元から返す */
export const RENDER_ORIGIN = "http://shiori.invalid";
const DOC_PATH = "/shiori/document";
const ASSET_PREFIX = "/shiori/assets/";

type Browser = import("playwright-core").Browser;

export class ChromiumPdfEngine implements PdfEngine {
  readonly #executablePath: string | undefined;
  #browser: Promise<Browser> | null = null;

  constructor(options: { executablePath?: string | undefined } = {}) {
    this.#executablePath = options.executablePath;
  }

  #launch(): Promise<Browser> {
    if (this.#browser === null) {
      const launching = import("playwright-core").then(({ chromium }) =>
        chromium.launch({
          executablePath: this.#executablePath,
          args: ["--disable-gpu", "--disable-dev-shm-usage", "--disable-extensions"],
        }),
      );
      launching.then(
        (browser) =>
          browser.on("disconnected", () => {
            this.#browser = null;
          }),
        () => {
          this.#browser = null;
        },
      );
      this.#browser = launching;
    }
    return this.#browser;
  }

  async render(
    html: string,
    files: ReadonlyMap<string, ShioriAsset>,
    signal: AbortSignal,
  ): Promise<PdfRenderResult> {
    const browser = await this.#launch();
    const context = await browser.newContext({
      javaScriptEnabled: false,
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    const onAbort = () => void context.close().catch(() => {});
    signal.addEventListener("abort", onAbort, { once: true });
    let blocked = 0;
    try {
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.origin === RENDER_ORIGIN) {
          if (url.pathname === DOC_PATH) {
            return route.fulfill({
              status: 200,
              contentType: "text/html; charset=utf-8",
              body: html,
            });
          }
          const file = url.pathname.startsWith(ASSET_PREFIX)
            ? files.get(url.pathname.slice(ASSET_PREFIX.length))
            : undefined;
          if (file !== undefined) {
            return route.fulfill({ status: 200, contentType: file.contentType, body: file.body });
          }
        }
        blocked += 1;
        return route.abort("blockedbyclient");
      });
      const page = await context.newPage();
      await page.goto(`${RENDER_ORIGIN}${DOC_PATH}`, { waitUntil: "load" });
      const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
      return { pdf, blocked };
    } finally {
      signal.removeEventListener("abort", onAbort);
      await context.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    const browser = this.#browser;
    this.#browser = null;
    if (browser) await (await browser.catch(() => null))?.close();
  }
}

// ---------------------------------------------------------------------------
// とっておく・上限

/** 大きさの合計で上限を置く、最近使った順のキャッシュ */
export class PdfCache {
  readonly #maxBytes: number;
  readonly #entries = new Map<string, Buffer>();
  #bytes = 0;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: string): Buffer | undefined {
    const pdf = this.#entries.get(key);
    if (pdf !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, pdf);
    }
    return pdf;
  }

  set(key: string, pdf: Buffer): void {
    if (pdf.byteLength > this.#maxBytes) return;
    const old = this.#entries.get(key);
    if (old !== undefined) {
      this.#bytes -= old.byteLength;
      this.#entries.delete(key);
    }
    this.#entries.set(key, pdf);
    this.#bytes += pdf.byteLength;
    for (const [k, v] of this.#entries) {
      if (this.#bytes <= this.#maxBytes) break;
      this.#entries.delete(k);
      this.#bytes -= v.byteLength;
    }
  }
}

/** キャッシュのキー。同じ旅程の同じ版でも、祭りのデータや素材が変われば作り直す */
export function pdfCacheKey(id: string, version: number, html: string): string {
  const digest = createHash("sha256").update(html).digest("hex").slice(0, 16);
  return `${id}@${version}#${digest}`;
}

export interface PdfJob {
  key: string;
  html: string;
}

export class ShioriPdfService {
  readonly #engine: PdfEngine;
  readonly #files: ReadonlyMap<string, ShioriAsset>;
  readonly #config: Pick<ShioriPdfConfig, "concurrency" | "queue" | "timeoutMs">;
  readonly #cache: PdfCache;
  readonly #inflight = new Map<string, Promise<Buffer>>();
  readonly #waiting: (() => void)[] = [];
  #running = 0;

  constructor(
    engine: PdfEngine,
    files: ReadonlyMap<string, ShioriAsset>,
    config: Pick<ShioriPdfConfig, "concurrency" | "queue" | "timeoutMs" | "cacheBytes">,
  ) {
    this.#engine = engine;
    this.#files = files;
    this.#config = config;
    this.#cache = new PdfCache(config.cacheBytes);
  }

  get running(): number {
    return this.#running;
  }

  get waiting(): number {
    return this.#waiting.length;
  }

  /** PDF を返す。とってあればそれを、同じものを作っている途中ならその結果を返す */
  get(job: PdfJob): Promise<Buffer> {
    const cached = this.#cache.get(job.key);
    if (cached !== undefined) return Promise.resolve(cached);
    const inflight = this.#inflight.get(job.key);
    if (inflight !== undefined) return inflight;
    if (this.#running >= this.#config.concurrency && this.#waiting.length >= this.#config.queue) {
      return Promise.reject(new ShioriPdfBusyError());
    }
    const promise = this.#produce(job).finally(() => this.#inflight.delete(job.key));
    this.#inflight.set(job.key, promise);
    return promise;
  }

  async #produce(job: PdfJob): Promise<Buffer> {
    await this.#acquire();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const started = Date.now();
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new ShioriPdfTimeoutError(this.#config.timeoutMs));
          controller.abort();
        }, this.#config.timeoutMs);
      });
      const result = await Promise.race([
        this.#engine.render(job.html, this.#files, controller.signal),
        timeout,
      ]);
      console.info(
        JSON.stringify({
          kind: "shiori_pdf",
          key: job.key,
          ms: Date.now() - started,
          bytes: result.pdf.byteLength,
          blocked: result.blocked,
        }),
      );
      this.#cache.set(job.key, result.pdf);
      return result.pdf;
    } finally {
      clearTimeout(timer);
      this.#release();
    }
  }

  #acquire(): Promise<void> {
    if (this.#running < this.#config.concurrency) {
      this.#running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  #release(): void {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#running -= 1;
  }

  close(): Promise<void> {
    return this.#engine.close();
  }
}
