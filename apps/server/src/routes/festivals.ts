import { type Festival, type FestivalsResponse, SlugSchema } from "@matsuri-ikoka/schema";
import type { Hono } from "hono";
import type { FestivalStore } from "../data/festivalStore";
import { apiError } from "./errors";

// 祭りのデータ。しおりの作法・地元の味・アクセスや、待ち時間の小話を画面が読む。
// 掲載停止の祭りは祭りのデータの読み込みで外してあるので、一覧にも出ず、1件でも 404 になる。

export function registerFestivalRoutes(app: Hono, deps: { festivals: FestivalStore }) {
  // 候補が出る前に、画面の豆知識係が読む
  app.get("/api/festivals", (c) =>
    c.json({
      festivals: deps.festivals.list().filter((festival) => !festival.optOut),
    } satisfies FestivalsResponse),
  );

  app.get("/api/festivals/:id", (c) => {
    const id = SlugSchema.safeParse(c.req.param("id"));
    const festival = id.success ? deps.festivals.get(id.data) : undefined;
    if (festival === undefined || festival.optOut) {
      return c.json(apiError("bad_request", "祭りが見つかりません。", false), 404);
    }
    return c.json(festival satisfies Festival);
  });
}
