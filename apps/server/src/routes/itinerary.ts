import type { Hono } from "hono";
import type { FestivalStore } from "../data/festivalStore";
import type { ItineraryStore } from "../session/sessionStore";
import type { Shiori } from "../shiori";
import { apiError } from "./errors";
import { registerShioriRoutes } from "./shiori";

export interface ItineraryDeps {
  itineraries: ItineraryStore;
  festivals: FestivalStore;
  /** 旅のしおり（省略すると assets/shiori と Chromium を使うもの） */
  shiori?: Shiori;
}

export function registerItineraryRoutes(app: Hono, deps: ItineraryDeps) {
  app.get("/api/itinerary/:id", (c) => {
    const itinerary = deps.itineraries.get(c.req.param("id"));
    if (itinerary === undefined) {
      return c.json(apiError("bad_request", "旅程が見つかりません。", false), 404);
    }
    return c.json(itinerary);
  });

  registerShioriRoutes(app, deps);
}
