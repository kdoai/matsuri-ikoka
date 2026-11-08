import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { ShioriAssets } from "./assets";
import { BOOKLET_PAGES, PAGE_STAFF, type PageKind, type StaffStill } from "./design";
import {
  FLOW_HEIGHT_MM,
  FLOW_WIDTH_MM,
  lineCount,
  listMm,
  PAGE_MM,
  PT_MM,
  packBlocks,
  roomLeft,
  textMm,
  textUnits,
  withSafety,
} from "./fit";
import type { RouteView } from "./route";
import { shioriStyle } from "./style";
import type { DayView, FestivalView, IconName, ShioriView, WeatherView } from "./viewModel";

// しおりの HTML。画面（GET /shiori/:id）と PDF で同じものを使う。
// 旅程・祭りのデータ・モデルの文章はすべて html`` の差し込みでエスケープし、raw() は自前の CSS と SVG だけに使う。
// スクリプトは使わない。店「たびや」の札と紋、和紙の紙と紺の枠、手で描いた絵、スタッフの顔の絵の吹き出しで、店でもらう冊子の見た目にする。
// 動き（提灯が揺れる・手を振る・ページをめくる・スタンプを押す・道のりを描く）は CSS だけで付ける（style.ts）。

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

const STAFF_NAMES: Record<StaffStill, string> = {
  hiyoko_wave: "コンシェルジュのひよこ",
  hiyoko_stamp: "コンシェルジュのひよこ",
  owl_book: "調査係のフクロウ",
  hen_point: "周辺係のにわとり",
  sparrow_binder: "旅程係のスズメ",
  penguin_cheer: "旅人のペンギン",
  penguin_stampbook: "旅人のペンギン",
};

/** 吹き出しの顔の絵（assets/shiori/staff/face_*.webp。画面の会話の窓と同じ絵） */
const FACES: Record<StaffStill, string> = {
  hiyoko_wave: "face_hiyoko",
  hiyoko_stamp: "face_hiyoko",
  owl_book: "face_owl",
  hen_point: "face_hen",
  sparrow_binder: "face_sparrow",
  penguin_cheer: "face_penguin",
  penguin_stampbook: "face_penguin",
};

/** ページごとのスタッフのひとこと（決まった文） */
const PAGE_LINES: Partial<Record<PageKind, string>> = {
  festival: "調べた見どころをまとめました",
  overview: "旅の全体の流れです",
  day: "時刻は目安。早めに動くと安心です",
  checklist: "出かける前にチェック！",
  stamps: "旅の思い出に、スタンプやサインをどうぞ",
  sources: "しおりの情報は、ここから調べました",
  memory: "写真をはったり、絵を描いたりしてね",
};

/** 見出しの札の左に置く丸い印（絵は飾りで、見出しは文字で読める） */
const PAGE_MEDALS: Record<PageKind, string> = {
  cover: "deco-shop-mark",
  festival: "spot-lantern",
  overview: "icon-pin",
  day: "deco-uchiwa",
  checklist: "spot-kinchaku",
  stamps: "deco-crest",
  sources: "icon-info",
  memory: "icon-camera",
  back: "deco-shop-mark",
};

function icon(name: IconName | `deco-${string}`, cls = "ic"): Html {
  const id = name.startsWith("deco-") ? name : `icon-${name}`;
  return html`<svg class="${cls}" aria-hidden="true"><use href="#s-${id}"></use></svg>`;
}

function symbol(id: string, cls: string): Html {
  return html`<svg class="${cls}" aria-hidden="true"><use href="#s-${id}"></use></svg>`;
}

function staffImg(still: StaffStill, cls = "staff"): Html {
  return html`<img class="${cls}" src="assets/staff/${still}.webp" alt="${STAFF_NAMES[still]}" />`;
}

/** スタッフの顔の絵つきの吹き出し */
function bubble(still: StaffStill, line: Html | string): Html {
  return html`<p class="bubble"><img class="face" src="assets/staff/${FACES[still]}.webp" alt="" /><span class="say"><span class="who">${STAFF_NAMES[still]}</span>${line}</span></p>`;
}

/** 見出しに添える小さな挿し絵（assets/shiori/svg/spot-*.svg）。文字の見出しの飾りなので読み上げない */
function spot(name: "lantern" | "kinchaku" | "dango"): Html {
  return symbol(`spot-${name}`, "spot");
}

/** 予定の種類を、すごろくのマスの色分け（移動・食事・祭り・休憩・見る）にする */
const STEP_GROUPS: Partial<Record<IconName, string>> = {
  train: "move",
  bus: "move",
  car: "move",
  taxi: "move",
  walk: "move",
  meal: "meal",
  festival: "fest",
  prep: "fest",
  rest: "rest",
  sun: "rest",
  sightseeing: "see",
};

/** 店の紋と名前（見出しの上の小さな札） */
function shopTag(): Html {
  return html`<span class="shop-tag">${symbol("deco-shop-mark", "mark-mini")}たびや</span>`;
}

function list(items: readonly string[], cls = "dots"): Html {
  return html`<ul class="${cls}">${items.map((item) => html`<li>${item}</li>`)}</ul>`;
}

function weatherChip(weather: WeatherView): Html {
  return html`<span class="weather">${icon(weather.icon)}${weather.text}</span>`;
}

function head(
  kind: PageKind,
  kicker: string,
  title: Html,
  en: string | null = null,
  override: { still: StaffStill; line: string; medal?: string } | null = null,
): Html {
  const still = override?.still ?? PAGE_STAFF[kind];
  const line = override?.line ?? PAGE_LINES[kind];
  const medal = override?.medal ?? PAGE_MEDALS[kind];
  return html`<header class="head">
    <div class="title">
      <p class="kick">${shopTag()}<span class="kicker">${kicker}</span></p>
      <h2 class="banner"><span class="medal">${symbol(medal, "")}</span><span class="txt">${title}</span>${symbol("deco-cloud", "cloud")}</h2>
      ${en ? html`<p class="en head-en">${en}</p>` : ""}
      ${line && still ? bubble(still, line) : ""}
    </div>
    ${still ? staffImg(still) : ""}
  </header>`;
}

// ---------------------------------------------------------------------------
// ページに詰める：どのページも A4 1枚の決まった大きさの紙にし、入りきらない中身は「つづき」のページに送る。
// 高さは fit.ts で見積もる（スクリプトを動かせないので、文字の数と箱の大きさから決める）。

/** 1ページに置く中身の1かたまり。group が同じものは、同じ入れ物（すごろくの道・表など）にまとめる */
interface Piece {
  html: Html;
  mm: number;
  group?: Group;
  keepWithNext?: boolean;
}

type Group = "timeline" | "checks" | "stamps";

/** 入れ物を開くときの高さ（mm。上の余白） */
const GROUP_MM: Record<Group, number> = { timeline: 3, checks: 0, stamps: 3 };

function wrapGroup(group: Group, inner: Html[]): Html {
  switch (group) {
    case "timeline":
      return html`<div class="timeline">${inner}</div>`;
    case "checks":
      return html`<div class="checks">${inner}</div>`;
    case "stamps":
      return html`<div class="stamps">${inner}</div>`;
  }
}

/** 同じ入れ物のかたまりを続けてまとめる */
function assemble(pieces: readonly Piece[]): Html[] {
  const out: Html[] = [];
  let run: Html[] = [];
  let group: Group | undefined;
  const flush = () => {
    if (group !== undefined && run.length > 0) out.push(wrapGroup(group, run));
    run = [];
  };
  for (const piece of pieces) {
    if (piece.group !== group) {
      flush();
      group = piece.group;
    }
    if (piece.group === undefined) out.push(piece.html);
    else run.push(piece.html);
  }
  flush();
  return out;
}

/** 入れ物を開く高さを、入れ物の最初のかたまりに足す */
function withGroupCost(pieces: readonly Piece[]): Piece[] {
  return pieces.map((piece, i) =>
    piece.group !== undefined && pieces[i - 1]?.group !== piece.group
      ? { ...piece, mm: piece.mm + GROUP_MM[piece.group] }
      : piece,
  );
}

/** 1枚の紙 */
export interface Sheet {
  kind: PageKind;
  cls: string;
  label: string;
  body: Html;
  /** ページ番号を出す（表紙と裏表紙は出さない） */
  folio: boolean;
}

/**
 * かたまりをページに詰め、ページごとに見出しを付ける。2ページ目からは見出しの上の札に「つづき」と付ける。
 * filler（この日のメモなど）は、最後のページに入る高さが残っているときだけ置く
 */
function flowSheets(input: {
  kind: PageKind;
  cls?: string;
  label: string;
  top?: (cont: boolean) => Html;
  topMm?: number;
  head: (cont: boolean) => Html;
  headMm: number;
  pieces: Piece[];
  filler?: Piece;
}): Sheet[] {
  const room = FLOW_HEIGHT_MM - input.headMm - (input.topMm ?? 0);
  const pieces = withGroupCost(input.pieces);
  // 入れ物が次のページに分かれたら、そのページで入れ物を開き直すので、2ページ目からはその高さを見込んでおく
  const grouped = pieces.some((p) => p.group !== undefined);
  const pages = packBlocks(
    pieces.map((p) => ({
      content: p,
      mm: p.mm,
      ...(p.keepWithNext ? { keepWithNext: true } : {}),
    })),
    room,
    room - (grouped ? 3 : 0),
  );
  const last = pages[pages.length - 1];
  if (input.filler && last && roomLeft(last, room) >= withSafety(input.filler.mm)) {
    last.push(input.filler);
  }
  return pages.map((page, i) => ({
    kind: input.kind,
    cls: input.cls ?? "",
    label: i === 0 ? input.label : `${input.label}（つづき）`,
    body: html`${input.top ? input.top(i > 0) : ""}${input.head(i > 0)}<div class="flow">${assemble(page)}</div>`,
    folio: true,
  }));
}

/** 文字の大きさ（シニアと一緒のときは本文をひとまわり大きくする） */
let TEXT_SCALE = 1;
const pt = (size: number) => size * TEXT_SCALE;

/** 本文の1行の高さ（mm） */
const LINE = (size = 10.5, height = 1.6) => pt(size) * PT_MM * height;

/** 見出しの帯の高さ（mm）。札・帯・吹き出し（あれば）・英語の見出し（あれば）と下の余白 */
function headMm(bubbleLine: boolean, en: boolean): number {
  return 23.5 + (bubbleLine ? 13 : 0) + (en ? 6.8 : 0) + 3;
}

/** 箱（.box）の高さ。上の余白・内側の余白・見出し・中身 */
function boxMm(innerMm: number, titled = true): number {
  return 4 + 7 + 0.4 + (titled ? LINE(12.5) + 1.5 : 0) + innerMm;
}

/** 箱の中の文字の幅（mm） */
const BOX_W = FLOW_WIDTH_MM - 9 - 1.2;

function dotsMm(items: readonly string[], widthMm: number, size = 10.5): number {
  // 行の上下の余白（0.6mm）は、となりの行と重なる
  return listMm(items, widthMm - 4.2, pt(size), 1.6, 0.6) + 0.6;
}

// ---------------------------------------------------------------------------

/** 紙の四隅の青海波 */
function corners(): Html {
  return html`<div class="corners" aria-hidden="true">${["tl", "tr", "bl", "br"].map((at) => symbol("deco-corner", at))}</div>`;
}

/** 表紙の中身のおおよその高さ（mm）。収まらなければ、風景の絵を小さくする */
function coverTight(view: ShioriView): boolean {
  const c = view.cover;
  const main = view.festivals[0];
  const w = (FLOW_WIDTH_MM - 4) / 2;
  const notes = main
    ? Math.max(
        main.highlights.length > 0
          ? 9 + listMm(main.highlights, w * 1.1 - 8, pt(10.5), 1.4, 2.4)
          : 0,
        main.trivia.length > 0 ? 9 + dotsMm(main.trivia.slice(0, 2), w * 0.9) : 0,
      ) + 3
    : 0;
  const titleLines = lineCount(c.title, 130, c.longTitle ? 24 : 30);
  const used =
    9 +
    12 +
    10 +
    titleLines * (c.longTitle ? 24 : 30) * PT_MM * 1.25 +
    84 +
    (c.needsCheckLabel ? 3 + 4 + textMm(c.needsCheckLabel, FLOW_WIDTH_MM - 6, 9, 1.45) : 0) +
    3 +
    4 +
    16 +
    (c.budgetLabel ? 8 : 0) +
    6 +
    9 +
    LINE(19, 1.3) * lineCount(c.festivalName, FLOW_WIDTH_MM - 10, 19) +
    (c.festivalNameEn ? LINE(10) : 0) +
    (c.place ? LINE(10.5) : 0) +
    notes +
    42;
  return withSafety(used) > PAGE_MM.height - 12 - 2.4 - 12;
}

function cover(view: ShioriView): Sheet {
  const c = view.cover;
  const { design } = view;
  const main = view.festivals[0];
  return {
    kind: "cover",
    cls: `cover tone-${design.coverTone}${coverTight(view) ? " tight" : ""}`,
    label: "表紙",
    folio: false,
    body: html`${symbol("deco-lantern-cluster", "cluster")}
    ${symbol(`season-${design.season}`, "season a")}
    <p class="ribbon">${symbol("deco-shop-mark", "mark")}<span class="shop">たびや</span><span class="name">旅のしおり</span></p>
    <p class="length">${c.lengthLabel}</p>
    <h1 class="${c.longTitle ? "long" : ""}">${c.title}</h1>
    ${c.verifiedLabel ? html`<p class="verified">${icon("deco-crest")}${c.verifiedLabel}</p>` : ""}
    <div class="scene">
      ${symbol(`motif-${design.category}`, "motif")}
      ${symbol("scene-town", "town")}
    </div>
    ${c.needsCheckLabel ? html`<p class="needs-check" role="note">${c.needsCheckLabel}</p>` : ""}
    <dl class="facts">
      <div><dt>${icon("calendar")}日にち</dt><dd>${c.dateLabel}</dd></div>
      <div><dt>${icon("people")}だれと</dt><dd>${c.partyLabel}</dd></div>
      <div><dt>${icon(c.weather.icon)}天気</dt><dd>${c.weather.text}</dd></div>
      <div><dt>${icon("pin")}出発</dt><dd>${c.routeLabel}</dd></div>
      ${c.budgetLabel ? html`<div class="wide"><dt>${icon("yen")}予算</dt><dd>${c.budgetLabel}</dd></div>` : ""}
    </dl>
    <div class="festival">
      <p class="label">${symbol("deco-uchiwa", "fan")}きょうの主役</p>
      <p class="name">${c.festivalName}${c.festivalNameEn ? html`<span class="en">${c.festivalNameEn}</span>` : ""}</p>
      ${c.place ? html`<p class="place">${icon("pin")}${c.place}</p>` : ""}
    </div>
    ${
      main && (main.highlights.length > 0 || main.trivia.length > 0)
        ? html`<div class="cover-notes">
            ${main.highlights.length > 0 ? html`<div class="highlights"><h3>${spot("lantern")}見どころ</h3><ol>${main.highlights.map((h, i) => html`<li><span class="num">${i + 1}</span>${h}</li>`)}</ol></div>` : ""}
            ${main.trivia.length > 0 ? html`<div class="trivia-box"><h3>${icon("info")}祭りの小話</h3>${list(main.trivia.slice(0, 2))}</div>` : ""}
          </div>`
        : ""
    }
    ${symbol("deco-wave", "cover-wave")}
    <div class="crew">
      ${staffImg("penguin_cheer", "main")}
      ${bubble("hiyoko_wave", c.greeting)}
      ${staffImg("hiyoko_wave", "waver")}
    </div>`,
  };
}

function festivalSheets(f: FestivalView): Sheet[] {
  const half = (FLOW_WIDTH_MM - 4) / 2 - 9;
  const cardW = (FLOW_WIDTH_MM - 6) / 3 - 7.2;
  const pieces: Piece[] = [
    {
      html: html`<div class="chips">
        <span class="chip">${icon("festival")}${f.categoryLabel}</span>
        <span class="chip">${icon("people")}${f.scaleLabel}</span>
        <span class="chip">${icon("pin")}${f.place}</span>
      </div>`,
      mm:
        2 +
        LINE(9.5) *
          Math.max(
            1,
            lineCount(`${f.categoryLabel}${f.scaleLabel}${f.place}`, FLOW_WIDTH_MM - 40, pt(9.5)),
          ) +
        1,
    },
  ];
  if (f.missing) {
    pieces.push({
      html: html`<p class="box alert">この祭りのデータが見つかりませんでした。日時と行き方は、主催者の公式の情報で確かめてください。</p>`,
      mm: boxMm(LINE() * 2, false),
    });
  }
  pieces.push({
    html: html`<div class="two">
      <div class="box keep"><h3>${icon("clock")}いつ</h3>${list(f.when, "when dots")}</div>
      <div class="box keep"><h3>${icon("pin")}どこで</h3><p><b>${f.venue}</b></p><p class="muted">${f.place}</p></div>
    </div>`,
    mm: boxMm(
      Math.max(
        listMm(f.when, half - 4.2, pt(12), 1.6, 1.2),
        textMm(f.venue, half, pt(10.5), 1.6) + textMm(f.place, half, pt(10.5), 1.6),
      ),
    ),
  });
  if (f.highlights.length > 0) {
    const cards = Math.max(...f.highlights.map((h) => textMm(h, cardW, pt(10.5), 1.6)));
    pieces.push({
      html: html`<div class="keep highlights-block"><h3 class="section-title">${spot("lantern")}${f.nameJa}の見どころ</h3>
        ${bubble("owl_book", "ここは見のがさないで！")}
        <div class="cards">${f.highlights.map((h, i) => html`<div class="card"><span class="num">${i + 1}</span>${h}</div>`)}</div></div>`,
      mm: 6 + Math.max(8, LINE(13)) + 2.5 + 13.5 + 2 + 9 + 1.2 + cards,
    });
  }
  if (f.trivia.length > 0) {
    pieces.push({
      html: html`<div class="box keep"><h3>${icon("info")}知ってた？</h3>${f.trivia.map((t) => html`<p class="trivia">${t}</p>`)}</div>`,
      mm: boxMm(listMm(f.trivia, BOX_W - 4.4, pt(10.5), 1.6, 1.5)),
    });
  }
  const foodText =
    LINE() +
    (f.food.local.length > 0 ? dotsMm(f.food.local, BOX_W - 29) : LINE()) +
    Math.max(8, LINE(13)) +
    2.5;
  pieces.push({
    html: html`<div class="box line keep with-staff">
      <div>
        <h3 class="section-title">${spot("dango")}その土地の味</h3>
        <p><b>${f.food.stalls}</b></p>
        ${f.food.local.length > 0 ? list(f.food.local) : html`<p class="muted">地元の料理は、データにありません。</p>`}
      </div>
      ${staffImg("hen_point", "")}
    </div>`,
    mm: boxMm(Math.max(foodText, 34), false),
  });
  if (f.access.length > 0) {
    pieces.push({
      html: html`<div class="box keep"><h3>${icon("train")}アクセス</h3>${list(f.access)}</div>`,
      mm: boxMm(dotsMm(f.access, BOX_W)),
    });
  }
  return flowSheets({
    kind: "festival",
    label: "祭りの紹介",
    head: (cont) =>
      head(
        "festival",
        cont ? "今回の祭り（つづき）" : "今回の祭り",
        html`<span class="fest-name">${f.nameJa}</span>`,
        f.nameEn,
      ),
    headMm: headMm(true, f.nameEn !== null),
    pieces,
  });
}

const STOP_ICONS = { start: "pin", end: "home", start_end: "home", area: "stay" } as const;

/** 旅のかたちの図（自作の線と点。地図の画像は使わない） */
function routeMap(route: RouteView, notes: readonly string[]): Html {
  return html`<div class="route-box keep">
    <p class="route-title">${icon("pin")}旅のかたち：<b>${route.shapeLabel}</b></p>
    ${notes.length > 0 ? html`<div class="chips">${notes.map((n) => html`<span class="chip">${n}</span>`)}</div>` : ""}
    <div class="route" role="img" aria-label="${route.shapeLabel}：${route.stops.map((s) => s.label).join("、")}">
      <svg viewBox="0 0 200 100" preserveAspectRatio="none" aria-hidden="true">
        <path d="${route.path}" class="road" />
        <path d="${route.path}" class="trail" />
      </svg>
      ${route.stops.map(
        (
          s,
          i,
        ) => html`<div class="stop ${s.kind}${s.festival ? " fest" : ""}" style="left:${s.x / 2}%;top:${s.y}%;--i:${i}">
          <span class="pin">${s.number !== null ? html`<b>${s.number}</b>` : icon(STOP_ICONS[s.kind])}</span>
          <span class="name">${s.label}</span>
          <span class="sub">${s.festival ? html`${icon("festival")}祭り・` : ""}${s.sub}</span>
        </div>`,
      )}
    </div>
  </div>`;
}

function overviewSheets(view: ShioriView): Sheet[] {
  const pieces: Piece[] = [];
  if (view.route) {
    pieces.push({
      html: routeMap(view.route, view.styleNotes),
      mm:
        1.2 +
        5 +
        LINE(11) +
        (view.styleNotes.length > 0 ? 2 + 7 : 0) +
        1 +
        (FLOW_WIDTH_MM - 9.2) / 2 +
        4,
    });
  }
  const summaryW = FLOW_WIDTH_MM - 12 - 30 - 52 - 6;
  for (const r of view.overview) {
    pieces.push({
      html: html`<ol class="overview"><li class="keep">
          <span class="no">${r.number}</span>
          <span><b>${r.number}日目</b><br /><span class="muted">${r.dateLabel}</span></span>
          <span class="summary">${icon(r.icon)}${r.summary}</span>
          <span class="night">${icon(r.stay.endsWith("に帰る") ? "home" : "stay")}${r.stay}</span>
        </li></ol>`,
      mm:
        4.8 +
        Math.max(
          LINE() * 2,
          textMm(r.summary, summaryW - 6, pt(10.5), 1.6),
          textMm(r.stay, 52 - 5, pt(9.5), 1.6),
        ),
    });
  }
  return flowSheets({
    kind: "overview",
    label: "旅の全体",
    head: (cont) =>
      head(
        "overview",
        cont ? `${view.cover.lengthLabel}（つづき）` : view.cover.lengthLabel,
        html`旅の全体`,
      ),
    headMm: headMm(true, false),
    pieces,
  });
}

const DAY_LINES: Record<DayView["kind"], string> = {
  festival: "きょうは祭りの日！ 早めに会場へ",
  explore: "まちを歩いて、寄り道を楽しんで",
  travel: "移動の日。乗りかえの時刻に気をつけて",
  relax: "きょうはのんびり。休むのも旅のうち",
};

function memoBox(title: string, lines: number): Html {
  return html`<div class="box line keep memo-box"><h3>${icon("calendar")}${title}</h3>${Array.from(
    { length: lines },
    () => html`<div class="ln"></div>`,
  )}</div>`;
}

const memoBoxMm = (lines: number) => boxMm(lines * 8);

/** すごろくのマスの中の文字の幅（mm）。時刻 19mm・マス 12mm・すき間・枠と余白を引く */
const STEP_W = FLOW_WIDTH_MM - 19 - 12 - 2.4 * 2 - 6 - 2;

function daySheets(view: ShioriView, day: DayView): Sheet[] {
  const festivalDay = day.kind === "festival";
  const pieces: Piece[] = [
    { html: weatherChip(day.weather), mm: LINE(9.5, 1.6) + 1.6 },
    {
      html: html`<p class="endpoint start"><span class="koma">ふりだし</span>${icon("pin")}${day.startLabel}</p>`,
      mm: 2 + Math.max(6, textMm(day.startLabel, FLOW_WIDTH_MM - 45, pt(10.5), 1.6)),
      group: "timeline",
      keepWithNext: true,
    },
  ];
  day.rows.forEach((r, i) => {
    const kindMm = textUnits(r.kind) * pt(8.5) * PT_MM + 3.6 + 1.5;
    const body =
      2.8 +
      0.8 +
      textMm(r.name, STEP_W, pt(11.5), 1.4, kindMm) +
      textMm(r.reason, STEP_W, pt(10.5), 1.6) +
      (r.details.length > 0 ? textMm(r.details.join("・"), STEP_W, pt(9.5), 1.6) : 0) +
      (r.festival ? 1.2 : 0);
    pieces.push({
      html: html`<div class="step g-${STEP_GROUPS[r.icon] ?? "see"}${r.festival ? " festival" : ""}">
          <span class="time">${r.time}</span>
          <span class="dot">${icon(r.icon)}<b class="masu">${i + 1}</b></span>
          <div class="body">
            <p class="name"><span class="kind">${r.kind}</span>${r.name}</p>
            <p>${r.reason}</p>
            ${r.details.length > 0 ? html`<p class="details">${r.details.join("・")}</p>` : ""}
          </div>
        </div>`,
      mm: 2.8 + Math.max(r.festival ? 13 : 12, body),
      group: "timeline",
    });
  });
  if (day.returnLabel) {
    pieces.push({
      html: html`<p class="endpoint goal"><span class="koma">あがり</span>${icon("home")}${day.returnLabel}</p>`,
      mm: 2 + Math.max(6, textMm(day.returnLabel, FLOW_WIDTH_MM - 45, pt(10.5), 1.6)),
      group: "timeline",
    });
  }
  if (day.stay) {
    const stay = day.stay;
    const innerW = BOX_W - 12;
    const note = stay.note ? textMm(stay.note, innerW, pt(10.5), 1.6) : 0;
    const offersMm = stay.offers.reduce(
      (sum, o) =>
        sum +
        1.5 +
        textMm(o.name, innerW, pt(11), 1.5) +
        (o.details.length > 0 ? textMm(o.details.join("・"), innerW, pt(9.5), 1.5) : 0) +
        (o.summary ? textMm(o.summary, innerW, pt(9.5), 1.5) : 0) +
        lineCount(o.url, innerW, pt(8.5)) * LINE(8.5, 1.4),
      0,
    );
    const notesMm = listMm(stay.lodgingNotes, innerW, pt(9), 1.5, 0.5);
    pieces.push({
      html: html`<div class="box keep stay${stay.offers.length > 0 ? " with-inns" : ""}">${icon("stay")}<div><p class="muted">今夜泊まる地域</p><p class="area">${stay.area}</p>${stay.note ? html`<p>${stay.note}</p>` : ""}${
        stay.offers.length > 0
          ? html`<ol class="inns">${stay.offers.map(
              (o) =>
                html`<li><p class="inn">${o.name}</p>${o.details.length > 0 ? html`<p class="inn-meta">${o.details.join("・")}</p>` : ""}${o.summary ? html`<p class="inn-meta">${o.summary}</p>` : ""}<p class="inn-url">${o.url}</p></li>`,
            )}</ol>${stay.lodgingNotes.map((n) => html`<p class="muted inn-note">${n}</p>`)}`
          : html`<p class="muted">宿の名前と予約は、ご自身で確かめてください。</p>`
      }</div></div>`,
      mm: boxMm(
        LINE() * 2 + LINE(13) + note + (stay.offers.length > 0 ? offersMm + notesMm - LINE() : 0),
        false,
      ),
    });
  }
  if (day.rainPlan.length > 0) {
    pieces.push({
      html: html`<div class="box keep"><h3>${icon("umbrella")}雨の日・中止のとき</h3>${list(day.rainPlan)}</div>`,
      mm: boxMm(dotsMm(day.rainPlan, BOX_W)),
    });
  }
  const override = festivalDay
    ? {
        still: "penguin_cheer" as const,
        line: DAY_LINES.festival,
        medal: `motif-${view.design.category}`,
      }
    : { still: "hen_point" as const, line: DAY_LINES[day.kind], medal: "icon-walk" };
  return flowSheets({
    kind: "day",
    cls: `day-page ${festivalDay ? "festival-day" : "calm-day"}`,
    label: day.heading,
    top: (cont) => (festivalDay && !cont ? symbol("deco-bunting", "day-bunting") : html``),
    topMm: festivalDay ? 13 : 0,
    head: (cont) =>
      head(
        "day",
        `${day.dateLabel}・${day.kindLabel}${cont ? "（つづき）" : ""}`,
        html`<span class="day-no">${day.heading}</span>`,
        null,
        override,
      ),
    headMm: headMm(true, false),
    pieces,
    ...(day.memoLines > 0
      ? { filler: { html: memoBox("この日のメモ", day.memoLines), mm: memoBoxMm(day.memoLines) } }
      : {}),
  });
}

function stampPieces(view: ShioriView): Piece[] {
  const rows: Piece[] = [];
  for (let i = 0; i < view.stamps.length; i += 3) {
    const row = view.stamps.slice(i, i + 3);
    const lbl = Math.max(...row.map((s) => textMm(s.label, 50, pt(10), 1.3)));
    rows.push({
      html: html`${row.map(
        (s, j) => html`<div class="stamp keep" style="--i:${i + j}">
        <div class="ring">${symbol("deco-stamp-ring", "")}</div>
        <p class="lbl">${s.label}</p>
        ${s.sub ? html`<p class="sub">${s.sub}</p>` : ""}
      </div>`,
      )}`,
      mm: 44 + 1 + lbl + (row.some((s) => s.sub) ? LINE(8.5) : 0) + 5,
      group: "stamps",
    });
  }
  return rows;
}

/** 小さなスタンプの枠（半日のお出かけの持ち物のページ） */
function smallStamps(view: ShioriView): Html {
  return html`<div class="stamps small">
    ${view.stamps.map(
      (s, i) => html`<div class="stamp keep" style="--i:${i}">
        <div class="ring">${symbol("deco-stamp-ring", "")}</div>
        <p class="lbl">${s.label}</p>
        ${s.sub ? html`<p class="sub">${s.sub}</p>` : ""}
      </div>`,
    )}
  </div>`;
}

function sourceItem(view: ShioriView, i: number): Html {
  const s = view.sources[i];
  if (!s) return html``;
  return html`<li><span class="n">${i + 1}</span><div>
          ${s.title ? html`<p class="t">${s.title}</p>` : ""}
          <p class="url">${s.url}<span class="meta">（${s.checkedAt} に確認・${s.confidence}）</span></p>
        </div></li>`;
}

function sourceMm(view: ShioriView, i: number, widthMm: number): number {
  const s = view.sources[i];
  if (!s) return 0;
  return (
    2.7 +
    (s.title ? textMm(s.title, widthMm, pt(10), 1.6) : 0) +
    lineCount(`${s.url}（${s.checkedAt} に確認・${s.confidence}）`, widthMm, pt(9)) * LINE()
  );
}

function closing(view: ShioriView): Html {
  return html`<div class="closing">${view.closing.map((line) => html`<p>${line}</p>`)}</div>`;
}

const closingMm = (view: ShioriView, widthMm: number) =>
  4 + listMm(view.closing, widthMm, pt(10.5), 1.6, 0);

/**
 * 持ち物のページ。半日のお出かけでは、スタンプの枠と出典も同じページに置く（裏表紙を兼ねる）。
 * 1ページに収まらなければ、スタンプの枠を外して収める（出典と持ち物は外さない）
 */
/** 順に2段に組んだときの高さ（mm）。前から順に2つに分け、高いほうの段がいちばん低くなる分け方にする。1行ぶんの余裕を足す */
function twoColumnMm(heights: readonly number[]): number {
  const total = heights.reduce((a, b) => a + b, 0);
  let best = total;
  let prefix = 0;
  for (const h of heights) {
    prefix += h;
    best = Math.min(best, Math.max(prefix, total - prefix));
  }
  return heights.length === 0 ? 0 : best + LINE();
}

function checklistSheets(view: ShioriView): Sheet[] {
  const sheets = checklistFlow(view, true);
  if (!view.design.compact || sheets.length === 1) return sheets;
  const without = checklistFlow(view, false);
  return without.length < sheets.length ? without : sheets;
}

function checklistFlow(view: ShioriView, withStamps: boolean): Sheet[] {
  const colW = (FLOW_WIDTH_MM - 6) / 2;
  const groups = view.checklist.map((g) => ({
    html: html`<div class="group">
          <h3>${icon(g.icon)}${g.title}</h3>
          ${g.note ? html`<p class="note">${g.note}</p>` : ""}
          <ul>${g.items.map((item) => html`<li>${item}</li>`)}</ul>
        </div>`,
    mm:
      LINE(12) +
      (g.note ? textMm(g.note, colW, pt(8.5), 1.6) : 0) +
      listMm(g.items, colW - 6.4, pt(10.5), 1.6, 1.6) +
      4,
  }));
  const room = FLOW_HEIGHT_MM - headMm(true, false);
  const balanced = twoColumnMm(groups.map((g) => g.mm));
  // 2段に組む。1ページに収まるなら1つのかたまりにし、収まらなければまとまりごとに分ける（段に1つずつ並ぶ高さで見込む）
  const pieces: Piece[] =
    groups.length === 0
      ? []
      : withSafety(balanced) <= room
        ? [{ html: html`${groups.map((g) => g.html)}`, mm: balanced, group: "checks" }]
        : groups.map((g) => ({ html: g.html, mm: g.mm, group: "checks" as const }));
  if (view.design.compact) {
    if (withStamps) {
      const stampRows = Math.ceil(view.stamps.length / 5);
      pieces.push({
        html: html`<div class="box line keep"><h3>${icon("deco-crest")}スタンプ</h3>${smallStamps(view)}</div>`,
        mm: boxMm(3 + stampRows * (18 + 1 + LINE(9, 1.3) * 2 + 2)),
      });
    }
    const srcW = (BOX_W - 5) / 2 - 8;
    const listH = twoColumnMm(view.sources.map((_, i) => sourceMm(view, i, srcW)));
    pieces.push({
      html: html`<div class="box line two-col"><h3>${icon("info")}出典</h3><ol class="sources">${view.sources.map((_, i) => sourceItem(view, i))}</ol>${closing(view)}${shopSeal("mini")}</div>`,
      mm: boxMm(listH + closingMm(view, BOX_W)),
    });
  }
  return flowSheets({
    kind: "checklist",
    label: "持ち物のチェックリスト",
    head: (cont) =>
      head("checklist", cont ? "出かける前に（つづき）" : "出かける前に", html`持ち物チェック`),
    headMm: headMm(true, false),
    pieces,
  });
}

function stampsSheets(view: ShioriView): Sheet[] {
  const pieces = stampPieces(view);
  if (view.design.kids) {
    pieces.push({
      html: html`<div class="draw"><div>見つけたものを描こう</div><div>いちばん楽しかったこと</div></div>`,
      mm: 4 + 44,
    });
  }
  for (let i = 0; i < view.memoPrompts.length; i += 2) {
    const pair = view.memoPrompts.slice(i, i + 2);
    pieces.push({
      html: html`<div class="memo">${pair.map((p) => memoBox(p, 3))}</div>`,
      mm:
        4 +
        memoBoxMm(3) -
        4 +
        LINE(12.5) * (Math.max(...pair.map((p) => lineCount(p, 70, pt(12.5)))) - 1),
    });
  }
  return flowSheets({
    kind: "stamps",
    label: "スタンプ帳",
    head: (cont) =>
      html`${head("stamps", cont ? "旅の記念に（つづき）" : "旅の記念に", html`スタンプ帳`)}${cont ? "" : html`<div class="shop-stamp">${symbol("deco-shop-mark", "")}<span>たびや</span><span class="sub">旅の相談所</span></div>`}`,
    headMm: headMm(true, false),
    pieces,
  });
}

function sourcesSheets(view: ShioriView): Sheet[] {
  const w = FLOW_WIDTH_MM - 8;
  const pieces: Piece[] = view.sources.map((_, i) => ({
    html: html`<ol class="sources">${sourceItem(view, i)}</ol>`,
    mm: sourceMm(view, i, w),
  }));
  pieces.push({ html: closing(view), mm: closingMm(view, FLOW_WIDTH_MM) });
  return flowSheets({
    kind: "sources",
    label: "出典",
    head: (cont) => head("sources", cont ? "調べたところ（つづき）" : "調べたところ", html`出典`),
    headMm: headMm(true, false),
    pieces,
  });
}

/** 冊子のページ数をそろえるための「旅の思い出」のページ */
function memorySheet(): Sheet {
  return {
    kind: "memory",
    cls: "",
    label: "旅の思い出",
    folio: true,
    body: html`${head("memory", "旅の記念に", html`旅の思い出`)}
    <div class="flow">
      <div class="frames">
        <div class="photo">${icon("camera")}写真をはろう</div>
        <div class="photo">${spot("lantern")}絵を描こう</div>
      </div>
      ${memoBox("思い出のメモ", 6)}
    </div>`,
  };
}

/** 店の印（たびや 旅の相談所） */
function shopSeal(cls = ""): Html {
  return html`<div class="seal ${cls}">${symbol("deco-shop-mark", "")}<span>たびや</span><span class="sub">旅の相談所</span></div>`;
}

/** 裏表紙の帯：店の印と名前、旅の前のお願い */
function backBand(): Html {
  return html`<div class="back-band keep">
    ${shopSeal()}
    <p>このしおりは、たびやのスタッフがお作りしました。<br />出かける前と当日の朝に、公式の情報で開催を確かめてください。</p>
  </div>`;
}

/** 裏表紙 */
function backSheet(view: ShioriView): Sheet {
  return {
    kind: "back",
    cls: "back",
    label: "裏表紙",
    folio: false,
    body: html`${symbol("deco-lantern-cluster", "cluster")}
    <p class="ribbon">${symbol("deco-shop-mark", "mark")}<span class="shop">たびや</span><span class="name">旅の相談所</span></p>
    <p class="thanks">いってらっしゃい！<br />よい旅を。</p>
    <div class="crew">
      ${staffImg("penguin_cheer", "main")}
      ${staffImg("hiyoko_wave", "waver")}
    </div>
    <p class="trip">${view.cover.title}<br /><span class="muted">${view.cover.dateLabel}</span></p>
    ${backBand()}
    <p class="how">冊子にするとき：A4 の両面で印刷し、プリンターの「小冊子」を選ぶと、2つ折りの A5 の冊子になります。</p>
    ${symbol("scene-town", "town")}`,
  };
}

/**
 * ページを作る。中身が多いページは「つづき」のページに分かれるので、
 * 分かれたあとで、冊子にできるよう4の倍数にそろえ直す（足りない分は、最後のページの前に旅の思い出のページを入れる）
 */
export function buildSheets(view: ShioriView): Sheet[] {
  TEXT_SCALE = view.design.largeText ? 12 / 10.5 : 1;
  let festival = 0;
  let day = 0;
  const renderers: Record<PageKind, () => Sheet[]> = {
    cover: () => [cover(view)],
    overview: () => overviewSheets(view),
    festival: () => festivalSheets(view.festivals[festival++] as FestivalView),
    day: () => daySheets(view, view.days[day++] as DayView),
    checklist: () => checklistSheets(view),
    stamps: () => stampsSheets(view),
    sources: () => sourcesSheets(view),
    memory: () => [],
    back: () => [backSheet(view)],
  };
  const kinds = view.pages.filter((kind) => kind !== "memory");
  const sheets = kinds.flatMap((kind) => renderers[kind]());
  // 最後のページ（裏表紙。半日のお出かけは持ち物のページが裏表紙を兼ねる）の前に、思い出のページを入れる
  const endKind = kinds[kinds.length - 1];
  const endStart = sheets.findIndex((s) => s.kind === endKind);
  const blank = (BOOKLET_PAGES - (sheets.length % BOOKLET_PAGES)) % BOOKLET_PAGES;
  sheets.splice(endStart, 0, ...Array.from({ length: blank }, memorySheet));
  return sheets;
}

function sheetHtml(sheet: Sheet, number: number, total: number): Html {
  return html`<div class="page" id="p${number}"><section class="sheet ${sheet.cls}" aria-label="${sheet.label}">
    ${corners()}
    ${sheet.body}
    ${sheet.folio ? html`<p class="folio" aria-hidden="true">${number} / ${total}</p>` : ""}
  </section></div>`;
}

/**
 * 見開き。冊子と同じく、表紙は1ページだけ、そのあとは2ページずつ並べ、最後のページは1ページだけにする。
 * ページをめくるのはリンク（#s<番号>）で、スクリプトは使わない
 */
export function spreadsOf(total: number): number[][] {
  if (total <= 1) return [[1]];
  const spreads: number[][] = [[1]];
  for (let n = 2; n < total; n += 2) spreads.push(n + 1 < total ? [n, n + 1] : [n]);
  spreads.push([total]);
  return spreads;
}

function book(sheets: readonly Sheet[]): Html {
  const total = sheets.length;
  const spreads = spreadsOf(total);
  return html`<main class="book" aria-label="旅のしおり（全${total}ページ）">
    ${spreads.map((pages, i) => {
      const label = pages.length === 1 ? `${pages[0]}ページ` : `${pages[0]}〜${pages[1]}ページ`;
      return html`<div class="spread${pages.length === 1 ? " single" : ""}" id="s${i + 1}" role="group" aria-label="${label}">
        ${i > 0 ? html`<a class="turn prev" href="#s${i}" aria-label="前のページ">‹</a>` : ""}
        ${pages.map((n) => sheetHtml(sheets[n - 1] as Sheet, n, total))}
        ${i < spreads.length - 1 ? html`<a class="turn next" href="#s${i + 2}" aria-label="次のページ">›</a>` : ""}
        <p class="where" aria-hidden="true">${label} / 全${total}ページ</p>
      </div>`;
    })}
  </main>`;
}

export interface RenderOptions {
  /** 画面で見るときの「PDF で保存」のリンク（PDF の中には出さない） */
  pdfHref: string | null;
  /** 画面で見るときに出す、この URL で開ける期限の一文（PDF の中には出さない）。なければ出さない */
  expiryNote?: string | null;
}

/** しおりの HTML 全体 */
export function renderShioriHtml(
  view: ShioriView,
  assets: ShioriAssets,
  options: RenderOptions,
): Html {
  const { design } = view;
  return html`<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${view.docTitle}</title>
    <style>${raw(shioriStyle(design.palette))}</style>
  </head>
  <body class="${design.largeText ? "large" : ""}" data-length="${design.length}" data-season="${design.season}" data-category="${design.category}">
    ${raw(assets.sprite)}
    ${
      options.pdfHref || options.expiryNote
        ? html`<nav class="toolbar">${
            options.pdfHref
              ? html`<a href="${options.pdfHref}" download>${icon("bag")}PDF で保存・印刷する</a>`
              : ""
          }${options.expiryNote ? html`<p class="expiry">${options.expiryNote}</p>` : ""}</nav>`
        : ""
    }
    ${book(buildSheets(view))}
  </body>
</html>`;
}
