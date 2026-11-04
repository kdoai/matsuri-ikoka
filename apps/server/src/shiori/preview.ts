import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { loadShioriAssets } from "./assets";
import { ChromiumPdfEngine, RENDER_ORIGIN } from "./pdf";
import { buildSheets, renderShioriHtml } from "./render";
import {
  fictionalCrowdedDay,
  fictionalFestivals,
  fictionalOuting,
  fictionalWeek,
  fictionalWeekend,
} from "./testTrips";
import type { ShioriTrip } from "./trip";
import { buildShioriView } from "./viewModel";

// しおりを手元で確かめる。架空の旅（半日・1泊・6泊）ごとに、HTML・PDF・画像を書き出す。
//
//   pnpm --filter @matsuri-ikoka/server exec tsx src/shiori/preview.ts <出力先のフォルダ>
//
// 書き出すもの（<旅>は outing・weekend・week・crowded（予定の多い日帰り））
//   <旅>.html                  画面で見るしおり（assets/ を隣に置くので、ブラウザでそのまま開ける）
//   <旅>.pdf                   PDF（サーバーと同じ作り方。A4・外へのリクエストなし）
//   <旅>-screen.png            画面で、表紙（動きが終わったところ）
//   <旅>-spread.png            画面で、2つ目の見開き（2〜3ページ）
//   <旅>-moving.png            画面で、動きの途中（表紙が開く・スタンプが落ちる途中）
//   <旅>-reduced.png           動きを減らす設定のとき（最初から最後の状態）
//   <旅>-mobile.png            スマートフォンの幅

const TRIPS: Record<string, () => ShioriTrip> = {
  outing: fictionalOuting,
  weekend: fictionalWeekend,
  week: fictionalWeek,
  crowded: fictionalCrowdedDay,
};

const out = path.resolve(process.argv[2] ?? "shiori-preview");
mkdirSync(path.join(out, "assets"), { recursive: true });

const assets = loadShioriAssets();
for (const [file, asset] of assets.files) {
  mkdirSync(path.dirname(path.join(out, "assets", file)), { recursive: true });
  writeFileSync(path.join(out, "assets", file), asset.body);
}

const lookup = (() => {
  const festivals = fictionalFestivals();
  return (id: string) => festivals.find((f) => f.id === id);
})();

const engine = new ChromiumPdfEngine();
const browser = await chromium.launch();
try {
  for (const [name, make] of Object.entries(TRIPS)) {
    const view = buildShioriView(make(), lookup);
    const screenHtml = String(await renderShioriHtml(view, assets, { pdfHref: `${name}.pdf` }));
    const pdfHtml = String(await renderShioriHtml(view, assets, { pdfHref: null }));
    writeFileSync(path.join(out, `${name}.html`), screenHtml);

    const { pdf, blocked } = await engine.render(
      pdfHtml,
      assets.files,
      new AbortController().signal,
    );
    writeFileSync(path.join(out, `${name}.pdf`), pdf);

    const shots: {
      suffix: string;
      width: number;
      height: number;
      reduced: boolean;
      wait: number | null;
      hash?: string;
    }[] = [
      { suffix: "screen", width: 1600, height: 900, reduced: false, wait: null },
      { suffix: "spread", width: 1600, height: 900, reduced: false, wait: null, hash: "#s2" },
      { suffix: "moving", width: 1600, height: 900, reduced: false, wait: 450 },
      { suffix: "reduced", width: 1600, height: 900, reduced: true, wait: 0 },
      { suffix: "mobile", width: 390, height: 844, reduced: false, wait: null, hash: "#s2" },
    ];
    for (const shot of shots) {
      const context = await browser.newContext({
        javaScriptEnabled: false,
        viewport: { width: shot.width, height: shot.height },
        reducedMotion: shot.reduced ? "reduce" : "no-preference",
      });
      // サーバーと同じく、ページと素材だけを手元から返す
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/shiori/document") {
          return route.fulfill({ contentType: "text/html; charset=utf-8", body: screenHtml });
        }
        const asset = assets.files.get(url.pathname.replace("/shiori/assets/", ""));
        return asset
          ? route.fulfill({ contentType: asset.contentType, body: asset.body })
          : route.abort();
      });
      const page = await context.newPage();
      await page.goto(`${RENDER_ORIGIN}/shiori/document${shot.hash ?? ""}`, { waitUntil: "load" });
      // 見開きへ送るリンクはなめらかに動くので、送り終わるのを待つ
      await page.waitForTimeout(shot.wait ?? (shot.hash ? 1500 : 0));
      await page.screenshot({
        path: path.join(out, `${name}-${shot.suffix}.png`),
        // 動きの途中を撮るとき以外は、動きを終わりまで進めて撮る
        animations: shot.wait === null ? "disabled" : "allow",
      });
      await context.close();
    }
    console.info(`${name}: ${buildSheets(view).length} ページ・外へのリクエスト ${blocked} 件`);
  }
} finally {
  await browser.close();
  await engine.close();
}
console.info(`書き出し先：${out}`);
