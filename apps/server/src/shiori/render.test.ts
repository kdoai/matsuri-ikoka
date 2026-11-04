import { fictionalResearchedLodgingSearch } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { loadShioriAssets, svgToSymbol } from "./assets";
import { chooseDesign } from "./design";
import { renderShioriHtml } from "./render";
import { shioriStyle } from "./style";
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
    for (const kind of ["hiyoko", "owl", "hen", "sparrow", "penguin"]) {
      expect(assets.files.get(`staff/face_${kind}.webp`)?.contentType).toBe("image/webp");
    }
    expect(assets.symbols.has("deco-shop-mark")).toBe(true);
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

  it("ページの数は、半日は薄く、泊まりは日ごとに増え、冊子にできるよう4の倍数にそろえる", async () => {
    const sections = async (trip: ShioriTrip) =>
      (await render(trip)).match(/<section class="sheet/g)?.length ?? 0;

    expect(await sections(fictionalOuting())).toBe(4);
    expect(await sections(fictionalWeekend())).toBe(12);
    expect(await sections(fictionalWeek())).toBe(20);
  });

  it("泊まりの旅は裏表紙で終わり、足りない分は旅の思い出のページで埋める", async () => {
    const page = await render(fictionalWeekend());

    expect(page.match(/aria-label="旅の思い出"/g)).toHaveLength(2);
    const sheets = [...page.matchAll(/<section class="sheet[^"]*" aria-label="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(sheets.at(-1)).toBe("裏表紙");
    expect(page).toContain("小冊子");
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

  it("泊まりに宿の候補があれば、名前と目安と宿のページの URL を文字で出す", async () => {
    const trip = fictionalWeekend();
    trip.days[0]!.stay = { area: "鈴鳴駅の周り", lodging: fictionalResearchedLodgingSearch() };
    const page = await render(trip);

    expect(page).toContain("鈴鳴川の宿");
    expect(page).toContain("会場から約0.1km・徒歩1〜2分（目安）");
    expect(page).toContain("https://example.com/inn/kawa");
    expect(page).not.toContain("宿の名前と予約は、ご自身で確かめてください。");
    expect(page).not.toMatch(/(?:src|href)="https?:/);
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

  it("スタッフのひとことは、顔の絵つきの吹き出しにし、絵はすべて素材にある", async () => {
    const page = await render(fictionalWeek());

    expect(page).toMatch(
      /<p class="bubble"><img class="face" src="assets\/staff\/face_[a-z]+\.webp" alt="" \/>/,
    );
    const files = [...page.matchAll(/src="assets\/(staff\/[a-z_]+\.webp)"/g)].map(
      (m) => m[1] as string,
    );
    expect(files).toContain("staff/face_hiyoko.webp");
    for (const file of files) expect(assets.files.has(file), file).toBe(true);
  });

  it("店の紋と名前を表紙の札に、店のスタンプをスタンプ帳に出す", async () => {
    const page = await render(fictionalWeekend());

    expect(page).toMatch(
      /<p class="ribbon">.*<span class="shop">たびや<\/span><span class="name">旅のしおり<\/span><\/p>/,
    );
    expect(page).toContain('<div class="shop-stamp">');
  });

  it("表紙に、祭りの種類の絵と町の風景、提灯・季節の飾り・うちわ・波・四隅の青海波を置く", async () => {
    const page = await render(fictionalWeekend());
    const cover = page.slice(page.indexOf('aria-label="表紙"'), page.indexOf("</section>"));

    for (const id of [
      "deco-lantern-cluster",
      "scene-town",
      "deco-corner",
      "season-summer",
      "deco-uchiwa",
      "deco-wave",
      `motif-${festivals[0]?.category}`,
    ]) {
      expect(cover).toContain(`href="#s-${id}"`);
    }
  });

  it("1日の流れは、ふりだしからあがりまで、番号と種類の色のマスでたどる", async () => {
    const page = await render(fictionalOuting());

    expect(page).toContain('<span class="koma">ふりだし</span>');
    expect(page).toContain('<span class="koma">あがり</span>');
    expect(page).toMatch(/<div class="step g-move">/);
    expect(page).toMatch(/<div class="step g-fest festival">/);
    expect(page).toContain('<b class="masu">1</b>');
    // 種類は色だけでなく文字でも書く
    expect(page).toContain('<span class="kind">移動</span>');
  });

  it("見どころ・作法・持ち物に小さな絵と、スタッフのひとことを添える", async () => {
    const page = await render(fictionalWeekend());

    for (const spot of ["lantern", "torii", "kinchaku", "dango"]) {
      expect(page).toContain(`href="#s-spot-${spot}"`);
    }
    expect(page).toContain("ここは見のがさないで！");
    expect(page).toContain("お願いを守って、地元の人と一緒に楽しもう");
    expect(page).toMatch(
      /<h3><svg class="ic" aria-hidden="true"><use href="#s-icon-bag"><\/use><\/svg>いつもの持ち物<\/h3>/,
    );
  });

  it("シニアと一緒の旅は文字を大きくする", async () => {
    const trip = fictionalOuting();
    trip.preferences.party = "seniors";
    expect(await render(trip)).toContain('<body class="large"');
  });
});

describe("見出しの札の色", () => {
  const design = chooseDesign(fictionalWeek(), festivals[0], "2026-08-16");
  const css = shioriStyle(design.palette);
  const rules = (selector: string) =>
    [...css.matchAll(/^([^{}\n]+)\{([^}]*)\}/gm)]
      .filter((m) => m[1]?.trim() === selector)
      .map((m) => m[2] ?? "");

  it("祭りの日は色の地、そうでない日は白い地にし、ほかのページの札は変えない", async () => {
    expect(rules(".festival-day .head .kicker").join("")).toMatch(/background:\s*var\(--accent\)/);
    expect(rules(".calm-day .head .kicker").join("")).toMatch(/background:\s*#fff/);
    // 範囲のない札の規則は、色の地の1つだけ
    const plain = rules(".head .kicker");
    expect(plain).toHaveLength(1);
    expect(plain[0]).toMatch(/background:\s*var\(--accent\)/);

    const page = await render(fictionalWeek());
    expect(page).toMatch(/class="sheet day-page festival-day"/);
    expect(page).toMatch(/class="sheet day-page calm-day"/);
  });
});

describe("しおりの動き", () => {
  const design = chooseDesign(fictionalOuting(), festivals[0], "2026-08-16");
  const css = shioriStyle(design.palette);
  const gate = "@media screen and (prefers-reduced-motion: no-preference)";

  it("動きは、画面で動きを減らさない設定のときだけ付け、印刷と PDF では最後の状態で止まる", () => {
    const at = css.indexOf(gate);
    expect(at).toBeGreaterThan(0);
    // 動きの前の CSS（印刷と PDF・動きを減らす設定で使う姿）には、animation を書かない
    expect(css.slice(0, at)).not.toMatch(/animation/);
    expect(css.slice(at)).toMatch(/animation:/);
    // 動きのあとに、ふつうの CSS を足さない（@keyframes だけ）
    const tail = css.slice(css.indexOf("@keyframes"));
    expect(tail.replace(/@keyframes [a-z-]+ \{[^\n]*\}\n?/g, "").trim()).toBe("");
  });

  it("動きはスクリプトを使わない", async () => {
    const page = await render(fictionalWeek());
    expect(page).not.toMatch(/<script|\son[a-z]+="/i);
    expect(page).toContain(gate);
  });
});
