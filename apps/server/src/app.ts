import type { AuthConfig } from "@matsuri-ikoka/schema";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { IdTokenVerifier } from "./account/idToken";
import type { FestivalStore } from "./data/festivalStore";
import { type ChatDeps, registerChatRoutes } from "./routes/chat";
import { apiError } from "./routes/errors";
import { type FestivalSearchOptions, registerFestivalSearchRoutes } from "./routes/festivalSearch";
import { registerFestivalRoutes } from "./routes/festivals";
import { registerFestivalTripRoutes } from "./routes/festivalTrips";
import { passcodeGuard } from "./routes/guard";
import { registerItineraryRoutes } from "./routes/itinerary";
import { registerTripRoutes } from "./routes/trips";
import { registerWebRoutes } from "./routes/web";
import { StoragePersistence } from "./session/persistence";
import type { ItineraryStore } from "./session/sessionStore";
import { MemoryTripStorage } from "./storage/memory";
import type { TripStorage } from "./storage/types";

export interface AppDeps extends ChatDeps, FestivalSearchOptions {
  itineraries: ItineraryStore;
  festivals: FestivalStore;
  /** 公開している URL の合言葉。null なら確かめない */
  accessPasscode: string | null;
  /** 画面のビルドの場所。あれば同じオリジンから配る */
  webDist?: string | null;
  /** 旅程・共有・相談の途中の状態の保存先。省略するとメモリ */
  storage?: TripStorage;
  /** ログイン（Firebase の ID トークンの確認）。省略するとログインなし */
  verifier?: IdTokenVerifier | null;
  authConfig?: AuthConfig;
}

/** API の本文の大きさの上限（発言は1000字まで） */
const API_BODY_LIMIT = 32 * 1024;

export function createApp(appDeps: AppDeps) {
  const app = new Hono();
  const persistence =
    appDeps.persistence ??
    new StoragePersistence({
      storage: appDeps.storage ?? new MemoryTripStorage(),
      itineraries: appDeps.itineraries,
      sessions: appDeps.sessions,
    });
  const deps = { ...appDeps, persistence };

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
  });

  // Cloud Run の既定の URL（run.app）では末尾が z のパスが外から届かないので、/health でも返す
  for (const path of ["/healthz", "/health"]) app.get(path, (c) => c.json({ status: "ok" }));

  app.use(
    "/api/*",
    bodyLimit({
      maxSize: API_BODY_LIMIT,
      onError: (c) => c.json(apiError("bad_request", "送った内容が大きすぎます。", false), 413),
    }),
  );
  app.use("/api/*", passcodeGuard(deps.accessPasscode));
  registerChatRoutes(app, deps);
  registerFestivalSearchRoutes(app, deps);
  registerFestivalRoutes(app, deps);
  registerFestivalTripRoutes(app, deps);
  registerItineraryRoutes(app, deps);
  registerTripRoutes(app, {
    persistence,
    verifier: deps.verifier ?? null,
    authConfig: deps.authConfig ?? { enabled: false },
  });
  if (deps.webDist) {
    registerWebRoutes(app, {
      webDist: deps.webDist,
      authDomain: deps.authConfig?.enabled ? deps.authConfig.authDomain : null,
    });
  }

  app.onError((error, c) => {
    console.error("[app] unhandled", error);
    return c.json(apiError("internal", "サーバーでエラーが起きました。", true), 500);
  });

  return app;
}
