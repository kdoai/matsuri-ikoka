import { DEFAULT_LOCALE, type Itinerary, type Locale, LocaleSchema } from "@matsuri-ikoka/schema";
import type { Context } from "hono";
import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { FestivalStore } from "../data/festivalStore";
import { hasOfficialSource } from "../domain/verification";
import {
  createShiori,
  type Shiori,
  ShioriPdfBusyError,
  ShioriPdfTimeoutError,
  toShioriTrip,
} from "../shiori";
import type { ShioriTrip } from "../shiori/trip";
import type { OwnerId } from "../storage/owner";
import { apiError } from "./errors";
import { routeParam, type SecureRoutes } from "./policy";

// 旅のしおり。GET /shiori/:id は画面で見る HTML、GET /shiori/:id.pdf は同じテンプレートから作る A4 の PDF。
// しおりは URL で共有するので、合言葉はいらない（ID は推測されにくい乱数）。
// 開けるのは、共有の ID と、持ち主のない旅程の ID だけ。持ち主のある旅程の ID では、ないものとして断る。
// 祭りのデータとモデルの文章は、すべて文字列として埋め込む（エスケープする）。スクリプトは使わず、
// Content-Security-Policy で読み込める先を、このサーバーのフォントと画像だけに絞る。
// 店内の画面は、しおりをそのまま埋め込んで見せる（?embed=1。同じオリジンからだけ埋め込める）。
// しおりをまだ出せないときの案内のページは、日本語と英語で出す。画面から開くときは画面の言語（?lang=）、
// 共有された URL を直接開いたときはブラウザの言語（Accept-Language）に合わせる。

export const SHIORI_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export interface ShioriDeps {
  /** ID（共有の ID か、持ち主のない旅程の ID）から旅程を読む。期限を過ぎた・消した・ほかの人の旅程は undefined */
  readItinerary: (id: string, viewer: OwnerId | null) => Promise<Itinerary | undefined>;
  festivals: FestivalStore;
  /** 省略すると、assets/shiori と Chromium を使うものを作る */
  shiori?: Shiori;
}

type NoticeKind = "not_found" | "not_confirmed";

const NOTICES: Record<Locale, Record<NoticeKind, { title: string; message: string }>> = {
  ja: {
    not_found: { title: "しおりが見つかりません", message: "URL を確かめてください。" },
    not_confirmed: {
      title: "まだ確定していない旅程です",
      message: "開催予定を公式の情報で確かめてから、しおりをお渡しします。",
    },
  },
  en: {
    not_found: { title: "Travel booklet not found", message: "Please check the URL." },
    not_confirmed: {
      title: "This itinerary is not confirmed yet",
      message:
        "We will hand over the travel booklet after confirming the festival schedule with official information.",
    },
  },
};

const PDF_BUSY: Record<Locale, string> = {
  ja: "しおりの PDF を作るのが混み合っています。少し待ってから開き直してください。",
  en: "Many travel booklet PDFs are being made right now. Please wait a moment and open it again.",
};

/**
 * 案内のページの言語。?lang=（ja か en）があればそれを使い、なければ Accept-Language のいちばん初めの言語。
 * 画面と同じく、日本語でなければ英語にする。どちらもなければ日本語
 */
export function noticeLocale(lang: string | undefined, acceptLanguage: string | undefined): Locale {
  const asked = LocaleSchema.safeParse(lang);
  if (asked.success) return asked.data;
  const first = acceptLanguage?.split(",")[0]?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (first === "" || first === "*") return DEFAULT_LOCALE;
  return first.startsWith("ja") ? "ja" : "en";
}

function localeOf(c: Context): Locale {
  // 言語で中身が変わるので、間に置いたキャッシュが言語を取り違えないようにする
  c.header("Vary", "Accept-Language");
  return noticeLocale(c.req.query("lang"), c.req.header("Accept-Language"));
}

/** しおりをまだ出せないときの短いページ */
export function renderShioriNotice(kind: NoticeKind, locale: Locale = DEFAULT_LOCALE): Html {
  const { title, message } = NOTICES[locale][kind];
  return html`<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${title}</title>
    <style>body{margin:0;padding:32px 20px;font-family:sans-serif;color:#1e1a17;background:#fffaf2;line-height:1.7}main{max-width:640px;margin:0 auto}</style>
  </head>
  <body>
    <main><h1>${title}</h1><p>${message}</p></main>
  </body>
</html>`;
}

export function registerShioriRoutes(routes: SecureRoutes, deps: ShioriDeps) {
  const shiori = deps.shiori ?? createShiori();
  const lookup = (id: string) => deps.festivals.get(id);

  // フォントとスタッフの静止画。ファイル名は決まった一覧から引くので、ほかのファイルは読めない
  routes.public("GET", "/shiori/assets/*", (c) => {
    const file = shiori.asset(c.req.path.slice("/shiori/assets/".length));
    if (file === undefined) return c.text("Not Found", 404);
    c.header("Cache-Control", "public, max-age=86400");
    return c.body(new Uint8Array(file.body), 200, { "Content-Type": file.contentType });
  });

  routes.public("GET", "/shiori/:id{[^/]+\\.pdf}", async (c, { viewer }) => {
    c.header("Content-Security-Policy", SHIORI_CSP);
    c.header("Referrer-Policy", "no-referrer");
    const found = await confirmedTrip(
      deps,
      routeParam(c, "id").slice(0, -".pdf".length),
      await viewer(),
      localeOf(c),
    );
    if (!found.ok) return c.html(found.notice, found.status);
    try {
      const pdf = await shiori.pdf(found.trip, lookup);
      const filename = encodeURIComponent(`${found.trip.title}_旅のしおり.pdf`);
      return c.body(new Uint8Array(pdf), 200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="matsuri-ikoka-shiori.pdf"; filename*=UTF-8''${filename}`,
        "Cache-Control": "private, max-age=300",
      });
    } catch (error) {
      if (error instanceof ShioriPdfBusyError || error instanceof ShioriPdfTimeoutError) {
        c.header("Retry-After", "10");
        return c.json(apiError("upstream_unavailable", PDF_BUSY[localeOf(c)], true), 503);
      }
      throw error;
    }
  });

  routes.public("GET", "/shiori/:id", async (c, { viewer }) => {
    c.header("Content-Security-Policy", SHIORI_CSP);
    c.header("Referrer-Policy", "no-referrer");
    const id = routeParam(c, "id");
    const found = await confirmedTrip(deps, id, await viewer(), localeOf(c));
    if (!found.ok) return c.html(found.notice, found.status);
    // 店内の画面に埋め込むときは、画面の側に「PDF で保存」があるので、しおりの上の帯を出さない
    const embedded = c.req.query("embed") === "1";
    return c.html(
      await shiori.html(found.trip, lookup, {
        pdfHref: embedded ? null : `${encodeURIComponent(id)}.pdf`,
      }),
    );
  });
}

type Found = { ok: true; trip: ShioriTrip } | { ok: false; notice: Html; status: 404 | 409 };

/**
 * 確定した旅程を、しおりとして出す。公式の情報で開催予定を確かめられた旅程と、
 * 要事前確認（公式以外の情報源で確かめた）の旅程（表紙に注意を出す）。それ以外は出さない
 */
async function confirmedTrip(
  deps: ShioriDeps,
  id: string,
  viewer: OwnerId | null,
  locale: Locale,
): Promise<Found> {
  const itinerary = await deps.readItinerary(id, viewer);
  if (itinerary === undefined) {
    return { ok: false, notice: renderShioriNotice("not_found", locale), status: 404 };
  }
  const { verification } = itinerary;
  const confirmed = verification.status === "as_planned" && hasOfficialSource(verification.sources);
  const needsCheck = verification.status === "needs_check" && verification.sources.length > 0;
  if (!confirmed && !needsCheck) {
    return {
      ok: false,
      notice: renderShioriNotice("not_confirmed", locale),
      status: 409,
    };
  }
  return { ok: true, trip: toShioriTrip(itinerary) };
}
