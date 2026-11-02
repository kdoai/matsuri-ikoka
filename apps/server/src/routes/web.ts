import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono, MiddlewareHandler } from "hono";

// 画面のビルド（apps/web/dist）を、API と同じオリジンから配る（docs/architecture.md）。
// API・しおり・死活監視の経路を先に通し、それ以外の GET で画面のファイルを返す。
// 見つからない経路は、画面の中の経路として index.html を返す。

/** API など、画面のファイルを返さない経路 */
const SERVER_PATHS = /^\/(?:api|shiori)(?:\/|$)|^\/healthz?$/;

/** 画面のページに付ける見出し。読み込める先の細かい決まり（地図のタイルなど）は画面の側で決める */
const PAGE_HEADERS = {
  "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
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
