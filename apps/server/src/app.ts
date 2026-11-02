import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { FestivalStore } from "./data/festivalStore";
import { type ChatDeps, registerChatRoutes } from "./routes/chat";
import { apiError } from "./routes/errors";
import { registerFestivalRoutes } from "./routes/festivals";
import { passcodeGuard } from "./routes/guard";
import { registerItineraryRoutes } from "./routes/itinerary";
import type { ItineraryStore } from "./session/sessionStore";

export interface AppDeps extends ChatDeps {
  itineraries: ItineraryStore;
  festivals: FestivalStore;
  /** 公開している URL の合言葉。null なら確かめない */
  accessPasscode: string | null;
}

/** API の本文の大きさの上限（発言は1000字まで） */
const API_BODY_LIMIT = 32 * 1024;

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
  });

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  app.use(
    "/api/*",
    bodyLimit({
      maxSize: API_BODY_LIMIT,
      onError: (c) => c.json(apiError("bad_request", "送った内容が大きすぎます。", false), 413),
    }),
  );
  app.use("/api/*", passcodeGuard(deps.accessPasscode));
  registerChatRoutes(app, deps);
  registerFestivalRoutes(app, deps);
  registerItineraryRoutes(app, deps);

  app.onError((error, c) => {
    console.error("[app] unhandled", error);
    return c.json(apiError("internal", "サーバーでエラーが起きました。", true), 500);
  });

  return app;
}
