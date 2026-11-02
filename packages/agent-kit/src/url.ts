// エージェントに取りに行かせてよい URL かを確かめる。
// 公開している接客サーバーで WebFetch を許すと、利用者の発言や読んだページの指示で、
// サーバーの内側（ループバック、社内向けの名前、クラウドのメタデータ）を取りに行かされうる。
// PreToolUse のフックでこの関数を通し、公開の Web 以外を止める。
// 名前解決の結果（内側のアドレスを指す公開の名前）までは確かめられないので、実行環境の
// ネットワークの設定と組み合わせる。

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

export interface UrlPolicy {
  /** https だけを許す。小さな町や観光協会のサイトには http だけのものがあるので、既定では http も許す */
  httpsOnly?: boolean;
}

const MAX_URL_LENGTH = 2_048;

/** 内側のネットワーク向けに使われる名前 */
const INTERNAL_HOSTS = new Set(["localhost", "metadata", "metadata.google.internal"]);
const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan"];

/** 末尾のラベル（トップレベルドメイン）。英字か、国際化ドメインの punycode */
const TOP_LEVEL_LABEL = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

export function checkPublicWebUrl(raw: unknown, policy: UrlPolicy = {}): UrlCheck {
  if (typeof raw !== "string" || raw === "") return deny("URL が文字列ではありません");
  if (raw.length > MAX_URL_LENGTH) return deny("URL が長すぎます");
  // 解釈の分かれやすい文字を含む URL は、解釈を揃えようとせずに止める
  if (/[\s\\]/.test(raw) || hasControlChar(raw)) {
    return deny("空白・制御文字・バックスラッシュを含む URL は使いません");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return deny("URL として読めません");
  }

  if (url.protocol !== "https:" && (policy.httpsOnly || url.protocol !== "http:")) {
    return deny(
      policy.httpsOnly ? "https 以外の URL は使いません" : "http(s) 以外の URL は使いません",
    );
  }
  if (url.username !== "" || url.password !== "") {
    return deny("ユーザー名やパスワードを含む URL は使いません");
  }
  if (url.port !== "") return deny("ポート番号を指定した URL は使いません");

  const host = url.hostname.toLowerCase();
  if (host.startsWith("[") || /^[\d.]+$/.test(host)) {
    return deny("IP アドレスを直接指定した URL は使いません");
  }
  if (INTERNAL_HOSTS.has(host) || INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return deny("内側のネットワーク向けのホストは使いません");
  }
  const labels = host.split(".");
  if (labels.length < 2 || !TOP_LEVEL_LABEL.test(labels.at(-1) ?? "")) {
    return deny("公開のドメイン名ではありません");
  }
  return { ok: true, url };
}

function hasControlChar(text: string): boolean {
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function deny(reason: string): UrlCheck {
  return { ok: false, reason };
}
