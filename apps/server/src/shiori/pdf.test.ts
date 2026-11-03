import { chromium } from "playwright-core";
import { afterAll, describe, expect, it } from "vitest";
import { loadShioriAssets } from "./assets";
import {
  ChromiumPdfEngine,
  PdfCache,
  type PdfEngine,
  pdfCacheKey,
  ShioriPdfBusyError,
  ShioriPdfService,
  ShioriPdfTimeoutError,
} from "./pdf";
import { renderShioriHtml } from "./render";
import { fictionalFestivals, fictionalOuting, lookupOf } from "./testTrips";
import { buildShioriView } from "./viewModel";

const LIMITS = { concurrency: 1, queue: 1, timeoutMs: 1000, cacheBytes: 1024 };

/** 呼ばれた回数を数え、resolve を呼ぶまで終わらない PDF の作り手 */
function fakeEngine() {
  const pending: (() => void)[] = [];
  let calls = 0;
  const engine: PdfEngine = {
    render: (html) => {
      calls += 1;
      return new Promise((resolve) =>
        pending.push(() => resolve({ pdf: Buffer.from(`%PDF ${html}`), blocked: 0 })),
      );
    },
    close: async () => {},
  };
  return {
    engine,
    finishAll: () => {
      for (const f of pending.splice(0)) f();
    },
    calls: () => calls,
  };
}

describe("PDF のキャッシュ", () => {
  it("合計の大きさを超えたら、古く使ったものから消す", () => {
    const cache = new PdfCache(10);
    cache.set("a", Buffer.alloc(4));
    cache.set("b", Buffer.alloc(4));
    cache.get("a");
    cache.set("c", Buffer.alloc(4));

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
  });

  it("キーは旅程の id と版と中身で変わる", () => {
    expect(pdfCacheKey("t", 1, "x")).not.toBe(pdfCacheKey("t", 2, "x"));
    expect(pdfCacheKey("t", 1, "x")).not.toBe(pdfCacheKey("t", 1, "y"));
    expect(pdfCacheKey("t", 1, "x")).toMatch(/^t@1#[0-9a-f]{16}$/);
  });
});

describe("PDF を作る数と時間の上限", () => {
  it("作った PDF はとっておき、同じものを作っている途中なら結果を分け合う", async () => {
    const { engine, finishAll, calls } = fakeEngine();
    const service = new ShioriPdfService(engine, new Map(), LIMITS);

    const first = service.get({ key: "k", html: "a" });
    const second = service.get({ key: "k", html: "a" });
    await Promise.resolve();
    finishAll();

    expect((await first).toString()).toBe("%PDF a");
    expect(await second).toBe(await first);
    expect(await service.get({ key: "k", html: "a" })).toBe(await first);
    expect(calls()).toBe(1);
  });

  it("同時に作る数を超えたら待たせ、待つ数も超えたら断る", async () => {
    const { engine, finishAll } = fakeEngine();
    const service = new ShioriPdfService(engine, new Map(), LIMITS);

    const running = service.get({ key: "a", html: "a" });
    const waiting = service.get({ key: "b", html: "b" });
    await Promise.resolve();

    expect(service.running).toBe(1);
    expect(service.waiting).toBe(1);
    await expect(service.get({ key: "c", html: "c" })).rejects.toBeInstanceOf(ShioriPdfBusyError);

    finishAll();
    await running;
    await new Promise((r) => setTimeout(r, 0));
    finishAll();
    await waiting;
    expect(service.running).toBe(0);
  });

  it("時間の上限を超えたら、作るのをやめて空きを返す", async () => {
    const aborted: boolean[] = [];
    const engine: PdfEngine = {
      render: (_html, _files, signal) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => {
            aborted.push(true);
            reject(new Error("closed"));
          }),
        ),
      close: async () => {},
    };
    const service = new ShioriPdfService(engine, new Map(), { ...LIMITS, timeoutMs: 20 });

    await expect(service.get({ key: "slow", html: "x" })).rejects.toBeInstanceOf(
      ShioriPdfTimeoutError,
    );
    expect(aborted).toEqual([true]);
    expect(service.running).toBe(0);
  });
});

// Chromium がない環境（CI など）では飛ばす
const hasChromium = await chromium.launch().then(
  (browser) => browser.close().then(() => true),
  () => false,
);

describe.skipIf(!hasChromium)("Chromium で PDF を作る", () => {
  const engine = new ChromiumPdfEngine();
  const assets = loadShioriAssets();
  afterAll(() => engine.close());

  it("しおりを A4 の PDF にし、外へのリクエストは1つも出さない", async () => {
    const view = buildShioriView(fictionalOuting(), lookupOf(fictionalFestivals()));
    const html = String(await renderShioriHtml(view, assets, { pdfHref: null }));

    const { pdf, blocked } = await engine.render(html, assets.files, new AbortController().signal);

    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(blocked).toBe(0);
    const text = pdf.toString("latin1");
    expect(text.match(/\/Type\s*\/Page[^s]/g)?.length).toBe(4);
    // A4（およそ 595 x 842 pt）
    expect(text).toMatch(/\/MediaBox\s*\[\s*0 0 59[45](?:\.\d+)? 84[12](?:\.\d+)?\s*\]/);
  }, 60_000);

  it("ページが外のものを読もうとしても、取りに行かずに止める", async () => {
    const html = `<!doctype html><html><body><img src="https://example.com/x.png"><link rel="stylesheet" href="http://example.com/a.css"><p>x</p></body></html>`;

    const { pdf, blocked } = await engine.render(html, new Map(), new AbortController().signal);

    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(blocked).toBe(2);
  }, 60_000);
});
