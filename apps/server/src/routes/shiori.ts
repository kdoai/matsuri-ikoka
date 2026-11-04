import type { Itinerary } from "@matsuri-ikoka/schema";
import type { Hono } from "hono";
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
import { apiError } from "./errors";

// 旅のしおり。GET /shiori/:id は画面で見る HTML、GET /shiori/:id.pdf は同じテンプレートから作る A4 の PDF。
// しおりは URL で共有するので、合言葉はいらない（ID は推測されにくい乱数）。
// 祭りのデータとモデルの文章は、すべて文字列として埋め込む（エスケープする）。スクリプトは使わず、
// Content-Security-Policy で読み込める先を、このサーバーのフォントと画像だけに絞る。

export const SHIORI_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export interface ShioriDeps {
  /** 共有の URL の ID（旅程の ID か共有の ID）から旅程を読む。期限を過ぎた・消した旅程は undefined */
  readItinerary: (id: string) => Promise<Itinerary | undefined>;
  festivals: FestivalStore;
  /** 省略すると、assets/shiori と Chromium を使うものを作る */
  shiori?: Shiori;
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
    <style>body{margin:0;padding:32px 20px;font-family:sans-serif;color:#1e1a17;background:#fffaf2;line-height:1.7}main{max-width:640px;margin:0 auto}</style>
  </head>
  <body>
    <main><h1>${title}</h1><p>${message}</p></main>
  </body>
</html>`;
}

export function registerShioriRoutes(app: Hono, deps: ShioriDeps) {
  const shiori = deps.shiori ?? createShiori();
  const lookup = (id: string) => deps.festivals.get(id);

  // フォントとスタッフの静止画。ファイル名は決まった一覧から引くので、ほかのファイルは読めない
  app.get("/shiori/assets/*", (c) => {
    const file = shiori.asset(c.req.path.slice("/shiori/assets/".length));
    if (file === undefined) return c.text("Not Found", 404);
    c.header("Cache-Control", "public, max-age=86400");
    return c.body(new Uint8Array(file.body), 200, { "Content-Type": file.contentType });
  });

  app.get("/shiori/:id{[^/]+\\.pdf}", async (c) => {
    c.header("Content-Security-Policy", SHIORI_CSP);
    c.header("Referrer-Policy", "no-referrer");
    const found = await confirmedTrip(deps, c.req.param("id").slice(0, -".pdf".length));
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
        return c.json(
          apiError(
            "upstream_unavailable",
            "しおりの PDF を作るのが混み合っています。少し待ってから開き直してください。",
            true,
          ),
          503,
        );
      }
      throw error;
    }
  });

  app.get("/shiori/:id", async (c) => {
    c.header("Content-Security-Policy", SHIORI_CSP);
    c.header("Referrer-Policy", "no-referrer");
    const id = c.req.param("id");
    const found = await confirmedTrip(deps, id);
    if (!found.ok) return c.html(found.notice, found.status);
    return c.html(
      await shiori.html(found.trip, lookup, { pdfHref: `${encodeURIComponent(id)}.pdf` }),
    );
  });
}

type Found = { ok: true; trip: ShioriTrip } | { ok: false; notice: Html; status: 404 | 409 };

/**
 * 確定した旅程を、しおりとして出す。公式の情報で開催予定を確かめられた旅程と、
 * 確かめられなかった（not_found）が利用者が決めた旅程（表紙に注意を出す）。変更・中止と、まだ確かめていない旅程は出さない
 */
async function confirmedTrip(deps: ShioriDeps, id: string): Promise<Found> {
  const itinerary = await deps.readItinerary(id);
  if (itinerary === undefined) {
    return {
      ok: false,
      notice: renderShioriNotice("しおりが見つかりません", "URL を確かめてください。"),
      status: 404,
    };
  }
  const { verification } = itinerary;
  const confirmed = verification.status === "as_planned" && hasOfficialSource(verification.sources);
  if (!confirmed && verification.status !== "not_found") {
    return {
      ok: false,
      notice: renderShioriNotice(
        "まだ確定していない旅程です",
        "開催予定を公式の情報で確かめてから、しおりをお渡しします。",
      ),
      status: 409,
    };
  }
  return { ok: true, trip: toShioriTrip(itinerary) };
}
