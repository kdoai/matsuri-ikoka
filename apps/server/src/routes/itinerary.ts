import type { Hono } from "hono";
import type { FestivalStore } from "../data/festivalStore";
import { hasOfficialSource } from "../domain/verification";
import type { ItineraryStore } from "../session/sessionStore";
import { apiError } from "./errors";
import { renderShiori, renderShioriNotice, SHIORI_CSP } from "./shiori";

export interface ItineraryDeps {
  itineraries: ItineraryStore;
  festivals: FestivalStore;
}

export function registerItineraryRoutes(app: Hono, deps: ItineraryDeps) {
  app.get("/api/itinerary/:id", (c) => {
    const itinerary = deps.itineraries.get(c.req.param("id"));
    if (itinerary === undefined) {
      return c.json(apiError("bad_request", "旅程が見つかりません。", false), 404);
    }
    return c.json(itinerary);
  });

  // しおりは URL で共有するので、合言葉はいらない（ID は推測されにくい乱数）
  app.get("/shiori/:id", async (c) => {
    c.header("Content-Security-Policy", SHIORI_CSP);
    c.header("Referrer-Policy", "no-referrer");
    const itinerary = deps.itineraries.get(c.req.param("id"));
    if (itinerary === undefined) {
      return c.html(renderShioriNotice("しおりが見つかりません", "URL を確かめてください。"), 404);
    }
    // 公式の情報で開催予定を確かめられた旅程だけを、しおりとして出す
    const { verification } = itinerary;
    if (verification.status !== "as_planned" || !hasOfficialSource(verification.sources)) {
      return c.html(
        renderShioriNotice(
          "まだ確定していない旅程です",
          "開催予定を公式の情報で確かめてから、しおりをお渡しします。",
        ),
        409,
      );
    }
    return c.html(renderShiori(itinerary, deps.festivals.get(itinerary.mainFestivalId)));
  });
}
