import {
  collectItinerarySources,
  type Etiquette,
  type Festival,
  type Itinerary,
  type ItineraryItem,
  UNKNOWN,
} from "@matsuri-ikoka/schema";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { formatMonthDayWithWeekday } from "../domain/calendar";
import { placeLabel } from "../domain/dateWindow";
import { occurrenceOn } from "../domain/planCheck";

// 旅のしおり（印刷できる HTML）。祭りのデータとモデルの文章は、すべて文字列として埋め込む（エスケープする）。
// スクリプトは使わず、Content-Security-Policy で読み込める先を絞る。

export const SHIORI_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

const MOVE_LABELS = {
  walk: "徒歩",
  train: "電車",
  bus: "バス",
  car: "車",
  taxi: "タクシー",
} as const;
const PARTICIPATION_LABELS = {
  watch_only: "見学のみ",
  join_open: "だれでも加われる",
  join_by_application: "申し込みが必要",
} as const;
const RISK_LABELS = { low: "低い", medium: "中くらい", high: "高い" } as const;
const PHOTO_LABELS = {
  allowed: "撮ってよい",
  restricted: "制限がある",
  prohibited: "撮らない",
} as const;
const PARKING_LABELS = {
  available: "あり",
  limited: "少ない",
  none: "なし",
  unknown: "不明",
} as const;
const ALTERNATIVE_LABELS = { rain: "雨の日", cancelled: "中止のとき", other: "そのほか" } as const;

const STYLE = `
:root { color-scheme: light; --ink: #2b2118; --sub: #6b5b4b; --line: #e3d6c3; --accent: #b3412c; }
* { box-sizing: border-box; }
body { margin: 0; font-family: "Hiragino Sans", "Noto Sans JP", "Yu Gothic", sans-serif; color: var(--ink); background: #fffaf2; line-height: 1.7; }
main { max-width: 760px; margin: 0 auto; padding: 32px 20px 48px; }
header { border-bottom: 3px double var(--accent); padding-bottom: 16px; margin-bottom: 24px; }
.brand { color: var(--accent); font-size: 0.85rem; letter-spacing: 0.2em; margin: 0; }
h1 { font-size: 1.7rem; margin: 4px 0 8px; }
h2 { font-size: 1.15rem; border-left: 6px solid var(--accent); padding-left: 10px; margin: 32px 0 12px; }
.sub, .meta { color: var(--sub); font-size: 0.9rem; }
.badge { display: inline-block; border: 1px solid var(--accent); color: var(--accent); border-radius: 999px; padding: 2px 12px; font-size: 0.85rem; }
ol.timeline { list-style: none; padding: 0; margin: 0; }
ol.timeline li { display: grid; grid-template-columns: 7.5em 1fr; gap: 12px; padding: 10px 0; border-bottom: 1px dashed var(--line); }
ol.timeline li.festival { background: #fdeee6; }
time { font-variant-numeric: tabular-nums; font-weight: 600; }
.name { font-weight: 700; }
p { margin: 2px 0; }
dl { display: grid; grid-template-columns: 11em 1fr; gap: 6px 12px; }
dt { font-weight: 700; }
dd { margin: 0; }
.en { color: var(--sub); font-weight: 400; font-size: 0.8rem; display: block; }
ul, ol.sources { padding-left: 1.3em; }
ol.sources a { color: var(--ink); word-break: break-all; }
footer { margin-top: 40px; color: var(--sub); font-size: 0.85rem; border-top: 1px solid var(--line); padding-top: 12px; }
@media print { body { background: #fff; } main { padding: 0; } a { text-decoration: none; } }
`;

function list(items: readonly string[]): Html {
  return html`<ul>${items.map((item) => html`<li>${item}</li>`)}</ul>`;
}

function textOrUnknown(value: unknown): string {
  return value === UNKNOWN || value === null || value === undefined ? "不明" : String(value);
}

function moveText(item: ItineraryItem): string | null {
  if (item.move === null) return null;
  const [min, max] = item.move.minutes;
  const range = min === max ? `${min}分` : `${min}〜${max}分`;
  return `${MOVE_LABELS[item.move.means]} ${range}（目安）`;
}

function timeline(itinerary: Itinerary): Html {
  return html`<ol class="timeline">
    ${itinerary.items.map((item) => {
      const meta = [
        moveText(item),
        item.hours ? `営業 ${item.hours.open}〜${item.hours.close}` : null,
        item.cost,
      ].filter((v): v is string => v !== null);
      return html`<li class="${item.type === "festival" ? "festival" : ""}">
        <time>${item.start}〜${item.end}</time>
        <div>
          <p class="name">${item.name}</p>
          <p>${item.reason}</p>
          ${meta.length > 0 ? html`<p class="meta">${meta.join("・")}</p>` : ""}
        </div>
      </li>`;
    })}
  </ol>`;
}

function etiquetteSection(etiquette: Etiquette): Html {
  const rows: [string, string, string][] = [
    [
      "参加のしかた",
      "How to take part",
      etiquette.participation === UNKNOWN ? "不明" : PARTICIPATION_LABELS[etiquette.participation],
    ],
    ...(etiquette.howToJoin === null
      ? []
      : [
          ["申し込み", "How to join", textOrUnknown(etiquette.howToJoin)] as [
            string,
            string,
            string,
          ],
        ]),
    ["ルールとマナー", "Rules", etiquette.rules === UNKNOWN ? "不明" : etiquette.rules.join("／")],
    ["服装", "What to wear", etiquette.dress === UNKNOWN ? "不明" : etiquette.dress.join("／")],
    ["持ち物", "What to bring", etiquette.bring === UNKNOWN ? "不明" : etiquette.bring.join("／")],
    [
      "危険度",
      "Risk",
      etiquette.risk === UNKNOWN
        ? "不明"
        : `${RISK_LABELS[etiquette.risk.level]}（${etiquette.risk.reason}）`,
    ],
    [
      "写真",
      "Photos",
      etiquette.photo === UNKNOWN
        ? "不明"
        : `${PHOTO_LABELS[etiquette.photo.policy]}${etiquette.photo.note ? `（${etiquette.photo.note}）` : ""}`,
    ],
  ];
  return html`<dl>
    ${rows.map(([ja, en, value]) => html`<dt>${ja}<span class="en">${en}</span></dt><dd>${value}</dd>`)}
  </dl>`;
}

function weatherText(itinerary: Itinerary): string {
  const { weather } = itinerary;
  if (weather.status === "not_yet")
    return "まだ予報が出ていません。前日に天気予報を確かめてください。";
  if (weather.status === "unavailable")
    return "予報を取得できませんでした。前日に天気予報を確かめてください。";
  const parts = [
    weather.summary,
    weather.precipitationPercent === null ? null : `降水確率 ${weather.precipitationPercent}%`,
    weather.highC === null ? null : `最高 ${weather.highC}℃`,
    weather.lowC === null ? null : `最低 ${weather.lowC}℃`,
  ].filter((v): v is string => v !== null);
  return parts.join("・");
}

/** 旅のしおりの HTML。主役の祭りは祭りのデータから引く */
export function renderShiori(itinerary: Itinerary, festival: Festival | undefined): Html {
  const occurrence = festival ? occurrenceOn(festival, itinerary.date) : null;
  const verification = itinerary.verification;
  const party = `大人${itinerary.party.adults}人${itinerary.party.children > 0 ? `・子ども${itinerary.party.children}人` : ""}`;
  const sources = [
    ...collectItinerarySources(itinerary),
    ...(festival?.etiquette.sources ?? []),
  ].filter((source, index, all) => all.findIndex((s) => s.url === source.url) === index);

  return html`<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${itinerary.title}｜旅のしおり</title>
    <style>${raw(STYLE)}</style>
  </head>
  <body>
    <main>
      <header>
        <p class="brand">MATSURI IKOKA ・ 旅のしおり</p>
        <h1>${itinerary.title}</h1>
        <p class="sub">${formatMonthDayWithWeekday(itinerary.date)}・${itinerary.origin}発 ${itinerary.returnTo}着・${party}</p>
        ${
          verification.status === "as_planned"
            ? html`<p class="badge">公式情報で開催予定を確認済み（${verification.checkedAt.slice(0, 16).replace("T", " ")}）</p>`
            : ""
        }
      </header>

      <section>
        <h2>当日の流れ</h2>
        ${timeline(itinerary)}
      </section>

      ${
        festival
          ? html`<section>
              <h2>${festival.name.ja}の見どころ</h2>
              <p class="sub">${placeLabel(festival)}・${festival.venue.name}${occurrence?.start ? `・${occurrence.start}〜${occurrence.end ?? ""}` : ""}</p>
              ${list(festival.highlights)}
            </section>
            <section>
              <h2>その土地の味</h2>
              ${festival.food.local.length > 0 ? list(festival.food.local.map((f) => (f.note ? `${f.name}：${f.note}` : f.name))) : html`<p>データにありません。</p>`}
              <p class="meta">屋台：${festival.food.stalls === "yes" ? "あり" : festival.food.stalls === "no" ? "なし" : "不明"}</p>
            </section>
            <section>
              <h2>はじめての方へ<span class="en">For first-time visitors</span></h2>
              ${etiquetteSection(festival.etiquette)}
            </section>
            <section>
              <h2>アクセス</h2>
              ${list([
                ...festival.access.stations.map(
                  (s) => `${s.name}から徒歩 ${s.walkMinutes[0]}〜${s.walkMinutes[1]}分（目安）`,
                ),
                `駐車場：${PARKING_LABELS[festival.access.parking]}`,
                ...festival.access.trafficRestrictions.map((t) => `交通規制：${t}`),
              ])}
            </section>`
          : ""
      }

      <section>
        <h2>持ち物と注意</h2>
        ${itinerary.notes.length > 0 ? list(itinerary.notes) : html`<p>特にありません。</p>`}
      </section>

      <section>
        <h2>雨の日・中止のとき</h2>
        ${list([
          ...(occurrence?.rainPolicy ? [`雨天の扱い：${occurrence.rainPolicy}`] : []),
          ...itinerary.alternatives.map((a) => `${ALTERNATIVE_LABELS[a.kind]}：${a.summary}`),
        ])}
      </section>

      <section>
        <h2>天気</h2>
        <p>${weatherText(itinerary)}</p>
      </section>

      <section>
        <h2>出典</h2>
        <ol class="sources">
          ${sources.map(
            (s) =>
              html`<li><a href="${s.url}" rel="noopener noreferrer">${s.title ?? s.url}</a> <span class="meta">（${s.checkedAt} 確認）</span></li>`,
          )}
        </ol>
      </section>

      <footer>
        移動の時間はすべて目安です。当日の朝も、公式サイトで開催を確かめてからお出かけください。
      </footer>
    </main>
  </body>
</html>`;
}

/** しおりをまだ出せないときの短いページ */
export function renderShioriNotice(title: string, message: string): Html {
  return html`<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${title}</title>
    <style>${raw(STYLE)}</style>
  </head>
  <body>
    <main><h1>${title}</h1><p>${message}</p></main>
  </body>
</html>`;
}
