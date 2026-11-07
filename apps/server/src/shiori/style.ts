import type { Palette } from "./design";

// しおりの CSS。A4 縦で印刷し、画面ではページを紙のカードとして並べる。
// 文字は屋外でも読めるよう、本文 10.5pt 以上・濃い色（白地で 7:1 以上）にする。
//
// 動きの決まり：BASE は「動きが終わったあとの姿」だけを書き、animation は MOTION にだけ書く。
// MOTION は @media screen and (prefers-reduced-motion: no-preference) の中にあるので、
// 印刷・PDF・動きを減らす設定では動かず、最後の状態の静止画として読める。

const BASE = String.raw`
@font-face { font-family: "ShioriMaru"; font-weight: 100 600; font-display: block; src: url("assets/fonts/ZenMaruGothic-Medium.woff2") format("woff2"); }
@font-face { font-family: "ShioriMaru"; font-weight: 700 900; font-display: block; src: url("assets/fonts/ZenMaruGothic-Black.woff2") format("woff2"); }

@page { size: A4; margin: 0; }

:root { color-scheme: light; --ink: #1e1a17; --sub: #4a4038; --line: #d9cfc0; --paper: #fbf4e4; --card: #fffdf7; --navy: #22396b; --gold: #c9973a; }
html { background: var(--paper); }
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

/* どのページも A4 1枚の決まった大きさの紙。中身は render.ts でページに詰め、はみ出す分は「つづき」のページに送る */
.page { width: 210mm; height: 297mm; padding: 6mm; overflow: hidden; background: var(--paper); break-before: page; break-inside: avoid; }
.spread:first-child .page:first-child { break-before: auto; }
.sheet { position: relative; height: 100%; overflow: hidden; display: flex; flex-direction: column; background: var(--paper); color: var(--ink);
  border: 1.2mm double var(--navy); border-radius: 3mm; padding: 7mm 9mm 10mm; }
.flow { flex: 1; min-height: 0; }
.folio { position: absolute; left: 0; right: 0; bottom: 2.5mm; text-align: center; font-size: 8.5pt; color: var(--sub); }
.turn, .where { display: none; }
.highlights-block { margin-top: 6mm; }
.keep { break-inside: avoid; }

/* ---- 見出しの帯 ---- */
.head { position: relative; display: flex; align-items: flex-end; gap: 4mm; min-height: 24mm; margin-bottom: 3mm; padding-right: 30mm; }
.head .title { flex: 1; }
.kick { display: flex; flex-wrap: wrap; align-items: center; gap: 1mm 2mm; }
.shop-tag { display: inline-flex; white-space: nowrap; align-items: center; gap: 0.8mm; font-weight: 900; font-size: 9pt; color: var(--navy); letter-spacing: 0.08em; }
.mark-mini { width: 5.2mm; height: 5.2mm; color: var(--navy); --mark-bg: #fff; }
.head .kicker { display: inline-block; background: var(--accent); color: var(--on-accent); font-weight: 900; font-size: 9.5pt; letter-spacing: 0.08em; padding: 0.6mm 3mm; border-radius: 99px; }
.banner { display: flex; align-items: center; margin-top: 1.5mm; font-size: 20pt; line-height: 1.25; }
.banner .medal { position: relative; z-index: 1; flex: none; width: 15mm; height: 15mm; margin-right: -4mm; border-radius: 50%; background: var(--card);
  border: 0.8mm solid var(--gold); box-shadow: 0 0 0 0.6mm var(--navy); display: flex; align-items: center; justify-content: center; }
.banner .medal svg { width: 10.5mm; height: 10.5mm; color: var(--ink); --mark-bg: #fff; --crest: var(--accent); }
.banner .txt { background: var(--navy); color: #fff8ec; padding: 1.4mm 11mm 1.6mm 8mm; clip-path: polygon(0 0, 100% 0, calc(100% - 4mm) 50%, 100% 100%, 0 100%); }
.banner .cloud { flex: none; width: 22mm; height: 7mm; margin-left: 2mm; color: var(--gold); }
.banner .fest-name, .banner .day-no { font-size: inherit; color: inherit; }
.head-en { display: block; margin: 1mm 0 0 13mm; font-size: 10pt; }
.head .staff { position: absolute; right: -2mm; bottom: -3mm; height: 33mm; width: auto; }
.bubble { position: relative; display: inline-flex; align-items: center; gap: 2mm; margin-top: 2mm; background: #fff; border: 0.5mm solid var(--ink);
  border-radius: 6mm; padding: 1mm 3.5mm 1mm 1mm; font-size: 9.5pt; line-height: 1.45; }
.bubble .face { flex: none; width: 8.5mm; height: 8.5mm; border-radius: 50%; object-fit: cover; border: 0.5mm solid var(--ink);
  background: linear-gradient(#fde9b8, #f3c98b); }
.bubble .who { color: var(--accent); font-weight: 900; margin-right: 1.5mm; }

/* ---- 箱とチップ ---- */
.box { background: var(--soft); border-radius: 4mm; padding: 3.5mm 4.5mm; margin-top: 4mm; }
.box.line { background: var(--card); border: 0.6mm solid var(--line); }
.box.alert { background: #fff; border: 0.8mm solid var(--accent); }
.box h3 { display: flex; align-items: center; gap: 1.8mm; font-size: 12.5pt; color: var(--accent); margin-bottom: 1.5mm; }
.box h3 .ic, .section-title .ic { width: 5mm; height: 5mm; }
.section-title { display: flex; align-items: center; gap: 1.8mm; font-size: 13pt; color: var(--accent); margin-bottom: 2.5mm; }
.chips { display: flex; flex-wrap: wrap; gap: 1.5mm; margin-top: 2mm; }
.chip { display: inline-flex; align-items: center; gap: 1mm; border: 0.4mm solid var(--ink); border-radius: 99px; padding: 0.3mm 2.6mm; font-size: 9.5pt; background: #fff; }
.dots li { position: relative; padding-left: 4.2mm; margin: 0.6mm 0; }
.dots li::before { content: ""; position: absolute; left: 0.6mm; top: 0.62em; width: 1.8mm; height: 1.8mm; border-radius: 50%; background: var(--accent); }
.unknown { display: inline-block; border: 0.4mm dashed var(--sub); border-radius: 1.5mm; padding: 0 1.8mm; color: var(--sub); font-weight: 900; }
.spot { width: 1.6em; height: 1.6em; flex: none; color: var(--ink); }
.with-spot { display: inline-flex; align-items: center; gap: 2mm; }
.with-spot .spot { width: 11mm; height: 11mm; }
.section-title .spot, .box h3 .spot { width: 8mm; height: 8mm; }
.tape { position: absolute; width: 30mm; height: 9mm; color: var(--ink); --tape: var(--c2); }

/* ---- 表紙 ---- */
.cover, .back { padding: 9mm 11mm 0; z-index: 1; }
/* 表紙の中身が多いときは、風景の絵とスタッフを小さくして1ページに収める */
.cover.tight .scene { height: 56mm; margin-top: 2mm; }
.cover.tight .scene .motif { width: 38mm; height: 38mm; margin-left: -19mm; }
.cover.tight .scene .town { height: 42mm; }
.cover.tight .crew { height: 34mm; }
.cover.tight .crew img.main, .cover.tight .crew img.waver { height: 32mm; }
.cover.tight .crew .bubble { margin-bottom: 12mm; }
.corners { position: absolute; inset: 0; pointer-events: none; }
.corners svg { position: absolute; width: 16mm; height: 16mm; }
.corners .tl { left: 0; top: 0; }
.corners .tr { right: 0; top: 0; transform: scaleX(-1); }
.corners .bl { left: 0; bottom: 0; transform: scaleY(-1); }
.corners .br { right: 0; bottom: 0; transform: scale(-1, -1); }
.cover .cluster, .back .cluster { position: absolute; left: 2mm; top: 2mm; width: 50mm; height: 50mm; color: #3b2a1c; z-index: 1; }
.cover .season { position: absolute; width: 40mm; height: 40mm; color: var(--ink); }
.cover .season.a { right: 2mm; top: 2mm; }
.ribbon { position: relative; z-index: 2; align-self: center; display: inline-flex; align-items: center; gap: 2mm; background: var(--navy); color: #fff8ec;
  border: 0.8mm solid var(--gold); outline: 0.6mm solid var(--navy); border-radius: 2.5mm; padding: 1.6mm 8mm; font-weight: 900; }
.ribbon .mark { width: 9mm; height: 9mm; color: var(--navy); --mark-bg: #fff8ec; }
.ribbon .shop { font-size: 10pt; letter-spacing: 0.15em; border-right: 0.4mm solid rgba(255, 248, 236, 0.5); padding-right: 2.5mm; }
.ribbon .name { font-size: 20pt; letter-spacing: 0.2em; }
.cover .length { position: relative; z-index: 2; align-self: center; margin-top: 3mm; background: var(--accent); color: var(--on-accent);
  font-weight: 900; font-size: 11pt; padding: 0.6mm 5mm; border-radius: 99px; }
.cover h1 { position: relative; z-index: 2; align-self: center; text-align: center; font-size: 30pt; line-height: 1.25; margin-top: 2.5mm; max-width: 130mm; overflow-wrap: anywhere; }
.cover h1.long { font-size: 24pt; }
.cover .verified { position: absolute; z-index: 3; right: 9mm; top: 62mm; width: 32mm; text-align: center; color: #b8302a; font-weight: 900; font-size: 7.5pt; line-height: 1.3;
  background: var(--card); border: 0.8mm solid #b8302a; border-radius: 50%; aspect-ratio: 1; display: flex; flex-direction: column; justify-content: center; padding: 3mm; transform: rotate(-8deg); }
.cover .verified .ic { width: 7mm; height: 7mm; margin: 0 auto 0.5mm; color: #b8302a; --crest: #b8302a; }
.cover .scene { position: relative; flex: none; height: 80mm; margin: 4mm -11mm 0; overflow: hidden;
  background: linear-gradient(180deg, var(--cover-bg) 0%, var(--cover-bg) 45%, var(--soft) 100%); }
.cover.tone-day .scene { background: linear-gradient(180deg, #e7f0fa 0%, var(--paper) 100%); }
.cover .scene .motif { position: absolute; left: 50%; top: 1mm; width: 50mm; height: 50mm; margin-left: -25mm; color: #1e1a17; }
.cover .scene .town { position: absolute; left: 0; bottom: 0; width: 100%; height: 58mm; }
.cover .needs-check { position: relative; margin: 3mm 0 0; padding: 2mm 3mm; border: 0.6mm solid #b8302a; border-radius: 2mm; background: var(--card); color: #b8302a; font-weight: 900; font-size: 9pt; line-height: 1.45; }
.facts { position: relative; display: grid; grid-template-columns: repeat(4, 1fr); margin-top: 3mm; border-top: 0.5mm solid var(--gold); border-bottom: 0.5mm solid var(--gold); padding: 2mm 0; }
.facts > div { padding: 0 2.5mm; border-left: 0.4mm dashed var(--gold); }
.facts > div:first-child { border-left: 0; }
.facts .wide { grid-column: 1 / -1; border-left: 0; border-top: 0.4mm dashed var(--gold); margin-top: 1.5mm; padding-top: 1.5mm; display: flex; gap: 3mm; align-items: baseline; }
.facts dt { font-size: 9pt; color: var(--sub); display: flex; align-items: center; gap: 1.2mm; }
.facts dt .ic { width: 5mm; height: 5mm; color: var(--gold); }
.facts dd { font-weight: 900; font-size: 10.5pt; line-height: 1.35; }
.cover .festival { position: relative; margin-top: 6mm; background: var(--card); border: 0.6mm solid var(--navy); border-radius: 4mm; padding: 6mm 5mm 3mm; }
.cover .festival .label { position: absolute; left: 4mm; top: -4mm; display: inline-flex; align-items: center; gap: 1.5mm; background: var(--navy); color: #fff8ec;
  font-size: 10.5pt; font-weight: 900; padding: 0.6mm 6mm 0.6mm 2mm; clip-path: polygon(0 0, 100% 0, calc(100% - 3mm) 50%, 100% 100%, 0 100%); }
.cover .festival .fan { width: 7mm; height: 7mm; color: #1e1a17; }
.cover .festival .name { font-size: 19pt; font-weight: 900; line-height: 1.3; }
.cover .festival .en { display: block; font-size: 10pt; }
.cover .festival .place { display: flex; align-items: center; gap: 1mm; font-size: 10.5pt; margin-top: 0.5mm; }
.cover-notes { position: relative; display: grid; grid-template-columns: 1.2fr 1fr; gap: 4mm; margin-top: 3mm; }
.cover-notes > div { background: var(--card); border: 0.5mm solid var(--line); border-radius: 3mm; padding: 2.5mm 4mm; }
.cover-notes h3 { display: flex; align-items: center; gap: 1.5mm; font-size: 11.5pt; color: var(--navy); margin-bottom: 1mm; }
.cover-notes .spot { width: 7mm; height: 7mm; }
.cover-notes .ic { width: 5mm; height: 5mm; color: var(--gold); }
.cover-notes ol li { display: flex; gap: 2mm; align-items: flex-start; padding: 0.8mm 0; border-bottom: 0.3mm dashed var(--line); line-height: 1.4; }
.cover-notes ol li:last-child { border-bottom: 0; }
.cover-notes .num { flex: none; width: 5.6mm; height: 5.6mm; border-radius: 50%; background: var(--gold); color: #fff; font-weight: 900; font-size: 9pt;
  display: flex; align-items: center; justify-content: center; margin-top: 0.3mm; }
.cover .cover-wave, .back .town { position: absolute; left: 0; right: 0; bottom: 0; width: 100%; }
.cover .cover-wave { height: 13mm; --wave: var(--navy); opacity: 0.45; }
.cover .crew { position: relative; display: flex; align-items: flex-end; justify-content: space-between; gap: 2mm; margin-top: auto; height: 42mm; }
.cover .crew img.main, .cover .crew img.waver { height: 40mm; width: auto; }
.cover .crew .bubble { color: #1e1a17; margin-bottom: 18mm; max-width: 100mm; }

/* ---- 裏表紙 ---- */
.back { align-items: center; text-align: center; padding-top: 22mm; }
.back .thanks { margin-top: 12mm; font-size: 30pt; font-weight: 900; line-height: 1.3; color: var(--navy); }
.back .crew { display: flex; gap: 6mm; align-items: flex-end; margin-top: 8mm; }
.back .crew img { height: 52mm; width: auto; }
.back .trip { margin-top: 6mm; font-weight: 900; font-size: 13pt; }
.back .back-band { margin-top: 8mm; text-align: left; max-width: 150mm; }
.back .how { margin-top: 5mm; font-size: 9pt; color: var(--sub); max-width: 150mm; }
.back .town { height: 58mm; }
.back-band { display: flex; align-items: center; gap: 5mm; margin-top: 5mm; padding: 3mm 5mm; border-top: 0.5mm solid var(--gold); border-bottom: 0.5mm solid var(--gold); font-size: 9.5pt; }
.back-band .seal { flex: none; width: 24mm; height: 24mm; border: 0.9mm solid #b8302a; border-radius: 50%; color: #b8302a; font-weight: 900; font-size: 9pt;
  display: flex; flex-direction: column; align-items: center; justify-content: center; line-height: 1.15; transform: rotate(-6deg); }
.back-band .seal svg { width: 10mm; height: 10mm; color: #b8302a; --mark-bg: transparent; }
.back-band .seal .sub { font-size: 6pt; }

/* ---- 旅の思い出 ---- */
.frames { display: grid; grid-template-columns: 1fr 1fr; gap: 5mm; margin-top: 2mm; }
.frames .photo { height: 92mm; border: 0.8mm dashed var(--navy); border-radius: 3mm; background: var(--card); display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 2mm; font-weight: 900; color: var(--sub); }
.frames .photo svg { width: 14mm; height: 14mm; }

.two-col { position: relative; }
.seal.mini { position: absolute; right: 5mm; top: -7mm; background: var(--paper); width: 17mm; height: 17mm; border: 0.7mm solid #b8302a; border-radius: 50%; color: #b8302a; font-weight: 900;
  font-size: 6.5pt; display: flex; flex-direction: column; align-items: center; justify-content: center; line-height: 1.1; transform: rotate(-8deg); }
.seal.mini svg { width: 6mm; height: 6mm; color: #b8302a; --mark-bg: transparent; }
.seal.mini .sub { font-size: 5pt; }

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
/* すごろく：ふりだしからあがりまで、マス（予定）を道でつなぐ。マスの色は種類の目印で、種類は文字でも書く */
.timeline { position: relative; margin-top: 3mm; --g-move: #dbe8f7; --g-meal: #fde3cf; --g-fest: var(--accent); --g-rest: #dcefd8; --g-see: #f6ecc4; }
.timeline::before { content: ""; position: absolute; left: 25.7mm; top: 3mm; bottom: 3mm; width: 3.4mm; border-radius: 2mm;
  background: repeating-linear-gradient(180deg, var(--soft) 0 3mm, #fff 3mm 4.4mm); border: 0.4mm solid var(--line); }
.step { position: relative; display: grid; grid-template-columns: 19mm 12mm 1fr; gap: 0 2.4mm; padding: 1.4mm 0; break-inside: avoid; align-items: start; }
.step .time { font-weight: 900; font-size: 10pt; text-align: right; padding-top: 2.2mm; font-variant-numeric: tabular-nums; line-height: 1.3; }
.step .dot { position: relative; z-index: 1; width: 12mm; height: 12mm; border-radius: 3mm; background: var(--g, #fff); border: 0.6mm solid var(--ink);
  display: flex; align-items: center; justify-content: center; box-shadow: 0.8mm 0.8mm 0 var(--ink); }
.step .dot .ic { width: 6.4mm; height: 6.4mm; color: var(--ink); }
.step .masu { position: absolute; top: -1.8mm; left: -1.8mm; min-width: 4.8mm; height: 4.8mm; border-radius: 99px; background: #fff; border: 0.4mm solid var(--ink);
  font-size: 7.5pt; line-height: 4mm; text-align: center; padding: 0 0.6mm; }
.step .body { padding: 1.2mm 3mm 1.6mm; border: 0.4mm solid var(--line); border-left: 1.6mm solid var(--g, var(--line)); border-radius: 2.5mm; background: #fff; }
.step .name { font-weight: 900; font-size: 11.5pt; line-height: 1.4; }
.step .kind { display: inline-block; font-size: 8.5pt; color: var(--ink); background: var(--g, #fff); border: 0.3mm solid var(--ink); border-radius: 99px; padding: 0 1.8mm; margin-right: 1.5mm; vertical-align: 0.15em; }
.step .details { font-size: 9.5pt; color: var(--sub); }
.g-move { --g: var(--g-move); }
.g-meal { --g: var(--g-meal); }
.g-rest { --g: var(--g-rest); }
.g-see { --g: var(--g-see); }
.g-fest { --g: var(--g-fest); }
.step.g-fest .dot .ic { color: var(--on-accent); }
.step.g-fest .kind { color: var(--on-accent); }
.step.festival .body { background: var(--soft); border: 0.7mm solid var(--accent); border-left-width: 1.6mm; padding: 1.6mm 3mm 2mm; }
.step.festival .dot { width: 13mm; height: 13mm; border-radius: 50%; }
.endpoint { position: relative; z-index: 1; display: flex; align-items: center; gap: 2mm; font-weight: 900; margin: 1mm 0 1mm 19.5mm; }
.endpoint .ic { width: 6mm; height: 6mm; }
.endpoint .koma { display: inline-block; white-space: nowrap; background: var(--ink); color: #fff; border-radius: 1.5mm; padding: 0.4mm 2mm; font-size: 9pt; letter-spacing: 0.1em; }
.endpoint.goal .koma { background: var(--accent); color: var(--on-accent); }
.stay { display: flex; gap: 3mm; align-items: center; }
.stay .ic { width: 9mm; height: 9mm; }
.stay .area { font-size: 13pt; font-weight: 900; }
.stay.with-inns { align-items: flex-start; }
.stay .inns { list-style: none; margin: 1mm 0 0; padding: 0; }
.stay .inns li { padding: 1.5mm 0 0; border-top: 0.3mm dashed var(--line); }
.stay .inn { font-size: 11pt; font-weight: 900; line-height: 1.5; }
.stay .inn-meta { font-size: 9.5pt; line-height: 1.5; }
.stay .inn-url { font-size: 8.5pt; line-height: 1.4; overflow-wrap: anywhere; word-break: break-all; color: var(--ink); }
.stay .inn-note { font-size: 9pt; line-height: 1.5; }

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
.festival-day .day-bunting { display: block; width: 100%; height: 11mm; margin: 0 0 2mm; color: var(--ink); }
.festival-day .head .kicker { background: var(--accent); }
.calm-day .head .kicker { background: #fff; color: var(--ink); border: 0.5mm solid var(--ink); }
.calm-day .step.g-fest .dot .ic { color: var(--on-accent); }

/* ---- 持ち物 ---- */
.checks { columns: 2; column-gap: 6mm; }
.checks .group { break-inside: avoid; margin-bottom: 4mm; }
.checks h3 { display: flex; align-items: center; gap: 1.5mm; font-size: 12pt; color: var(--accent); }
.checks .note { font-size: 8.5pt; color: var(--sub); }
.checks li { display: flex; gap: 2mm; align-items: flex-start; margin: 0.8mm 0; }
.checks li::before { content: ""; flex: none; width: 4.4mm; height: 4.4mm; margin-top: 0.3em; border: 0.6mm solid var(--ink); border-radius: 1mm; background: #fff; }

/* ---- スタンプとメモ ---- */
.stamps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5mm 4mm; margin-top: 3mm; }
.stamps.small { grid-template-columns: repeat(5, 1fr); gap: 2mm; }
.stamp { text-align: center; }
.stamp .ring { position: relative; width: 44mm; height: 44mm; margin: 0 auto; color: var(--accent); }
.stamps.small .ring { width: 18mm; height: 18mm; }
.stamps.small .lbl { font-size: 9pt; }
.stamp .ring svg { width: 100%; height: 100%; }
.stamp .lbl { font-weight: 900; font-size: 10pt; line-height: 1.3; margin-top: 1mm; overflow-wrap: anywhere; }
.stamp .sub { font-size: 8.5pt; color: var(--sub); }
.shop-stamp { position: absolute; right: 34mm; top: 1mm; width: 27mm; height: 27mm; border: 0.9mm solid #b8302a; border-radius: 50%;
  display: flex; flex-direction: column; align-items: center; justify-content: center; color: #b8302a; font-weight: 900; font-size: 9pt;
  line-height: 1.15; transform: rotate(12deg); opacity: 0.92; }
.shop-stamp svg { width: 11mm; height: 11mm; color: #b8302a; --mark-bg: transparent; }
.shop-stamp .sub { font-size: 6.5pt; letter-spacing: 0.05em; }
.draw { display: grid; grid-template-columns: 1fr 1fr; gap: 4mm; margin-top: 4mm; }
.draw div { height: 44mm; border: 0.6mm dashed var(--ink); border-radius: 4mm; padding: 2mm 3mm; font-weight: 900; font-size: 10pt; }
.memo { display: grid; grid-template-columns: 1fr 1fr; gap: 4mm; margin-top: 4mm; }
.memo .box { margin-top: 0; }
.memo-box .ln { height: 8mm; border-bottom: 0.4mm dashed var(--line); }

/* ---- 出典 ---- */
.sources li { padding: 1.2mm 0; border-bottom: 0.3mm dashed var(--line); break-inside: avoid; display: grid; grid-template-columns: 8mm 1fr; }
.sources .n { font-weight: 900; color: var(--accent); }
.sources .t { font-weight: 900; font-size: 10pt; overflow-wrap: anywhere; }
.sources .url { font-size: 9pt; overflow-wrap: anywhere; word-break: break-all; color: var(--ink); }
.sources .meta { font-size: 8.5pt; color: var(--sub); margin-left: 1mm; word-break: normal; }
.two-col .sources { columns: 2; column-gap: 5mm; }
.closing { margin-top: 4mm; font-weight: 900; break-inside: avoid; }
.box .closing { margin-top: 2mm; }

/* ---- 画面で見るとき：見開きで2ページずつ並べ、矢印のリンクでめくる（スクリプトは使わない） ---- */
@media screen {
  html, body { height: 100%; }
  body { display: flex; flex-direction: column; overflow: hidden; background: #4a3a2c; }
  .toolbar { flex: none; display: flex; justify-content: center; gap: 12px; padding: 8px 16px; }
  .toolbar a { display: inline-flex; align-items: center; gap: 8px; background: var(--accent); color: var(--on-accent); font-weight: 900; text-decoration: none; padding: 8px 20px; border-radius: 99px; font-size: 16px; }
  .book { flex: 1; min-height: 0; display: flex; overflow-x: auto; overflow-y: hidden; scroll-snap-type: x mandatory; scroll-behavior: smooth;
    overscroll-behavior-x: contain; scrollbar-width: none; container: book / size; }
  .book::-webkit-scrollbar { display: none; }
  .spread { position: relative; flex: 0 0 100%; height: 100%; scroll-snap-align: start; scroll-snap-stop: always; display: flex; align-items: center;
    justify-content: center; padding: 0 0 22px; }
  .page { zoom: 0.2; box-shadow: 0 4px 18px rgba(0, 0, 0, 0.4); }
  .spread:not(.single) .page:first-of-type { box-shadow: -4px 4px 18px rgba(0, 0, 0, 0.4), inset -8mm 0 8mm -6mm rgba(60, 40, 20, 0.25); }
  .spread:not(.single) .page:last-of-type { box-shadow: 4px 4px 18px rgba(0, 0, 0, 0.4), inset 8mm 0 8mm -6mm rgba(60, 40, 20, 0.25); }
  .turn { position: absolute; z-index: 5; top: 50%; transform: translateY(-50%); display: flex; align-items: center; justify-content: center; width: 52px; height: 96px;
    border-radius: 14px; background: rgba(30, 26, 23, 0.55); color: #fff8ec; font-size: 44px; line-height: 1; text-decoration: none; font-weight: 900; }
  .turn:hover, .turn:focus-visible { background: var(--accent); color: var(--on-accent); outline: 3px solid #fff8ec; outline-offset: 2px; }
  .turn.prev { left: 8px; }
  .turn.next { right: 8px; }
  .where { position: absolute; left: 0; right: 0; bottom: 2px; text-align: center; color: #fff8ec; font-size: 13px; line-height: 20px; }
  @container book (orientation: portrait) {
    .spread { flex-direction: column; justify-content: flex-start; gap: 12px; overflow-y: auto; padding: 12px 0 76px; }
    .page { flex: none; }
    .spread:not(.single) .page:first-of-type, .spread:not(.single) .page:last-of-type { box-shadow: 0 4px 18px rgba(0, 0, 0, 0.4); }
    .turn { position: fixed; top: auto; bottom: 10px; transform: none; width: 64px; height: 52px; font-size: 36px; }
    .where { position: fixed; bottom: 24px; }
  }
}
`;

/**
 * 画面で見るときの動き。ここに書いた animation は、終わると BASE の姿（最後の状態）になる。
 * 長く続くもの（提灯が揺れる・手を振る）は、止めたときの姿も BASE と同じになるよう、0% を BASE にする
 */
const MOTION = String.raw`
@media screen and (prefers-reduced-motion: no-preference) {
  /* ページをめくる：左の綴じ目を軸に、紙が開いてくる。見開きを横に送るのに合わせる */
  .sheet { transform-origin: left center; animation: shiori-turn 0.9s cubic-bezier(0.2, 0.7, 0.3, 1) both; }
  .spread:not(.single) .page:last-of-type .sheet { animation-delay: 0.2s; }
  @supports (animation-timeline: view()) {
    .spread:not(:first-child) .sheet { animation-delay: 0s; animation-timeline: view(inline); animation-range: entry 0% entry 70%; }
  }
  /* 表紙：提灯が風で揺れ、ひよこが手を振る */
  .cover .cluster, .back .cluster { transform-origin: 30% 0; animation: shiori-swing 4s ease-in-out infinite; }
  .cover .waver { transform-origin: 50% 92%; animation: shiori-wave 1.4s ease-in-out 0.8s infinite; }
  .bubble { transform-origin: 6mm 50%; animation: shiori-pop 0.5s 0.5s cubic-bezier(0.3, 1.5, 0.5, 1) both; }
  /* スタンプを押す：上から落ちてきて、紙に押される */
  .cover .verified { animation: shiori-press-cover 0.7s 1.1s cubic-bezier(0.3, 1.4, 0.5, 1) both; }
  .shop-stamp { animation: shiori-press-shop 0.7s 0.6s cubic-bezier(0.3, 1.4, 0.5, 1) both; }
  .stamp .ring { animation: shiori-pop 0.45s calc(0.3s + var(--i, 0) * 0.08s) cubic-bezier(0.3, 1.5, 0.5, 1) both; }
  /* 道のりを描く：線が出発から順に伸び、止まる場所が順に置かれる */
  .route > svg { animation: shiori-draw 1.8s 0.4s ease-out both; }
  .stop { animation: shiori-drop 0.5s calc(0.5s + var(--i, 0) * 0.3s) cubic-bezier(0.3, 1.5, 0.5, 1) both; }
  .timeline::before { transform-origin: top; animation: shiori-grow 1.2s 0.3s ease-out both; }
}
@keyframes shiori-turn { from { transform: perspective(2200px) rotateY(-75deg); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes shiori-swing { 0%, 100% { transform: none; } 30% { transform: rotate(2.5deg); } 70% { transform: rotate(-2deg); } }
@keyframes shiori-wave { 0%, 100% { transform: none; } 25% { transform: rotate(-7deg); } 75% { transform: rotate(6deg); } }
@keyframes shiori-pop { from { transform: scale(0.4); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes shiori-press-cover { from { transform: translateY(-30mm) scale(1.6) rotate(-20deg); opacity: 0; } 70% { opacity: 1; } to { transform: rotate(-8deg); opacity: 1; } }
@keyframes shiori-press-shop { from { transform: translateY(-20mm) scale(1.6) rotate(-6deg); opacity: 0; } 70% { opacity: 0.92; } to { transform: rotate(12deg); opacity: 0.92; } }
@keyframes shiori-draw { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
@keyframes shiori-drop { from { transform: translate(-50%, -14mm); opacity: 0; } to { transform: translate(-50%, -6mm); opacity: 1; } }
@keyframes shiori-grow { from { transform: scaleY(0); } to { transform: none; } }
`;

/** 1mm の画面の長さ（px） */
const MM_PX = 96 / 25.4;

/**
 * 画面で見るときの紙の縮尺。紙の中身は mm と pt で組んであるので、スクリプトを使わずに画面に合わせるよう、
 * 見開きの置き場（.book）の大きさごとの縮尺（zoom）を、決まった刻みのコンテナクエリで決める。
 * 横長なら2ページ（420mm × 297mm）とめくる矢印が、縦長なら1ページの幅が収まる、いちばん大きな縮尺にする
 */
export function screenScaleRules(): string {
  const rules: string[] = [];
  for (let step = 10; step <= 70; step++) {
    const z = step / 50;
    const spreadW = Math.ceil(z * 2 * 210 * MM_PX + 2 * 64);
    const spreadH = Math.ceil(z * 297 * MM_PX + 28);
    const singleW = Math.ceil(z * 210 * MM_PX + 16);
    rules.push(
      `@container book (orientation: landscape) and (min-width: ${spreadW}px) and (min-height: ${spreadH}px) { .page { zoom: ${z}; } }`,
      `@container book (orientation: portrait) and (min-width: ${singleW}px) { .page { zoom: ${z}; } }`,
    );
  }
  return `@media screen {\n${rules.join("\n")}\n}`;
}

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
  return `${BASE}\n:root { ${vars}; }\n${screenScaleRules()}\n${MOTION}`;
}
