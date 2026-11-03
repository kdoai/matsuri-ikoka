import type { Hono } from "hono";
import type { FestivalStore } from "../data/festivalStore";
import type { StoragePersistence } from "../session/persistence";
import type { Shiori } from "../shiori";
import { apiError } from "./errors";
import { registerShioriRoutes } from "./shiori";

export interface ItineraryDeps {
  /** 旅程は保存の口から読む（どのインスタンスに届いても、同じ旅程を返す） */
  persistence: StoragePersistence;
  festivals: FestivalStore;
  /** 旅のしおり（省略すると assets/shiori と Chromium を使うもの） */
  shiori?: Shiori;
}

export function registerItineraryRoutes(app: Hono, deps: ItineraryDeps) {
  const readItinerary = (id: string) => deps.persistence.readShared(id);

  app.get("/api/itinerary/:id", async (c) => {
    const itinerary = await readItinerary(c.req.param("id"));
    if (itinerary === undefined) {
      return c.json(apiError("bad_request", "旅程が見つかりません。", false), 404);
    }
    return c.json(itinerary);
  });

  registerShioriRoutes(app, { ...deps, readItinerary });
}
