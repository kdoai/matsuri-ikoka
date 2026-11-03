import type { Palette } from "./design";

// しおりの CSS。A4 縦で印刷し、画面ではページを紙のカードとして並べる。
// 文字は屋外でも読めるよう、本文 10.5pt 以上・濃い色（白地で 7:1 以上）にする。

const BASE = String.raw`
@font-face { font-family: "ShioriMaru"; font-weight: 100 600; font-display: block; src: url("assets/fonts/ZenMaruGothic-Medium.woff2") format("woff2"); }
@font-face { font-family: "ShioriMaru"; font-weight: 700 900; font-display: block; src: url("assets/fonts/ZenMaruGothic-Black.woff2") format("woff2"); }

@page { size: A4; margin: 11mm 12mm 13mm;
  @bottom-center { content: counter(page) " / " counter(pages); font-family: "ShioriMaru", sans-serif; font-size: 9pt; color: #4a4038; } }
@page cover { margin: 7mm; @bottom-center { content: none; } }

:root { color-scheme: light; --ink: #1e1a17; --sub: #4a4038; --line: #d9cfc0; --paper: #ffffff; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font-family: "ShioriMaru", "Hiragino Maru Gothic ProN", "Noto Sans JP", sans-serif; font-weight: 500;
  font-size: 10.5pt; line-height: 1.6; color: var(--ink); background: var(--paper); font-feature-settings: "palt" 0; }
body.large { font-size: 12pt; }
h1, h2, h3, h4, p, ul, ol, dl, dd { margin: 0; }
ul, ol { padding: 0; list-style: none; }
b, strong, h1, h2, h3, h4 { font-weight: 900; }
.sprite { position: absolute; width: 0; height: 0; overflow: hidden; }
.ic { width: 1.25em; height: 1.25em; flex: none; vertical-align: -0.25em; color: var(--accent); }
.en { font-size: 0.82em; color: var(--sub); font-weight: 500; letter-spacing: 0.01em; }
.muted { color: var(--sub); }
.toolbar { display: none; }

.sheet { position: relative; break-before: page; }
.sheet:first-of-type { break-before: auto; }
.keep { break-inside: avoid; }

/* ---- 見出しの帯 ---- */
.head { position: relative; display: flex; align-items: flex-end; gap: 4mm; min-height: 30mm; margin-bottom: 5mm; padding-right: 30mm; }
.head .title { flex: 1; }
.head .kicker { display: inline-block; background: var(--accent); color: var(--on-accent); font-weight: 900; font-size: 9.5pt; letter-spacing: 0.08em; padding: 0.6mm 3mm; border-radius: 99px; }
.head h2 { font-size: 22pt; line-height: 1.25; color: var(--ink); margin-top: 1.5mm; }
.head h2 .en { display: block; font-size: 10pt; margin-top: 0.5mm; }
.head .wave { display: block; width: 100%; height: 4mm; margin-top: 2mm; color: var(--accent); --wave: var(--accent); opacity: 0.55; }
.head .staff { position: absolute; right: -2mm; bottom: -3mm; height: 33mm; width: auto; }
.bubble { position: relative; display: inline-block; margin-top: 2mm; background: #fff; border: 0.5mm solid var(--ink); border-radius: 4mm; padding: 1.2mm 3mm; font-size: 9.5pt; }
.bubble .who { color: var(--accent); font-weight: 900; margin-right: 1.5mm; }

/* ---- 箱とチップ ---- */
.box { background: var(--soft); border-radius: 4mm; padding: 3.5mm 4.5mm; margin-top: 4mm; }
.box.line { background: #fff; border: 0.6mm solid var(--line); }
.box.alert { background: #fff; border: 0.8mm solid var(--accent); }
.box h3 { display: flex; align-items: center; gap: 1.8mm; font-size: 12.5pt; color: var(--accent); margin-bottom: 1.5mm; }
.box h3 .ic, .section-title .ic { width: 5mm; height: 5mm; }
.section-title { display: flex; align-items: center; gap: 1.8mm; font-size: 13pt; color: var(--accent); margin-bottom: 2.5mm; }
.chips { display: flex; flex-wrap: wrap; gap: 1.5mm; margin-top: 2mm; }
.chip { display: inline-flex; align-items: center; gap: 1mm; border: 0.4mm solid var(--ink); border-radius: 99px; padding: 0.3mm 2.6mm; font-size: 9.5pt; background: #fff; }
.dots li { position: relative; padding-left: 4.2mm; margin: 0.6mm 0; }
.dots li::before { content: ""; position: absolute; left: 0.6mm; top: 0.62em; width: 1.8mm; height: 1.8mm; border-radius: 50%; background: var(--accent); }
.unknown { display: inline-block; border: 0.4mm dashed var(--sub); border-radius: 1.5mm; padding: 0 1.8mm; color: var(--sub); font-weight: 900; }
.tape { position: absolute; width: 30mm; height: 9mm; color: var(--ink); --tape: var(--c2); }

/* ---- 表紙 ---- */
.cover { page: cover; height: 283mm; overflow: hidden; border-radius: 6mm; background: var(--cover-bg); color: var(--cover-ink);
  --ink-on: var(--cover-ink); padding: 14mm 13mm 0; display: flex; flex-direction: column; }
.cover .bunting { position: absolute; left: 0; right: 0; top: 0; width: 100%; height: 18mm; color: var(--cover-ink); }
.cover .season { position: absolute; width: 70mm; height: 70mm; color: var(--cover-ink); opacity: 0.9; }
.cover .season.a { right: -12mm; top: 14mm; }
.cover .brand { position: relative; font-weight: 900; letter-spacing: 0.2em; font-size: 10pt; margin-top: 4mm; }
.cover .length { position: relative; display: inline-block; align-self: flex-start; margin-top: 3mm; background: var(--accent); color: var(--on-accent);
  font-weight: 900; font-size: 13pt; padding: 1mm 5mm; border-radius: 99px; border: 0.6mm solid var(--cover-ink); }
.cover h1 { position: relative; font-size: 34pt; line-height: 1.22; margin-top: 4mm; max-width: 108mm; overflow-wrap: anywhere; }
.cover h1.long { font-size: 27pt; }
.cover .motif { position: absolute; right: 8mm; top: 70mm; width: 86mm; height: 86mm; color: #1e1a17; }
.cover .motif-bg { position: absolute; right: 2mm; top: 64mm; width: 98mm; height: 98mm; border-radius: 50%; background: var(--cover-ink); opacity: 0.12; }
.cover .festival { position: relative; margin-top: 6mm; max-width: 100mm; }
.cover .festival .label { font-size: 10pt; font-weight: 900; opacity: 0.9; }
.cover .festival .name { font-size: 19pt; font-weight: 900; line-height: 1.3; }
.cover .festival .en { color: inherit; opacity: 0.85; display: block; }
.cover .festival .place { font-size: 10.5pt; margin-top: 1mm; }
.ticket { position: relative; margin-top: auto; margin-bottom: 4mm; background: #fffaf0; color: #1e1a17; border: 0.6mm solid #1e1a17; border-radius: 4mm;
  display: grid; grid-template-columns: 1fr 1fr; gap: 2mm 6mm; padding: 4mm 6mm; width: 118mm; }
.ticket dt { font-size: 9pt; color: #4a4038; display: flex; align-items: center; gap: 1.2mm; }
.ticket dd { font-weight: 900; font-size: 11.5pt; line-height: 1.35; }
.ticket .wide { grid-column: 1 / -1; }
.cover .verified { position: absolute; right: 12mm; bottom: 74mm; width: 46mm; text-align: center; color: #b8302a; font-weight: 900; font-size: 8.5pt; line-height: 1.35;
  background: #fffaf0; border: 0.8mm solid #b8302a; border-radius: 50%; aspect-ratio: 1; display: flex; flex-direction: column; justify-content: center; padding: 4mm; transform: rotate(-8deg); }
.cover .verified .ic { width: 9mm; height: 9mm; margin: 0 auto 1mm; color: #b8302a; --crest: #b8302a; }
.cover .crew { position: relative; display: flex; align-items: flex-end; gap: 2mm; height: 48mm; margin: 0 -4mm; }
.cover .crew img { height: 44mm; width: auto; }
.cover .crew img.main { height: 48mm; }
.cover .crew .bubble { color: #1e1a17; margin-bottom: 20mm; max-width: 86mm; }
.cover .highlights { position: relative; margin-top: 4mm; background: #fffaf0; color: #1e1a17; border-radius: 4mm; padding: 3mm 4.5mm; max-width: 112mm; border: 0.6mm solid #1e1a17; }
.cover .highlights h3 { font-size: 11pt; color: var(--accent); }

/* ---- 祭りのページ ---- */
.fest-name { font-size: 24pt; line-height: 1.25; }
.when li { font-weight: 900; font-size: 12pt; }
.cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3mm; margin-top: 2mm; }
.card { background: #fff; border: 0.6mm solid var(--ink); border-radius: 4mm; padding: 3mm; position: relative; padding-top: 6mm; }
.card .num { position: absolute; top: -3.5mm; left: 3mm; width: 7mm; height: 7mm; border-radius: 50%; background: var(--accent); color: var(--on-accent);
  font-weight: 900; display: flex; align-items: center; justify-content: center; font-size: 10pt; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 4mm; }
.with-staff { display: grid; grid-template-columns: 1fr 26mm; gap: 3mm; align-items: end; }
.with-staff img { width: 26mm; height: auto; }
.trivia { border-left: 1.4mm solid var(--c2); padding-left: 3mm; margin-top: 1.5mm; }

/* ---- 1日の流れ ---- */
.day-head { display: flex; align-items: center; gap: 3mm; flex-wrap: wrap; }
.day-no { font-size: 26pt; font-weight: 900; color: var(--accent); line-height: 1; }
.weather { display: inline-flex; align-items: center; gap: 1.5mm; background: var(--soft); border-radius: 99px; padding: 0.8mm 3mm; font-size: 9.5pt; }
.timeline { position: relative; margin-top: 3mm; }
.timeline::before { content: ""; position: absolute; left: 25mm; top: 2mm; bottom: 2mm; border-left: 0.8mm dotted var(--accent); }
.step { position: relative; display: grid; grid-template-columns: 21mm 8mm 1fr; gap: 0 2mm; padding: 1.6mm 0; break-inside: avoid; }
.step .time { font-weight: 900; font-size: 10pt; text-align: right; padding-top: 0.6mm; font-variant-numeric: tabular-nums; line-height: 1.3; }
.step .dot { position: relative; z-index: 1; width: 8mm; height: 8mm; border-radius: 50%; background: #fff; border: 0.6mm solid var(--accent); display: flex; align-items: center; justify-content: center; }
.step .dot .ic { width: 4.6mm; height: 4.6mm; }
.step .body { padding: 0.4mm 2mm 1.2mm; }
.step .name { font-weight: 900; font-size: 11.5pt; line-height: 1.4; }
.step .kind { display: inline-block; font-size: 8.5pt; color: var(--sub); border: 0.3mm solid var(--line); border-radius: 99px; padding: 0 1.8mm; margin-right: 1.5mm; vertical-align: 0.15em; }
.step .details { font-size: 9.5pt; color: var(--sub); }
.step.festival .body { background: var(--soft); border: 0.7mm solid var(--accent); border-radius: 3mm; padding: 1.6mm 3mm 2mm; }
.step.festival .dot { background: var(--accent); }
.step.festival .dot .ic { color: var(--on-accent); }
.endpoint { display: flex; align-items: center; gap: 2mm; font-weight: 900; margin: 1mm 0 1mm 21.5mm; }
.endpoint .ic { width: 6mm; height: 6mm; }
.stay { display: flex; gap: 3mm; align-items: center; }
.stay .ic { width: 9mm; height: 9mm; }
.stay .area { font-size: 13pt; font-weight: 900; }

/* ---- 旅の全体 ---- */
.overview li { display: grid; grid-template-columns: 12mm 30mm 1fr 52mm; gap: 2mm; align-items: center; padding: 2.2mm 0; border-bottom: 0.4mm dashed var(--line); }
.overview .no { width: 10mm; height: 10mm; border-radius: 50%; background: var(--accent); color: var(--on-accent); font-weight: 900; display: flex; align-items: center; justify-content: center; }
.overview .summary { font-weight: 900; display: flex; gap: 1.5mm; align-items: center; }
.overview .night { display: flex; gap: 1.2mm; align-items: center; font-size: 9.5pt; }

/* ---- 旅のかたちの図 ---- */
.route-box { border: 0.6mm solid var(--line); border-radius: 4mm; padding: 3mm 4mm 2mm; margin-bottom: 4mm; background: #fff; }
.route-title { display: flex; align-items: center; gap: 1.5mm; font-size: 11pt; }
.route-title b { color: var(--accent); }
.route { position: relative; width: 100%; aspect-ratio: 2 / 1; margin-top: 1mm; }
.route > svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.route .road { fill: none; stroke: var(--soft); stroke-width: 9; stroke-linecap: round; vector-effect: non-scaling-stroke; }
.route .trail { fill: none; stroke: var(--accent); stroke-width: 2.2; stroke-dasharray: 2 6; stroke-linecap: round; vector-effect: non-scaling-stroke; }
.stop { position: absolute; transform: translate(-50%, -6mm); width: 34mm; text-align: center; line-height: 1.3; }
.stop .pin { display: flex; width: 12mm; height: 12mm; margin: 0 auto; border-radius: 50%; align-items: center; justify-content: center;
  background: #fff; border: 0.8mm solid var(--accent); color: var(--accent); font-size: 13pt; }
.stop .pin .ic { width: 6mm; height: 6mm; }
.stop.fest .pin { background: var(--accent); color: var(--on-accent); border-color: var(--ink); }
.stop.start .pin, .stop.end .pin, .stop.start_end .pin { border-style: dashed; }
.stop .name { display: block; margin-top: 1mm; font-weight: 900; font-size: 9.5pt; overflow-wrap: anywhere; background: rgba(255, 255, 255, 0.85); border-radius: 2mm; }
.stop .sub { display: inline-flex; align-items: center; gap: 0.6mm; font-size: 8.5pt; color: var(--sub); }
.stop .sub .ic { width: 3.6mm; height: 3.6mm; }

/* ---- 祭りの日とそうでない日 ---- */
.festival-day .day-motif { width: 13mm; height: 13mm; color: var(--ink); }
.festival-day .day-bunting { display: block; width: 100%; height: 11mm; margin: 0 0 2mm; color: var(--ink); }
.festival-day .head .kicker { background: var(--accent); }
.festival-day .day-no { color: var(--accent); }
.calm-day .head .kicker { background: #fff; color: var(--ink); border: 0.5mm solid var(--ink); }
.calm-day .day-no { color: var(--ink); }
.calm-day .timeline::before { border-left-style: dashed; border-left-color: var(--sub); }
.calm-day .step .dot { border-color: var(--sub); }
.calm-day .step .dot .ic { color: var(--ink); }

/* ---- はじめての方へ ---- */
.guide { width: 100%; border-collapse: collapse; margin-top: 3mm; }
.guide th, .guide td { border-bottom: 0.4mm solid var(--line); padding: 2mm 1.5mm; vertical-align: top; text-align: left; }
.guide th { width: 40mm; }
.guide th .lbl { display: flex; align-items: center; gap: 1.5mm; font-weight: 900; }
.guide th .en { display: block; padding-left: 6.8mm; }
.guide td .en { display: block; }
.guide tr { break-inside: avoid; }

/* ---- 持ち物 ---- */
.checks { columns: 2; column-gap: 6mm; }
.checks .group { break-inside: avoid; margin-bottom: 4mm; }
.checks h3 { font-size: 12pt; color: var(--accent); }
.checks .note { font-size: 8.5pt; color: var(--sub); }
.checks li { display: flex; gap: 2mm; align-items: flex-start; margin: 1.2mm 0; }
.checks li::before { content: ""; flex: none; width: 4.4mm; height: 4.4mm; margin-top: 0.3em; border: 0.6mm solid var(--ink); border-radius: 1mm; background: #fff; }

/* ---- スタンプとメモ ---- */
.stamps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5mm 4mm; margin-top: 3mm; }
.stamps.small { grid-template-columns: repeat(5, 1fr); gap: 2mm; }
.stamp { text-align: center; }
.stamp .ring { position: relative; width: 44mm; height: 44mm; margin: 0 auto; color: var(--accent); }
.stamps.small .ring { width: 22mm; height: 22mm; }
.stamps.small .lbl { font-size: 9pt; }
.stamp .ring svg { width: 100%; height: 100%; }
.stamp .lbl { font-weight: 900; font-size: 10pt; line-height: 1.3; margin-top: 1mm; overflow-wrap: anywhere; }
.stamp .sub { font-size: 8.5pt; color: var(--sub); }
.crest { position: absolute; width: 22mm; height: 22mm; right: 36mm; top: 4mm; transform: rotate(12deg); opacity: 0.9; --crest: #b8302a; }
.draw { display: grid; grid-template-columns: 1fr 1fr; gap: 4mm; margin-top: 4mm; }
.draw div { height: 44mm; border: 0.6mm dashed var(--ink); border-radius: 4mm; padding: 2mm 3mm; font-weight: 900; font-size: 10pt; }
.memo { display: grid; grid-template-columns: 1fr 1fr; gap: 4mm; margin-top: 4mm; }
.memo .box { margin-top: 0; }
.memo-box .ln { height: 8mm; border-bottom: 0.4mm dashed var(--line); }

/* ---- 出典 ---- */
.sources li { padding: 1.2mm 0; border-bottom: 0.3mm dashed var(--line); break-inside: avoid; counter-increment: src; display: grid; grid-template-columns: 8mm 1fr; }
.sources li::before { content: counter(src); font-weight: 900; color: var(--accent); }
.sources .t { font-weight: 900; font-size: 10pt; overflow-wrap: anywhere; }
.sources .url { font-size: 9pt; overflow-wrap: anywhere; word-break: break-all; color: var(--ink); }
.sources .meta { font-size: 8.5pt; color: var(--sub); margin-left: 1mm; word-break: normal; }
.sources { counter-reset: src; }
.two-col .sources { columns: 2; column-gap: 5mm; }
.closing { margin-top: 4mm; font-weight: 900; }
.box .closing { margin-top: 2mm; }

/* ---- 画面で見るとき ---- */
@media screen {
  body { background: #e9e1d4; padding: 0 0 12mm; }
  .toolbar { display: flex; justify-content: center; gap: 12px; padding: 14px 16px; position: sticky; top: 0; z-index: 5; background: #e9e1d4; }
  .toolbar a { display: inline-flex; align-items: center; gap: 8px; background: var(--accent); color: var(--on-accent); font-weight: 900; text-decoration: none; padding: 10px 20px; border-radius: 99px; font-size: 16px; }
  .sheet { width: 210mm; max-width: calc(100% - 24px); margin: 0 auto 10mm; background: var(--paper); padding: 12mm; border-radius: 4mm; box-shadow: 0 2px 10px rgba(60, 40, 20, 0.18); }
  .cover { min-height: 283mm; height: auto; padding-bottom: 0; }
  .sheet.cover { background: var(--cover-bg); }
}
@media screen and (max-width: 820px) {
  body { font-size: 16px; }
  .sheet { padding: 16px; border-radius: 12px; }
  .cover { min-height: 0; }
  .cover h1 { font-size: 28px; }
  .cover .motif, .cover .motif-bg { position: relative; right: auto; top: auto; width: 150px; height: 150px; margin: 8px auto 0; display: block; }
  .cover .motif-bg { display: none; }
  .cover .verified { position: relative; right: auto; bottom: auto; margin: 8px 0 0 auto; width: 150px; }
  .ticket { width: auto; grid-template-columns: 1fr; }
  .head { padding-right: 90px; }
  .head .staff { height: 96px; }
  .cards, .two, .stamps { grid-template-columns: 1fr; }
  .checks { columns: 1; }
  .overview li { grid-template-columns: 40px 1fr; }
  .guide th { width: 34%; }
}
`;

export function shioriStyle(palette: Palette): string {
  const vars = [
    `--accent: ${palette.accent}`,
    `--on-accent: ${palette.onAccent}`,
    `--soft: ${palette.soft}`,
    `--cover-bg: ${palette.coverBg}`,
    `--cover-ink: ${palette.coverInk}`,
    `--c1: ${palette.c1}`,
    `--c2: ${palette.c2}`,
    `--c3: ${palette.c3}`,
    `--s1: ${palette.s1}`,
    `--s2: ${palette.s2}`,
    `--s3: ${palette.s3}`,
  ].join("; ");
  return `${BASE}\n:root { ${vars}; }\n`;
}
