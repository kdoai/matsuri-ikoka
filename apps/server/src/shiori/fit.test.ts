import { chromium } from "playwright-core";
import { afterAll, describe, expect, it } from "vitest";
import { loadShioriAssets } from "./assets";
import { lineCount, packBlocks, textUnits } from "./fit";
import { ChromiumPdfEngine, RENDER_ORIGIN } from "./pdf";
import { buildSheets, renderShioriHtml, spreadsOf } from "./render";
import {
  fictionalCrowdedDay,
  fictionalFestivals,
  fictionalOuting,
  fictionalWeek,
  fictionalWeekend,
  lookupOf,
} from "./testTrips";
import type { ShioriTrip } from "./trip";
import { buildShioriView } from "./viewModel";

describe("1ページに入る中身の見積もり", () => {
  it("半角の文字は全角より狭く数え、幅に入る文字の数で行を折り返す", () => {
    expect(textUnits("祭り")).toBe(2);
    expect(textUnits("ab")).toBeLessThan(textUnits("あい"));
    // 10.5pt は約 3.7mm。37mm の幅には10文字ほど入る
    expect(lineCount("あいうえおかきくけこ", 37, 10.5)).toBe(1);
    expect(lineCount("あいうえおかきくけこさしすせそ", 37, 10.5)).toBe(2);
    expect(lineCount("", 37, 10.5)).toBe(0);
  });

  it("かたまりを順にページへ詰め、入りきらない分を次のページに送る", () => {
    const blocks = [10, 40, 30, 50].map((mm, i) => ({ content: i, mm }));
    expect(packBlocks(blocks, 100, 100)).toEqual([[0, 1, 2], [3]]);
    // 1ページより高いかたまりも、落とさずに1ページに置く
    expect(packBlocks([{ content: "big", mm: 300 }], 100, 100)).toEqual([["big"]]);
  });

  it("見出しだけがページの最後に残らないよう、次のかたまりと離さない", () => {
    const blocks = [
      { content: "a", mm: 60 },
      { content: "title", mm: 10, keepWithNext: true },
      { content: "b", mm: 35 },
    ];
    expect(packBlocks(blocks, 100, 100)).toEqual([["a"], ["title", "b"]]);
  });

  it("予定の多い日は「つづき」のページに分け、ページの数は4の倍数のままにする", () => {
    const view = buildShioriView(fictionalCrowdedDay(), lookupOf(fictionalFestivals()));
    const sheets = buildSheets(view);
    expect(sheets.length % 4).toBe(0);
    const labels = sheets.map((s) => s.label);
    expect(labels).toContain("当日の流れ（つづき）");
    expect(labels.at(-1)).toBe("裏表紙");
  });
});

describe("見開き", () => {
  it("表紙と最後のページは1ページだけ、そのあいだは2ページずつ並べる", () => {
    expect(spreadsOf(4)).toEqual([[1], [2, 3], [4]]);
    expect(spreadsOf(8)).toEqual([[1], [2, 3], [4, 5], [6, 7], [8]]);
    expect(spreadsOf(5)).toEqual([[1], [2, 3], [4], [5]]);
    expect(spreadsOf(1)).toEqual([[1]]);
  });
});

// Chromium がない環境（CI など）では飛ばす
const hasChromium = await chromium.launch().then(
  (browser) => browser.close().then(() => true),
  () => false,
);

describe.skipIf(!hasChromium)("Chromium で組んだしおり", () => {
  const assets = loadShioriAssets();
  const engine = new ChromiumPdfEngine();
  afterAll(() => engine.close());
  const lookup = lookupOf(fictionalFestivals());
  const trips: Record<string, () => ShioriTrip> = {
    outing: fictionalOuting,
    weekend: fictionalWeekend,
    week: fictionalWeek,
    crowded: fictionalCrowdedDay,
  };

  it("どのページも中身が A4 1枚の紙からはみ出さず、PDF は紙の数と同じページ数で、すべて同じ大きさになる", async () => {
    const browser = await chromium.launch();
    try {
      for (const [name, make] of Object.entries(trips)) {
        const view = buildShioriView(make(), lookup);
        const html = String(await renderShioriHtml(view, assets, { pdfHref: null }));
        const context = await browser.newContext();
        await context.route("**/*", (route) => {
          const url = new URL(route.request().url());
          if (url.pathname === "/shiori/document") {
            return route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
          }
          const asset = assets.files.get(url.pathname.replace("/shiori/assets/", ""));
          return asset
            ? route.fulfill({ contentType: asset.contentType, body: asset.body })
            : route.abort();
        });
        const page = await context.newPage();
        await page.goto(`${RENDER_ORIGIN}/shiori/document`, { waitUntil: "load" });
        await page.emulateMedia({ media: "print" });
        // ページの中で動かす式（サーバーの型には DOM がないので、文字で渡す）
        const overflow = await page.evaluate<{ page: number; label: string; over: number }[]>(`
          document.fonts.ready.then(() =>
            [...document.querySelectorAll(".sheet")]
              .map((sheet, i) => {
                const flow = sheet.querySelector(".flow");
                const over = Math.max(
                  sheet.scrollHeight - sheet.clientHeight,
                  flow ? flow.scrollHeight - flow.clientHeight : 0,
                );
                return { page: i + 1, label: sheet.getAttribute("aria-label"), over };
              })
              .filter((s) => s.over > 1),
          )
        `);
        await context.close();
        expect(overflow, name).toEqual([]);

        const { pdf } = await engine.render(html, assets.files, new AbortController().signal);
        const text = pdf.toString("latin1");
        expect(text.match(/\/Type\s*\/Page[^s]/g)?.length, name).toBe(buildSheets(view).length);
        const boxes = new Set(text.match(/\/MediaBox\s*\[[^\]]*\]/g));
        expect(boxes.size, name).toBe(1);
      }
    } finally {
      await browser.close();
    }
  }, 120_000);
});
