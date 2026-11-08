import { describe, expect, it, vi } from "vitest";
import { FALLBACK_PDF_NAME, fetchShioriPdf, filenameFromDisposition } from "./pdfDownload";

const URL_PDF = "https://example.com/shiori/trip-fictional.pdf";

function respond(body: BodyInit | null, status: number, headers: Record<string, string>) {
  return vi.fn<typeof fetch>(async () => new Response(body, { status, headers }));
}

describe("しおりの PDF を取る", () => {
  it("PDF が届いたら、中身とサーバーの付けた名前を返す", async () => {
    const fetchImpl = respond("%PDF-1.7", 200, {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="matsuri-ikoka-shiori.pdf"; filename*=UTF-8''${encodeURIComponent("架空の旅_旅のしおり.pdf")}`,
    });
    const result = await fetchShioriPdf(URL_PDF, fetchImpl);
    expect(result).toMatchObject({ ok: true, filename: "架空の旅_旅のしおり.pdf" });
    if (result.ok) expect(await result.blob.text()).toBe("%PDF-1.7");
    expect(fetchImpl).toHaveBeenCalledWith(URL_PDF, expect.anything());
  });

  it("混み合いの 503 は、待ってからの再試行を促す", async () => {
    const result = await fetchShioriPdf(
      URL_PDF,
      respond(JSON.stringify({ code: "upstream_unavailable" }), 503, {
        "content-type": "application/json",
      }),
    );
    expect(result).toEqual({ ok: false, reason: "busy" });
  });

  it("見つからない 404 の案内のページは、PDF として保存しない", async () => {
    const result = await fetchShioriPdf(
      URL_PDF,
      respond("<p>見つかりません</p>", 404, { "content-type": "text/html" }),
    );
    expect(result).toEqual({ ok: false, reason: "failed" });
  });

  it("200 でも中身が PDF でなければ、保存しない", async () => {
    const result = await fetchShioriPdf(
      URL_PDF,
      respond("<html></html>", 200, { "content-type": "text/html; charset=utf-8" }),
    );
    expect(result).toEqual({ ok: false, reason: "failed" });
  });

  it("通信が切れたら、失敗として返す", async () => {
    const result = await fetchShioriPdf(
      URL_PDF,
      vi.fn<typeof fetch>(async () => {
        throw new TypeError("network");
      }),
    );
    expect(result).toEqual({ ok: false, reason: "failed" });
  });
});

describe("保存の名前", () => {
  it("filename* を先に使い、なければ filename を使う", () => {
    expect(
      filenameFromDisposition(`attachment; filename="a.pdf"; filename*=UTF-8''b%20c.pdf`),
    ).toBe("b c.pdf");
    expect(filenameFromDisposition(`attachment; filename="a.pdf"`)).toBe("a.pdf");
    expect(filenameFromDisposition(null)).toBeNull();
  });

  it("フォルダの区切りは名前から除く", () => {
    expect(filenameFromDisposition(`attachment; filename*=UTF-8''..%2F..%2Fx.pdf`)).toBe(
      "....x.pdf",
    );
  });

  it("名前がなければ、決まった名前を使う", async () => {
    const result = await fetchShioriPdf(
      URL_PDF,
      respond("%PDF-1.7", 200, { "content-type": "application/pdf" }),
    );
    expect(result).toMatchObject({ ok: true, filename: FALLBACK_PDF_NAME });
  });
});
