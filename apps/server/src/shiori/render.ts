import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { ShioriAssets } from "./assets";
import { PAGE_STAFF, type PageKind, type StaffStill } from "./design";
import type { RouteView } from "./route";
import { shioriStyle } from "./style";
import type {
  DayView,
  FestivalView,
  GuideView,
  IconName,
  ShioriView,
  WeatherView,
} from "./viewModel";

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
  guide: "祭りの方からのお願いも書きました",
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
  guide: "spot-torii",
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
function spot(name: "lantern" | "torii" | "kinchaku" | "dango"): Html {
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

function value(text: string, unknown: boolean): Html {
  return unknown ? html`<span class="unknown">${text}</span>` : html`${text}`;
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

/** 紙の四隅の青海波（表紙と裏表紙と、画面で見るときの各ページ） */
function corners(): Html {
  return html`<div class="corners" aria-hidden="true">${["tl", "tr", "bl", "br"].map((at) => symbol("deco-corner", at))}</div>`;
}

function cover(view: ShioriView): Html {
  const c = view.cover;
  const { design } = view;
  const main = view.festivals[0];
  return html`<section class="sheet cover tone-${design.coverTone}" aria-label="表紙">
    ${corners()}
    ${symbol("deco-lantern-cluster", "cluster")}
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
    </div>
  </section>`;
}

function festivalPage(f: FestivalView): Html {
  return html`<section class="sheet" aria-label="祭りの紹介">
    ${corners()}
    ${head("festival", "今回の祭り", html`<span class="fest-name">${f.nameJa}</span>`, f.nameEn)}
    <div class="chips">
      <span class="chip">${icon("festival")}${f.categoryLabel}</span>
      <span class="chip">${icon("people")}${f.scaleLabel}</span>
      <span class="chip">${icon("pin")}${f.place}</span>
    </div>
    ${f.missing ? html`<p class="box alert">この祭りのデータが見つかりませんでした。日時と作法は、主催者の公式の情報で確かめてください。</p>` : ""}
    <div class="two">
      <div class="box keep"><h3>${icon("clock")}いつ</h3>${list(f.when, "when dots")}</div>
      <div class="box keep"><h3>${icon("pin")}どこで</h3><p><b>${f.venue}</b></p><p class="muted">${f.place}</p></div>
    </div>
    ${
      f.highlights.length > 0
        ? html`<div class="keep" style="margin-top:6mm"><h3 class="section-title">${spot("lantern")}${f.nameJa}の見どころ</h3>
            ${bubble("owl_book", "ここは見のがさないで！")}
            <div class="cards">${f.highlights.map((h, i) => html`<div class="card"><span class="num">${i + 1}</span>${h}</div>`)}</div></div>`
        : ""
    }
    ${
      f.trivia.length > 0
        ? html`<div class="box keep"><h3>${icon("info")}知ってた？</h3>${f.trivia.map((t) => html`<p class="trivia">${t}</p>`)}</div>`
        : ""
    }
    <div class="box line keep with-staff">
      <div>
        <h3 class="section-title">${spot("dango")}その土地の味</h3>
        <p><b>${f.food.stalls}</b></p>
        ${f.food.local.length > 0 ? list(f.food.local) : html`<p class="muted">地元の料理は、データにありません。</p>`}
      </div>
      ${staffImg("hen_point", "")}
    </div>
    ${f.access.length > 0 ? html`<div class="box keep"><h3>${icon("train")}アクセス</h3>${list(f.access)}</div>` : ""}
  </section>`;
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

function overviewPage(view: ShioriView): Html {
  return html`<section class="sheet" aria-label="旅の全体">
    ${corners()}
    ${head("overview", view.cover.lengthLabel, html`旅の全体`)}
    ${view.route ? routeMap(view.route, view.styleNotes) : ""}
    <ol class="overview">
      ${view.overview.map(
        (r) => html`<li class="keep">
          <span class="no">${r.number}</span>
          <span><b>${r.number}日目</b><br /><span class="muted">${r.dateLabel}</span></span>
          <span class="summary">${icon(r.icon)}${r.summary}</span>
          <span class="night">${icon(r.stay.endsWith("に帰る") ? "home" : "stay")}${r.stay}</span>
        </li>`,
      )}
    </ol>
  </section>`;
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

function dayPage(view: ShioriView, day: DayView): Html {
  const showRain = day.rainPlan.length > 0;
  const festivalDay = day.kind === "festival";
  return html`<section class="sheet day-page ${festivalDay ? "festival-day" : "calm-day"}" aria-label="${day.heading}">
    ${corners()}
    ${festivalDay ? symbol("deco-bunting", "day-bunting") : ""}
    ${head(
      "day",
      `${day.dateLabel}・${day.kindLabel}`,
      html`<span class="day-no">${day.heading}</span>`,
      null,
      festivalDay
        ? {
            still: "penguin_cheer",
            line: DAY_LINES.festival,
            medal: `motif-${view.design.category}`,
          }
        : { still: "hen_point", line: DAY_LINES[day.kind], medal: "icon-walk" },
    )}
    ${weatherChip(day.weather)}
    <div class="timeline">
      <p class="endpoint start"><span class="koma">ふりだし</span>${icon("pin")}${day.startLabel}</p>
      ${day.rows.map(
        (
          r,
          i,
        ) => html`<div class="step g-${STEP_GROUPS[r.icon] ?? "see"}${r.festival ? " festival" : ""}">
          <span class="time">${r.time}</span>
          <span class="dot">${icon(r.icon)}<b class="masu">${i + 1}</b></span>
          <div class="body">
            <p class="name"><span class="kind">${r.kind}</span>${r.name}</p>
            <p>${r.reason}</p>
            ${r.details.length > 0 ? html`<p class="details">${r.details.join("・")}</p>` : ""}
          </div>
        </div>`,
      )}
      ${day.returnLabel ? html`<p class="endpoint goal"><span class="koma">あがり</span>${icon("home")}${day.returnLabel}</p>` : ""}
    </div>
    ${
      day.stay
        ? html`<div class="box keep stay">${icon("stay")}<div><p class="muted">今夜泊まる地域</p><p class="area">${day.stay.area}</p>${day.stay.note ? html`<p>${day.stay.note}</p>` : ""}<p class="muted">宿の名前と予約は、ご自身で確かめてください。</p></div></div>`
        : ""
    }
    ${showRain ? html`<div class="box keep"><h3>${icon("umbrella")}雨の日・中止のとき</h3>${list(day.rainPlan)}</div>` : ""}
    ${day.memoLines > 0 ? memoBox("この日のメモ", day.memoLines) : ""}
  </section>`;
}

function guidePage(g: GuideView): Html {
  return html`<section class="sheet" aria-label="はじめての方へ">
    ${corners()}
    ${head("guide", g.festivalName, html`はじめての方へ`, "For first-time visitors")}
    ${
      g.missing
        ? html`<p class="box alert">この祭りの作法のデータが見つかりませんでした。作法は<span class="unknown">分からない</span>ので、主催者の公式の情報で確かめてください。</p>`
        : html`
          ${
            g.requests.length > 0
              ? html`<div class="box alert keep"><h3>${spot("torii")}祭りの方からのお願い<span class="en">&nbsp;Requests from the organizers</span></h3>${list(g.requests)}</div>`
              : ""
          }
          ${bubble("hen_point", "お願いを守って、地元の人と一緒に楽しもう")}
          <table class="guide">
            ${g.rows.map(
              (r) => html`<tr>
                <th><span class="lbl">${icon(r.icon)}${r.labelJa}</span><span class="en">${r.labelEn}</span></th>
                <td>${r.valuesJa.length > 1 ? list(r.valuesJa) : value(r.valuesJa[0] ?? "", r.unknown)}${r.valueEn ? html`<span class="en">${r.valueEn}</span>` : ""}</td>
              </tr>`,
            )}
          </table>
          ${g.cautions.length > 0 ? html`<div class="box keep"><h3>${icon("info")}注意<span class="en">&nbsp;Notes</span></h3>${list(g.cautions)}</div>` : ""}
          <p class="muted" style="margin-top:3mm;font-size:9pt">「分からない」は、調べても確かめられなかった項目です。当日、会場の係の方に確かめてください。<br /><span class="en">"Unknown" means we could not confirm it. Please ask the staff at the venue.</span></p>
        `
    }
  </section>`;
}

function stampGrid(view: ShioriView, small: boolean): Html {
  return html`<div class="stamps${small ? " small" : ""}">
    ${view.stamps.map(
      (s, i) => html`<div class="stamp keep" style="--i:${i}">
        <div class="ring">${symbol("deco-stamp-ring", "")}</div>
        <p class="lbl">${s.label}</p>
        ${s.sub ? html`<p class="sub">${s.sub}</p>` : ""}
      </div>`,
    )}
  </div>`;
}

function sourcesList(view: ShioriView): Html {
  return html`<ol class="sources">
      ${view.sources.map(
        (s) => html`<li><div>
          ${s.title ? html`<p class="t">${s.title}</p>` : ""}
          <p class="url">${s.url}<span class="meta">（${s.checkedAt} に確認・${s.confidence}）</span></p>
        </div></li>`,
      )}
    </ol>
    <div class="closing">${view.closing.map((line) => html`<p>${line}</p>`)}</div>`;
}

function checklistPage(view: ShioriView): Html {
  return html`<section class="sheet" aria-label="持ち物のチェックリスト">
    ${corners()}
    ${head("checklist", "出かける前に", html`持ち物チェック`)}
    <div class="checks">
      ${view.checklist.map(
        (g) => html`<div class="group">
          <h3>${icon(g.icon)}${g.title}</h3>
          ${g.note ? html`<p class="note">${g.note}</p>` : ""}
          <ul>${g.items.map((item) => html`<li>${item}</li>`)}</ul>
        </div>`,
      )}
    </div>
    ${
      view.design.compact
        ? html`<div class="box line keep"><h3>${icon("deco-crest")}スタンプ</h3>${stampGrid(view, true)}</div>
          <div class="box line two-col"><h3>${icon("info")}出典</h3>${sourcesList(view)}${shopSeal("mini")}</div>`
        : ""
    }
  </section>`;
}

function stampsPage(view: ShioriView): Html {
  return html`<section class="sheet" aria-label="スタンプ帳">
    ${corners()}
    ${head("stamps", "旅の記念に", html`スタンプ帳`)}
    ${stampGrid(view, false)}
    ${
      view.design.kids
        ? html`<div class="draw"><div>見つけたものを描こう</div><div>いちばん楽しかったこと</div></div>`
        : ""
    }
    ${view.memoPrompts.length > 0 ? html`<div class="memo">${view.memoPrompts.map((p) => memoBox(p, 3))}</div>` : ""}
    <div class="shop-stamp">${symbol("deco-shop-mark", "")}<span>たびや</span><span class="sub">旅の相談所</span></div>
  </section>`;
}

function sourcesPage(view: ShioriView): Html {
  return html`<section class="sheet" aria-label="出典">
    ${corners()}
    ${head("sources", "調べたところ", html`出典`)}
    ${sourcesList(view)}
  </section>`;
}

/** 冊子のページ数をそろえるための「旅の思い出」のページ */
function memoryPage(): Html {
  return html`<section class="sheet" aria-label="旅の思い出">
    ${corners()}
    ${head("memory", "旅の記念に", html`旅の思い出`)}
    <div class="frames">
      <div class="photo">${icon("camera")}写真をはろう</div>
      <div class="photo">${spot("lantern")}絵を描こう</div>
    </div>
    ${memoBox("思い出のメモ", 6)}
  </section>`;
}

/** 裏表紙の帯：店の印と名前、旅の前のお願い（半日のお出かけは持ち物のページの下に置く） */
/** 店の印（たびや 旅の相談所） */
function shopSeal(cls = ""): Html {
  return html`<div class="seal ${cls}">${symbol("deco-shop-mark", "")}<span>たびや</span><span class="sub">旅の相談所</span></div>`;
}

function backBand(): Html {
  return html`<div class="back-band keep">
    ${shopSeal()}
    <p>このしおりは、たびやのスタッフがお作りしました。<br />出かける前と当日の朝に、公式の情報で開催を確かめてください。</p>
  </div>`;
}

/** 裏表紙 */
function backPage(view: ShioriView): Html {
  return html`<section class="sheet back" aria-label="裏表紙">
    ${corners()}
    ${symbol("deco-lantern-cluster", "cluster")}
    <p class="ribbon">${symbol("deco-shop-mark", "mark")}<span class="shop">たびや</span><span class="name">旅の相談所</span></p>
    <p class="thanks">いってらっしゃい！<br />よい旅を。</p>
    <div class="crew">
      ${staffImg("penguin_cheer", "main")}
      ${staffImg("hiyoko_wave", "waver")}
    </div>
    <p class="trip">${view.cover.title}<br /><span class="muted">${view.cover.dateLabel}</span></p>
    ${backBand()}
    <p class="how">冊子にするとき：A4 の両面で印刷し、プリンターの「小冊子」を選ぶと、2つ折りの A5 の冊子になります。</p>
    ${symbol("scene-town", "town")}
  </section>`;
}

function pages(view: ShioriView): Html[] {
  let festival = 0;
  let day = 0;
  let guide = 0;
  const renderers: Record<PageKind, () => Html> = {
    cover: () => cover(view),
    overview: () => overviewPage(view),
    festival: () => festivalPage(view.festivals[festival++] as FestivalView),
    day: () => dayPage(view, view.days[day++] as DayView),
    guide: () => guidePage(view.guides[guide++] as GuideView),
    checklist: () => checklistPage(view),
    stamps: () => stampsPage(view),
    sources: () => sourcesPage(view),
    memory: () => memoryPage(),
    back: () => backPage(view),
  };
  return view.pages.map((kind) => renderers[kind]());
}

export interface RenderOptions {
  /** 画面で見るときの「PDF で保存」のリンク（PDF の中には出さない） */
  pdfHref: string | null;
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
      options.pdfHref
        ? html`<nav class="toolbar"><a href="${options.pdfHref}" download>${icon("bag")}PDF で保存・印刷する</a></nav>`
        : ""
    }
    ${pages(view)}
  </body>
</html>`;
}
