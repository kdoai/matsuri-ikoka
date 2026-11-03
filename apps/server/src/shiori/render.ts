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
// スクリプトは使わない。

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

/** ページごとのスタッフのひとこと（決まった文） */
const PAGE_LINES: Partial<Record<PageKind, string>> = {
  festival: "調べた見どころをまとめました",
  overview: "旅の全体の流れです",
  day: "時刻は目安。早めに動くと安心です",
  guide: "祭りの方からのお願いも書きました",
  checklist: "出かける前にチェック！",
  stamps: "旅の思い出に、スタンプやサインをどうぞ",
  sources: "しおりの情報は、ここから調べました",
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
  override: { still: StaffStill; line: string } | null = null,
): Html {
  const still = override?.still ?? PAGE_STAFF[kind];
  const line = override?.line ?? PAGE_LINES[kind];
  return html`<header class="head">
    <div class="title">
      <span class="kicker">${kicker}</span>
      <h2>${title}${en ? html`<span class="en">${en}</span>` : ""}</h2>
      ${symbol("deco-wave", "wave")}
      ${line && still ? html`<p class="bubble"><span class="who">${STAFF_NAMES[still]}</span>${line}</p>` : ""}
    </div>
    ${still ? staffImg(still) : ""}
  </header>`;
}

// ---------------------------------------------------------------------------

function cover(view: ShioriView): Html {
  const c = view.cover;
  const { design } = view;
  const main = view.festivals[0];
  return html`<section class="sheet cover" aria-label="表紙">
    ${symbol("deco-bunting", "bunting")}
    ${symbol(`season-${design.season}`, "season a")}
    <div class="motif-bg"></div>
    ${symbol(`motif-${design.category}`, "motif")}
    <p class="brand">${c.brand}</p>
    <p class="length">${c.lengthLabel}</p>
    <h1 class="${c.longTitle ? "long" : ""}">${c.title}</h1>
    <div class="festival">
      <p class="label">きょうの主役</p>
      <p class="name">${c.festivalName}${c.festivalNameEn ? html`<span class="en">${c.festivalNameEn}</span>` : ""}</p>
      ${c.place ? html`<p class="place">${c.place}</p>` : ""}
    </div>
    ${
      design.compact && main && main.highlights.length > 0
        ? html`<div class="highlights"><h3>見どころ</h3>${list(main.highlights)}</div>`
        : ""
    }
    ${c.verifiedLabel ? html`<p class="verified">${icon("deco-crest")}${c.verifiedLabel}</p>` : ""}
    <dl class="ticket">
      <div><dt>${icon("calendar")}日にち</dt><dd>${c.dateLabel}</dd></div>
      <div><dt>${icon("people")}だれと</dt><dd>${c.partyLabel}</dd></div>
      <div><dt>${icon("pin")}出発</dt><dd>${c.routeLabel}</dd></div>
      <div><dt>${icon(c.weather.icon)}天気</dt><dd>${c.weather.text}</dd></div>
    </dl>
    <div class="crew">
      ${staffImg("penguin_cheer", "main")}
      ${staffImg("hiyoko_wave", "")}
      <p class="bubble"><span class="who">コンシェルジュのひよこ</span>${c.greeting}</p>
    </div>
  </section>`;
}

function festivalPage(f: FestivalView): Html {
  return html`<section class="sheet" aria-label="祭りの紹介">
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
        ? html`<div class="keep" style="margin-top:6mm"><h3 class="section-title">${f.nameJa}の見どころ</h3>
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
        <h3 class="section-title">${icon("meal")}その土地の味</h3>
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
        ) => html`<div class="stop ${s.kind}${s.festival ? " fest" : ""}" style="left:${s.x / 2}%;top:${s.y}%">
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
    ${festivalDay ? symbol("deco-bunting", "day-bunting") : ""}
    ${head(
      "day",
      `${day.dateLabel}・${day.kindLabel}`,
      html`<span class="day-head"><span class="day-no">${day.heading}</span>${festivalDay ? symbol(`motif-${view.design.category}`, "day-motif") : ""}</span>`,
      null,
      festivalDay
        ? { still: "penguin_cheer", line: DAY_LINES.festival }
        : { still: "hen_point", line: DAY_LINES[day.kind] },
    )}
    ${weatherChip(day.weather)}
    <div class="timeline">
      <p class="endpoint">${icon("pin")}${day.startLabel}</p>
      ${day.rows.map(
        (r) => html`<div class="step${r.festival ? " festival" : ""}">
          <span class="time">${r.time}</span>
          <span class="dot">${icon(r.icon)}</span>
          <div class="body">
            <p class="name"><span class="kind">${r.kind}</span>${r.name}</p>
            <p>${r.reason}</p>
            ${r.details.length > 0 ? html`<p class="details">${r.details.join("・")}</p>` : ""}
          </div>
        </div>`,
      )}
      ${day.returnLabel ? html`<p class="endpoint">${icon("home")}${day.returnLabel}</p>` : ""}
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
    ${head("guide", g.festivalName, html`はじめての方へ`, "For first-time visitors")}
    ${
      g.missing
        ? html`<p class="box alert">この祭りの作法のデータが見つかりませんでした。作法は<span class="unknown">分からない</span>ので、主催者の公式の情報で確かめてください。</p>`
        : html`
          ${
            g.requests.length > 0
              ? html`<div class="box alert keep"><h3>${icon("warn")}祭りの方からのお願い<span class="en">&nbsp;Requests from the organizers</span></h3>${list(g.requests)}</div>`
              : ""
          }
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
      (s) => html`<div class="stamp keep">
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
    ${head("checklist", "出かける前に", html`持ち物チェック`)}
    <div class="checks">
      ${view.checklist.map(
        (g) => html`<div class="group">
          <h3>${g.title}</h3>
          ${g.note ? html`<p class="note">${g.note}</p>` : ""}
          <ul>${g.items.map((item) => html`<li>${item}</li>`)}</ul>
        </div>`,
      )}
    </div>
    ${
      view.design.compact
        ? html`<div class="box line keep"><h3>${icon("deco-crest")}スタンプ</h3>${stampGrid(view, true)}</div>
          <div class="box line two-col"><h3>${icon("info")}出典</h3>${sourcesList(view)}</div>`
        : ""
    }
  </section>`;
}

function stampsPage(view: ShioriView): Html {
  return html`<section class="sheet" aria-label="スタンプ帳">
    ${head("stamps", "旅の記念に", html`スタンプ帳`)}
    ${stampGrid(view, false)}
    ${
      view.design.kids
        ? html`<div class="draw"><div>見つけたものを描こう</div><div>いちばん楽しかったこと</div></div>`
        : ""
    }
    ${view.memoPrompts.length > 0 ? html`<div class="memo">${view.memoPrompts.map((p) => memoBox(p, 3))}</div>` : ""}
    ${symbol("deco-crest", "crest")}
  </section>`;
}

function sourcesPage(view: ShioriView): Html {
  return html`<section class="sheet" aria-label="出典">
    ${head("sources", "調べたところ", html`出典`)}
    ${sourcesList(view)}
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
