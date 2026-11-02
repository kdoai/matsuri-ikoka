import { describe, expect, it } from "vitest";
import { checkPublicWebUrl } from "./url";

describe("checkPublicWebUrl", () => {
  it.each([
    "https://example.com/festival/2026",
    "http://example.jp/",
    "https://www.city.example.lg.jp/kanko/matsuri.html?year=2026",
    "https://日本語.example.jp/",
    "https://example.com:443/",
  ])("公開の Web の URL を通す：%s", (url) => {
    expect(checkPublicWebUrl(url).ok).toBe(true);
  });

  it.each([
    ["http(s) 以外", "ftp://example.com/file"],
    ["スクリプト", "javascript:alert(1)"],
    ["ループバックの IP", "https://127.0.0.1/"],
    ["書き方を変えた IP", "https://0x7f.1/"],
    ["IPv6", "https://[::1]/"],
    ["メタデータのアドレス", "http://169.254.169.254/latest/meta-data/"],
    ["localhost", "https://localhost/admin"],
    ["メタデータの名前", "http://metadata.google.internal/computeMetadata/v1/"],
    ["内側向けの名前", "https://db.internal/"],
    ["ドメイン名のないホスト", "https://intranet/"],
    ["ユーザー名とパスワード", "https://user:pass@example.com/"],
    ["ポート番号", "https://example.com:8443/"],
    ["バックスラッシュ", "https://evil.example\\@example.com/"],
    ["空白", "https://exa mple.com/"],
    ["制御文字", "https://example.com/\u0000"],
  ])("止める：%s", (_, url) => {
    const result = checkPublicWebUrl(url);
    expect(result.ok).toBe(false);
  });

  it("https だけを許すと、http を止める", () => {
    expect(checkPublicWebUrl("http://example.jp/", { httpsOnly: true }).ok).toBe(false);
  });

  it("文字列でなければ止める", () => {
    expect(checkPublicWebUrl(undefined).ok).toBe(false);
    expect(checkPublicWebUrl({ url: "https://example.com" }).ok).toBe(false);
  });

  it("止めた理由を返す", () => {
    const result = checkPublicWebUrl("https://localhost/");
    expect(result).toEqual({ ok: false, reason: "内側のネットワーク向けのホストは使いません" });
  });
});
