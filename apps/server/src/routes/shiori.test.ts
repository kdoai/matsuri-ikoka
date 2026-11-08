import { FestivalSchema } from "@matsuri-ikoka/schema";
import {
  fictionalFestival,
  fictionalItinerary,
  fictionalSource,
} from "@matsuri-ikoka/schema/testing";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createFestivalStore } from "../data/festivalStore";
import { Consultations } from "../session/consultations";
import { StoragePersistence } from "../session/persistence";
import { ItineraryStore, SessionStore } from "../session/sessionStore";
import { createShiori } from "../shiori";
import type { PdfEngine } from "../shiori/pdf";
import { MemoryTripStorage } from "../storage/memory";
import { SecureRoutes } from "./policy";
import { noticeLocale, registerShioriRoutes } from "./shiori";

/** しおりの URL で開ける期限（11/6 の終わり。日本時間）*/
const EXPIRES_AT = Date.parse("2026-11-06T15:00:00Z");

function setup(engine?: PdfEngine, verified: boolean | "needs_check" | "not_found" = true) {
  const itineraries = new ItineraryStore();
  const itinerary = fictionalItinerary();
  if (verified === "needs_check" || verified === "not_found") {
    itinerary.verification = {
      status: verified,
      checkedAt: "2026-08-03T10:00:00+09:00",
      sources: verified === "needs_check" ? [fictionalSource("news", "single")] : [],
    };
  } else if (verified) {
    itinerary.verification = {
      status: "as_planned",
      checkedAt: "2026-08-03T10:00:00+09:00",
      sources: [fictionalSource("2026")],
    };
  }
  itineraries.save(itinerary, null);
  itineraries.save({ ...itinerary, id: `${itinerary.id}-2` }, null);
  const app = new Hono();
  const renders: string[] = [];
  const fake: PdfEngine = engine ?? {
    render: async (html) => {
      renders.push(html);
      return { pdf: Buffer.from("%PDF-1.7 fake"), blocked: 0 };
    },
    close: async () => {},
  };
  const sessions = new SessionStore();
  const persistence = new StoragePersistence({
    storage: new MemoryTripStorage(),
    itineraries,
    sessions,
  });
  const routes = new SecureRoutes(app, {
    verifier: null,
    persistence,
    consultations: new Consultations({ sessions, persistence }),
  });
  registerShioriRoutes(routes, {
    readItinerary: async (id) => {
      const itinerary = itineraries.get(id);
      return itinerary === undefined ? undefined : { itinerary, expiresAt: EXPIRES_AT };
    },
    festivals: createFestivalStore([FestivalSchema.parse(fictionalFestival())]),
    shiori: createShiori({
      engine: fake,
      config: {
        concurrency: 1,
        queue: 0,
        timeoutMs: 1000,
        cacheBytes: 1024 * 1024,
        executablePath: undefined,
      },
    }),
  });
  return { app, id: itinerary.id, renders };
}

describe("GET /shiori/:id.pdf", () => {
  it("確定した旅程のしおりを PDF で返し、同じ版はとっておいたものを返す", async () => {
    const { app, id, renders } = setup();

    const res = await app.request(`/shiori/${id}.pdf`);
    await app.request(`/shiori/${id}.pdf`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("%PDF-1.7 fake");
    expect(renders).toHaveLength(1);
    expect(renders[0]).toContain("鈴鳴灯籠まつり");
    expect(renders[0]).not.toContain("PDF で保存");
  });

  it("確定していない旅程は 409、ない旅程は 404 を返す", async () => {
    const { app, id } = setup(undefined, false);

    expect((await app.request(`/shiori/${id}.pdf`)).status).toBe(409);
    expect((await app.request("/shiori/no-such.pdf")).status).toBe(404);
  });

  it("要事前確認の旅程は、出発の前に確かめる注意を表紙に出して渡す。情報のない旅程は渡さない", async () => {
    const { app, id, renders } = setup(undefined, "needs_check");

    expect((await app.request(`/shiori/${id}.pdf`)).status).toBe(200);
    expect(renders[0]).toContain("要事前確認");
    const none = setup(undefined, "not_found");
    expect((await none.app.request(`/shiori/${none.id}.pdf`)).status).toBe(409);
  });

  it("混み合っていたら 503 で、少し待ってから開き直すよう伝える", async () => {
    const never: PdfEngine = { render: () => new Promise(() => {}), close: async () => {} };
    const { app, id } = setup(never);

    void app.request(`/shiori/${id}.pdf`);
    await new Promise((r) => setTimeout(r, 10));
    const res = await app.request(`/shiori/${id}-2.pdf`);

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("10");
    expect(await res.json()).toMatchObject({ code: "upstream_unavailable", retryable: true });
  });
});

describe("GET /shiori/:id", () => {
  it("画面で見る HTML に、PDF のリンクと決まった CSP を付ける", async () => {
    const { app, id } = setup();

    const res = await app.request(`/shiori/${id}`);
    const page = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("font-src 'self'");
    expect(page).toContain(`href="${id}.pdf"`);
    expect(page).toContain("この URL は 2026年11月6日まで開けます");
  });

  it("店に埋め込むときも、開ける期限を出す。PDF には出さない", async () => {
    const { app, id, renders } = setup();

    const embedded = await (await app.request(`/shiori/${id}?embed=1`)).text();
    await app.request(`/shiori/${id}.pdf`);

    expect(embedded).toContain("2026年11月6日まで開けます");
    expect(embedded).not.toContain("PDF で保存");
    expect(renders[0]).not.toContain("まで開けます");
  });

  it("見つからないときは、期限と開き直し方を伝え、確定していないときは店で続ける入口を出す", async () => {
    const missing = await (await setup().app.request("/shiori/no-such")).text();
    const draft = setup(undefined, false);
    const unconfirmed = await (await draft.app.request(`/shiori/${draft.id}`)).text();

    expect(missing).toContain("開ける期限を過ぎた");
    expect(missing).toContain("旅の最終日の3日後");
    expect(unconfirmed).toContain("店で続きを相談する");
    expect(unconfirmed).toContain('href="/"');
  });
});

describe("しおりの案内のページの言語", () => {
  it("?lang= を先に見て、なければブラウザの言語の初めの1つ。日本語でなければ英語、なければ日本語", () => {
    expect(noticeLocale("en", "ja-JP,ja;q=0.9")).toBe("en");
    expect(noticeLocale("ja", "en-US")).toBe("ja");
    expect(noticeLocale(undefined, "en-US,en;q=0.9,ja;q=0.8")).toBe("en");
    expect(noticeLocale(undefined, "ja;q=0.9,en;q=0.8")).toBe("ja");
    expect(noticeLocale(undefined, "fr-FR")).toBe("en");
    expect(noticeLocale("fr", undefined)).toBe("ja");
    expect(noticeLocale(undefined, undefined)).toBe("ja");
    expect(noticeLocale(undefined, "*")).toBe("ja");
  });

  it("404 と 409 の案内を、画面の言語かブラウザの言語で出す", async () => {
    const { app, id } = setup(undefined, false);

    const ja = await app.request("/shiori/no-such");
    expect(ja.status).toBe(404);
    expect(ja.headers.get("vary")).toContain("Accept-Language");
    const jaPage = await ja.text();
    expect(jaPage).toContain('<html lang="ja">');
    expect(jaPage).toContain("しおりが見つかりません");

    const en = await app.request("/shiori/no-such", { headers: { "Accept-Language": "en-US" } });
    const enPage = await en.text();
    expect(en.status).toBe(404);
    expect(enPage).toContain('<html lang="en">');
    expect(enPage).toContain("Travel booklet not found");
    expect(enPage).not.toContain("しおり");

    const pending = await app.request(`/shiori/${id}?embed=1&lang=en`, {
      headers: { "Accept-Language": "ja-JP" },
    });
    expect(pending.status).toBe(409);
    expect(await pending.text()).toContain("This itinerary is not confirmed yet");
    const pdf = await app.request(`/shiori/${id}.pdf?lang=en`);
    expect(pdf.status).toBe(409);
    expect(await pdf.text()).toContain("not confirmed yet");
  });

  it("PDF が混み合っているときの一文も、言語に合わせる", async () => {
    const never: PdfEngine = { render: () => new Promise(() => {}), close: async () => {} };
    const { app, id } = setup(never);

    void app.request(`/shiori/${id}.pdf`);
    await new Promise((r) => setTimeout(r, 10));
    const res = await app.request(`/shiori/${id}-2.pdf`, {
      headers: { "Accept-Language": "en" },
    });

    expect(res.status).toBe(503);
    expect(((await res.json()) as { message: string }).message).toContain("Please wait");
  });
});

describe("GET /shiori/assets/*", () => {
  it("フォントと静止画を返し、一覧にないパスは 404 にする", async () => {
    const { app } = setup();

    const font = await app.request("/shiori/assets/fonts/ZenMaruGothic-Medium.woff2");
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect((await app.request("/shiori/assets/staff/owl_book.webp")).status).toBe(200);
    for (const path of [
      "svg/icon-train.svg",
      "..%2F..%2Fpackage.json",
      "fonts/../../x",
      "nope.woff2",
    ]) {
      expect((await app.request(`/shiori/assets/${path}`)).status).toBe(404);
    }
  });
});
