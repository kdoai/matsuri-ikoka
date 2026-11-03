import { describe, expect, it } from "vitest";
import { loadShioriAssets, svgToSymbol } from "./assets";
import { renderShioriHtml } from "./render";
import {
  fictionalFestivals,
  fictionalOuting,
  fictionalWeek,
  fictionalWeekend,
  lookupOf,
} from "./testTrips";
import type { ShioriTrip } from "./trip";
import { buildShioriView } from "./viewModel";

const assets = loadShioriAssets();
const festivals = fictionalFestivals();

async function render(
  trip: ShioriTrip,
  pdfHref: string | null = null,
  lookup = lookupOf(festivals),
) {
  return String(await renderShioriHtml(buildShioriView(trip, lookup), assets, { pdfHref }));
}

describe("素材", () => {
  it("フォントとそのライセンス、スタッフの静止画、SVG がそろっている", () => {
    expect(assets.files.get("fonts/ZenMaruGothic-Medium.woff2")?.contentType).toBe("font/woff2");
    expect(assets.files.get("fonts/ZenMaruGothic-Black.woff2")).toBeDefined();
    expect(assets.files.get("fonts/OFL.txt")).toBeDefined();
    for (const still of [
      "hiyoko_wave",
      "owl_book",
      "hen_point",
      "sparrow_binder",
      "penguin_cheer",
    ]) {
      expect(assets.files.get(`staff/${still}.webp`)?.contentType).toBe("image/webp");
    }
    for (const category of ["fireworks", "float", "mikoshi", "dance", "fire", "lantern"]) {
      expect(assets.symbols.has(`motif-${category}`)).toBe(true);
    }
  });

  it("動きや外への参照を持つ SVG は読み込まない", () => {
    const ok =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h1"/></svg>';
    expect(svgToSymbol("ok", ok)).toBe(
      '<symbol id="s-ok" viewBox="0 0 24 24"><path d="M0 0h1"/></symbol>',
    );
    for (const bad of [
      '<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>',
      '<svg viewBox="0 0 1 1"><a href="https://example.com/">x</a></svg>',
      '<svg viewBox="0 0 1 1"><rect onclick="x()"/></svg>',
      '<svg viewBox="0 0 1 1"><image href="https://example.com/x.png"/></svg>',
      '<svg viewBox="0 0 1 1"><rect style="fill:url(https://example.com/x)"/></svg>',
    ]) {
      expect(() => svgToSymbol("bad", bad)).toThrow();
    }
  });
});

describe("しおりの HTML", () => {
  it("旅程や祭りのデータの文字列は、エスケープして文字として出す", async () => {
    const trip = fictionalOuting();
    trip.title = "<script>alert(1)</script>";
    const item = trip.days[0]?.items[1];
    if (item) item.reason = '<img src="https://example.com/x.png" onerror="alert(1)">';
    const evil = fictionalFestivals();
    if (evil[0]) evil[0].highlights = ["<b>強い</b>"];

    const page = await render(trip, null, lookupOf(evil));

    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(page).not.toContain('<img src="https://example.com');
    expect(page).not.toContain("<b>強い</b>");
    expect(page).not.toMatch(/<script/i);
  });

  it("外のものを読み込まない（素材はしおりの URL の下、出典の URL は文字だけ）", async () => {
    const page = await render(fictionalWeek());

    expect(page).not.toMatch(/(?:src|href)="https?:/);
    expect(page).not.toMatch(/url\(\s*["']?https?:/);
    expect(page).toContain("https://example.com/suzunari/2026");
    expect(page).toMatch(/src="assets\/staff\/[a-z_]+\.webp"/);
  });

  it("使う SVG の symbol は、すべて素材にある", async () => {
    for (const trip of [fictionalOuting(), fictionalWeekend(), fictionalWeek()]) {
      const page = await render(trip);
      const used = [...page.matchAll(/href="#s-([a-z_-]+)"/g)].map((m) => m[1] as string);
      expect(used.length).toBeGreaterThan(10);
      for (const name of used) expect(assets.symbols.has(name), name).toBe(true);
    }
  });

  it("ページの数は、半日は薄く、泊まりは日ごとに増える", async () => {
    const sections = async (trip: ShioriTrip) =>
      (await render(trip)).match(/<section class="sheet/g)?.length ?? 0;

    expect(await sections(fictionalOuting())).toBe(4);
    expect(await sections(fictionalWeekend())).toBe(9);
    expect(await sections(fictionalWeek())).toBe(16);
  });

  it("画面で見るときだけ、PDF のリンクを出す", async () => {
    expect(await render(fictionalOuting(), "trip-suzunari.pdf")).toContain(
      'href="trip-suzunari.pdf"',
    );
    expect(await render(fictionalOuting(), null)).not.toContain('<nav class="toolbar"');
  });

  it("はじめての方へは日本語と英語で出し、分からない項目を示す", async () => {
    const page = await render(fictionalWeek());

    expect(page).toContain("はじめての方へ");
    expect(page).toContain("For first-time visitors");
    expect(page).toContain('<span class="unknown">分からない</span>');
    expect(page).toContain("Requests from the organizers");
  });

  it("泊まりの旅では、日ごとに泊まる地域とメモの欄を出す", async () => {
    const page = await render(fictionalWeekend());

    expect(page).toContain("今夜泊まる地域");
    expect(page).toContain("鈴鳴駅の周り");
    // 1日目は予定が多く雨の日の案もあるので、メモ欄は2日目だけ
    expect(page.match(/この日のメモ/g)).toHaveLength(1);
  });

  it("泊まりの旅には旅のかたちの図を入れ、日帰りには入れない", async () => {
    const week = await render(fictionalWeek());
    expect(week).toContain("旅のかたち：<b>地域を巡る旅</b>");
    expect(week.match(/<div class="stop /g)).toHaveLength(5);
    expect(week).not.toMatch(/<image|https?:\/\/[^"<]*\.(?:png|jpe?g)/);
    expect(await render(fictionalOuting())).not.toContain('class="route"');
  });

  it("祭りの日とそうでない日で、ページの見た目を変える", async () => {
    const page = await render(fictionalWeek());
    expect(page.match(/day-page festival-day/g)).toHaveLength(2);
    expect(page.match(/day-page calm-day/g)).toHaveLength(5);
  });

  it("シニアと一緒の旅は文字を大きくする", async () => {
    const trip = fictionalOuting();
    trip.preferences.party = "seniors";
    expect(await render(trip)).toContain('<body class="large"');
  });
});
