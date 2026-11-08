import type { FestivalStore } from "../data/festivalStore";
import type { StoragePersistence } from "../session/persistence";
import type { Shiori } from "../shiori";
import { apiError } from "./errors";
import { routeParam, type SecureRoutes } from "./policy";
import { registerShioriRoutes } from "./shiori";

export interface ItineraryDeps {
  /** 旅程は保存の口から読む（どのインスタンスに届いても、同じ旅程を返す） */
  persistence: StoragePersistence;
  festivals: FestivalStore;
  /** 旅のしおり（省略すると assets/shiori と Chromium を使うもの） */
  shiori?: Shiori;
}

// 旅程の読み取り。読めるのは、共有の ID、持ち主のない旅程の ID、ログインした持ち主自身の旅程の ID だけ。
// ほかの人の旅程は、ない旅程と同じ 404 にする。
// しおり（/shiori/:id）だけは、持ち主が付く前に渡した旅程の ID の URL で、付く前の版を出し続ける（routes/shiori.ts）。

export function registerItineraryRoutes(routes: SecureRoutes, deps: ItineraryDeps) {
  routes.public("GET", "/api/itinerary/:id", async (c, { viewer }) => {
    const owner = await viewer();
    // ログインした人には、その人の旅程を返すことがある。ブラウザや途中のキャッシュに残さない
    if (owner !== null) c.header("Cache-Control", "private, no-store");
    const itinerary = await deps.persistence.readItinerary(routeParam(c, "id"), owner);
    if (itinerary === undefined) {
      return c.json(apiError("bad_request", "旅程が見つかりません。", false), 404);
    }
    return c.json(itinerary);
  });

  registerShioriRoutes(routes, {
    ...deps,
    readItinerary: (id, viewer) => deps.persistence.readShioriItinerary(id, viewer),
  });
}
