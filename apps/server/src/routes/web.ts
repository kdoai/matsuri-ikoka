import { serveStatic } from "@hono/node-server/serve-static";
import type { MiddlewareHandler } from "hono";
import type { SecureRoutes } from "./policy";

// 画面のビルド（apps/web/dist）を、API と同じオリジンから配る（docs/architecture.md）。
// API・しおり・死活監視の経路を先に通し、それ以外の GET で画面のファイルを返す。
// 見つからない経路は、画面の中の経路として index.html を返す（assets の下は 404）。

/** API など、画面のファイルを返さない経路 */
const SERVER_PATHS = /^\/(?:api|shiori|internal)(?:\/|$)|^\/healthz?$/;

/**
 * 画面のページの CSP。本番のビルドを配って、3D・地図・相談・しおりまで通して確かめた最小の許可。
 * - script-src 'wasm-unsafe-eval'：3D のモデルの圧縮（meshopt）を WebAssembly で復号する
 * - img-src data:：地図（Leaflet）がタイルを片付けるときに置く、透明な 1×1 の画像
 * - img-src・connect-src blob:：3D のモデルに埋め込まれたテクスチャを読む
 *   （Chrome などは fetch、Safari 16 以前などは img で読む）
 * - img-src https://tile.openstreetmap.org：地図のタイル
 * - font-src data:：3D の文字の描画が埋め込んで読むフォント
 * - ログイン（Firebase Authentication）を用意しているときだけ：Google のログインの窓を開くスクリプト
 *   （apis.google.com）、ID トークンの発行（identitytoolkit・securetoken）、ログインの受け渡しの枠（authDomain）
 * インラインのスクリプト・スタイルと eval は許さない
 */
export function pageCsp(authDomain: string | null): string {
  const login = authDomain !== null && /^[a-z0-9.-]+$/i.test(authDomain);
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval'${login ? " https://apis.google.com" : ""}`,
    "style-src 'self'",
    "img-src 'self' data: blob: https://tile.openstreetmap.org",
    `connect-src 'self' blob:${login ? " https://identitytoolkit.googleapis.com https://securetoken.googleapis.com" : ""}`,
    "font-src 'self' data:",
    ...(login ? [`frame-src https://${authDomain}`] : []),
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** ファイル名に中身のハッシュが入っている assets は長く置き、ページは毎回確かめさせる */
function withHeaders(files: MiddlewareHandler, authDomain: string | null): MiddlewareHandler {
  /** 画面のページに付ける見出し */
  const pageHeaders = {
    "Content-Security-Policy": pageCsp(authDomain),
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
  return async (c, next) => {
    if (SERVER_PATHS.test(c.req.path)) return next();
    const res = await files(c, next);
    if (!(res instanceof Response)) return res;
    const immutable = c.req.path.startsWith("/assets/");
    res.headers.set(
      "Cache-Control",
      immutable ? "public, max-age=31536000, immutable" : "no-cache",
    );
    if (res.headers.get("Content-Type")?.startsWith("text/html")) {
      for (const [name, value] of Object.entries(pageHeaders)) res.headers.set(name, value);
    }
    return res;
  };
}

export function registerWebRoutes(
  routes: SecureRoutes,
  deps: { webDist: string; authDomain?: string | null },
) {
  const authDomain = deps.authDomain ?? null;
  // ビルドで作った圧縮済みのファイル（.br・.gz）があれば、ブラウザが受け取れる方を返す
  routes.files(
    "*",
    withHeaders(serveStatic({ root: deps.webDist, precompressed: true }), authDomain),
  );
  // 画面の中の経路（例：/trip/…）は index.html を返す。
  // 見つからない assets には返さない。新しい版を公開すると、開いたままのページが古いファイルを取りに来る。
  // そこに HTML を返すと、長く置く見出しも付くうえ、ブラウザは読み込みの失敗の理由を取り違える
  const page = withHeaders(
    serveStatic({ root: deps.webDist, path: "index.html", precompressed: true }),
    authDomain,
  );
  routes.files(
    "*",
    (c, next) => (c.req.path.startsWith("/assets/") ? next() : page(c, next)),
    "GET",
  );
}
