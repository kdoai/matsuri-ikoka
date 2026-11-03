import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono, MiddlewareHandler } from "hono";

// 画面のビルド（apps/web/dist）を、API と同じオリジンから配る（docs/architecture.md）。
// API・しおり・死活監視の経路を先に通し、それ以外の GET で画面のファイルを返す。
// 見つからない経路は、画面の中の経路として index.html を返す。

/** API など、画面のファイルを返さない経路 */
const SERVER_PATHS = /^\/(?:api|shiori)(?:\/|$)|^\/healthz?$/;

/**
 * 画面のページの CSP。本番のビルドを配って、3D・地図・相談・しおりまで通して確かめた最小の許可。
 * - script-src 'wasm-unsafe-eval'：3D のモデルの圧縮（meshopt）を WebAssembly で復号する
 * - img-src data:：地図（Leaflet）がタイルを片付けるときに置く、透明な 1×1 の画像
 * - img-src・connect-src blob:：3D のモデルに埋め込まれたテクスチャを読む
 *   （Chrome などは fetch、Safari 16 以前などは img で読む）
 * - img-src https://tile.openstreetmap.org：地図のタイル
 * インラインのスクリプト・スタイルと eval は許さない
 */
const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data: blob: https://tile.openstreetmap.org",
  "connect-src 'self' blob:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** 画面のページに付ける見出し */
const PAGE_HEADERS = {
  "Content-Security-Policy": PAGE_CSP,
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

/** ファイル名に中身のハッシュが入っている assets は長く置き、ページは毎回確かめさせる */
function withHeaders(files: MiddlewareHandler): MiddlewareHandler {
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
      for (const [name, value] of Object.entries(PAGE_HEADERS)) res.headers.set(name, value);
    }
    return res;
  };
}

export function registerWebRoutes(app: Hono, deps: { webDist: string }) {
  app.use("*", withHeaders(serveStatic({ root: deps.webDist })));
  // 画面の中の経路（例：/trip/…）は index.html を返す
  app.get("*", withHeaders(serveStatic({ root: deps.webDist, path: "index.html" })));
}
