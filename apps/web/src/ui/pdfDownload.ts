// しおりの PDF を取ってから保存する。<a download> で直に保存すると、混み合いの 503 や
// 見つからない 404 のときに、エラーの中身が PDF の名前で保存されてしまうため。

/** 名前が分からないときの保存の名前 */
export const FALLBACK_PDF_NAME = "matsuri-ikoka-shiori.pdf";

export type PdfFetchResult =
  | { ok: true; blob: Blob; filename: string }
  | { ok: false; reason: "busy" | "failed" };

/** Content-Disposition から保存の名前を読む。filename* を先に使い、読めなければ null */
export function filenameFromDisposition(header: string | null): string | null {
  if (header === null) return null;
  const extended = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (extended?.[1] !== undefined) {
    try {
      return safeName(decodeURIComponent(extended[1].trim()));
    } catch {
      // 読めなければ、次の filename を使う
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"/i.exec(header) ?? /filename\s*=\s*([^;]+)/i.exec(header);
  return plain?.[1] === undefined ? null : safeName(plain[1].trim());
}

/** 保存の名前から、フォルダの区切りと制御文字を除く */
function safeName(name: string): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を取り除くため
  const cleaned = name.replace(/[\\/\u0000-\u001f\u007f]/g, "").trim();
  return cleaned === "" ? null : cleaned;
}

/** PDF を取る。状態が 2xx で、中身が PDF のときだけ成功にする */
export async function fetchShioriPdf(
  url: string,
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<PdfFetchResult> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { Accept: "application/pdf" } });
  } catch {
    return { ok: false, reason: "failed" };
  }
  if (response.status === 503 || response.status === 429) return { ok: false, reason: "busy" };
  const type = response.headers.get("content-type") ?? "";
  if (!response.ok || !type.toLowerCase().startsWith("application/pdf")) {
    return { ok: false, reason: "failed" };
  }
  try {
    const blob = await response.blob();
    const filename =
      filenameFromDisposition(response.headers.get("content-disposition")) ?? FALLBACK_PDF_NAME;
    return { ok: true, blob, filename };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/** 取った PDF を、端末に保存させる */
export function saveBlob(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  // 保存が始まるまで少し待ってから放す
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}
