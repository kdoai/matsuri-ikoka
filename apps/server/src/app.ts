import type { AuthConfig } from "@matsuri-ikoka/schema";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { IdTokenVerifier } from "./account/idToken";
import type { InternalVerifiers } from "./account/internalAuth";
import type { FestivalStore } from "./data/festivalStore";
import { errorForLog } from "./log";
import type { PatrolDeps } from "./patrol/runner";
import { type ChatOptions, registerChatRoutes } from "./routes/chat";
import { apiError } from "./routes/errors";
import { type FestivalSearchOptions, registerFestivalSearchRoutes } from "./routes/festivalSearch";
import { registerFestivalRoutes } from "./routes/festivals";
import { registerFestivalTripRoutes } from "./routes/festivalTrips";
import { passcodeGuard } from "./routes/guard";
import { type GuideOptions, registerGuideRoutes } from "./routes/guide";
import { registerItineraryRoutes } from "./routes/itinerary";
import { registerPatrolRoutes } from "./routes/patrol";
import { type DeclaredRoute, SecureRoutes } from "./routes/policy";
import { registerTripRoutes } from "./routes/trips";
import { registerWebRoutes } from "./routes/web";
import { Consultations } from "./session/consultations";
import { StoragePersistence } from "./session/persistence";
import type { ItineraryStore, SessionStore } from "./session/sessionStore";
import type { Shiori } from "./shiori";
import { MemoryTripStorage } from "./storage/memory";
import type { TripStorage } from "./storage/types";

export interface AppDeps extends ChatOptions, FestivalSearchOptions {
  sessions: SessionStore;
  itineraries: ItineraryStore;
  festivals: FestivalStore;
  /** 公開している URL の合言葉。null なら確かめない */
  accessPasscode: string | null;
  /** 画面のビルドの場所。あれば同じオリジンから配る */
  webDist?: string | null;
  /** 旅程・共有・相談の途中の状態の保存先。省略するとメモリ */
  storage?: TripStorage;
  /** 保存の口につないだもの。省略すると storage から作る */
  persistence?: StoragePersistence;
  /** ログイン（Firebase の ID トークンの確認）。省略するとログインなし */
  verifier?: IdTokenVerifier | null;
  authConfig?: AuthConfig;
  /** 内部の入口の検証。設定のないものは、その入口だけが断る */
  internal?: InternalVerifiers;
  /** 旅のしおり（省略すると assets/shiori と Chromium を使うもの） */
  shiori?: Shiori;
  /** しおりのあとのガイド。省略すると、ガイドの入口だけが 404 で断る */
  guide?: GuideOptions;
  /** 旅の見回り。省略すると、見回りの入口だけが 404 で断る */
  patrol?: PatrolDeps | null;
}

/** API の本文の大きさの上限（発言は1000字まで） */
const API_BODY_LIMIT = 32 * 1024;

const declaredByApp = new WeakMap<Hono, readonly DeclaredRoute[]>();

/** このアプリの経路と、宣言した認可の決まりの一覧 */
export function declaredRoutes(app: Hono): readonly DeclaredRoute[] {
  return declaredByApp.get(app) ?? [];
}

export function createApp(appDeps: AppDeps) {
  const app = new Hono();
  const persistence =
    appDeps.persistence ??
    new StoragePersistence({
      storage: appDeps.storage ?? new MemoryTripStorage(),
      itineraries: appDeps.itineraries,
      sessions: appDeps.sessions,
    });
  const consultations = new Consultations({ sessions: appDeps.sessions, persistence });
  const deps = { ...appDeps, persistence, consultations };
  const routes = new SecureRoutes(app, {
    verifier: deps.verifier ?? null,
    persistence,
    consultations,
    ...(deps.internal === undefined ? {} : { internal: deps.internal }),
  });

  routes.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
  });

  // Cloud Run の既定の URL（run.app）では末尾が z のパスが外から届かないので、/health でも返す
  for (const path of ["/healthz", "/health"]) {
    routes.public("GET", path, (c) => c.json({ status: "ok" }));
  }

  const limitBody = bodyLimit({
    maxSize: API_BODY_LIMIT,
    onError: (c) => c.json(apiError("bad_request", "送った内容が大きすぎます。", false), 413),
  });
  routes.use("/api/*", limitBody);
  routes.use("/internal/*", limitBody);
  routes.use("/api/*", passcodeGuard(deps.accessPasscode));
  registerChatRoutes(routes, deps);
  registerFestivalSearchRoutes(routes, deps);
  registerFestivalRoutes(routes, deps);
  registerFestivalTripRoutes(routes, deps);
  registerItineraryRoutes(routes, deps);
  registerTripRoutes(routes, {
    persistence,
    authConfig: deps.authConfig ?? { enabled: false },
    consultations,
    itineraries: deps.itineraries,
    mode: deps.runner.mode,
  });
  registerGuideRoutes(routes, deps);
  registerPatrolRoutes(routes, deps.patrol ?? null);
  if (deps.webDist) {
    registerWebRoutes(routes, {
      webDist: deps.webDist,
      authDomain: deps.authConfig?.enabled ? deps.authConfig.authDomain : null,
    });
  }
  routes.seal();
  declaredByApp.set(app, routes.declared);

  app.onError((error, c) => {
    console.error(JSON.stringify({ kind: "unhandled", ...errorForLog(error) }));
    return c.json(apiError("internal", "サーバーでエラーが起きました。", true), 500);
  });

  return app;
}
