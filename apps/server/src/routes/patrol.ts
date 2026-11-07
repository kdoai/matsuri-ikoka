import type { Context } from "hono";
import { z } from "zod";
import { errorForLog } from "../log";
import { claimDelivery, collectSession, type PatrolDeps, startPatrol } from "../patrol/runner";
import { apiError } from "./errors";
import type { SecureRoutes } from "./policy";

// 見回りの内部の入口（docs/spec/operations.md の「旅の見回り」）。
// どちらも検証（oidc・signature）を通ったものだけがここに届く。検証の設定がなければ、この入口だけが断る。
// 署名を確かめるまで、本文を読まず、保存も取得もしない（確かめるのは SecureRoutes.internal の中）。

export const PATROL_START_PATH = "/internal/patrol/start";
export const PATROL_WEBHOOK_PATH = "/internal/patrol/webhook";

/** Webhook の本文。中身は薄いので、種類とセッションの ID だけを読み、状態は取りに行く */
const WebhookEnvelopeSchema = z.object({
  type: z.literal("event"),
  id: z.string().min(1).max(200),
  data: z.object({
    type: z.string().min(1).max(100),
    id: z.string().min(1).max(200),
  }),
});

/** 結果を取りに行くきっかけになる通知 */
const SESSION_FINISHED_TYPES = new Set(["session.status_idled", "session.status_terminated"]);

const notConfigured = (c: Context) =>
  c.json(apiError("bad_request", "見つかりません。", false), 404);

/** deps が null なら、見回りを用意していない環境なので、この入口だけが断る */
export function registerPatrolRoutes(routes: SecureRoutes, deps: PatrolDeps | null): void {
  routes.internal("POST", PATROL_START_PATH, "oidc", async (c) => {
    if (deps === null) return notConfigured(c);
    try {
      return c.json(await startPatrol(deps));
    } catch (error) {
      console.error(JSON.stringify({ kind: "patrol_tick_failed", ...errorForLog(error) }));
      return c.json(apiError("internal", "見回りを始められませんでした。", true), 500);
    }
  });

  routes.internal("POST", PATROL_WEBHOOK_PATH, "signature", async (c, caller) => {
    if (deps === null) return notConfigured(c);
    let body: unknown;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      return c.json(apiError("bad_request", "本文を読めませんでした。", false), 400);
    }
    const envelope = WebhookEnvelopeSchema.safeParse(body);
    // 本文の ID と署名した配信の ID が違えば、同じ通知の重複を見分けられない
    if (!envelope.success || envelope.data.id !== caller.id) {
      return c.json(apiError("bad_request", "本文の形が正しくありません。", false), 400);
    }
    if (!SESSION_FINISHED_TYPES.has(envelope.data.data.type)) return c.body(null, 204);

    if ((await claimDelivery(deps, caller.id)) === "duplicate") return c.body(null, 204);
    try {
      await collectSession(deps, envelope.data.data.id);
      await deps.store.finishDelivery(caller.id);
      return c.body(null, 204);
    } catch (error) {
      // 放しておけば、再送で受け取り直せる。再送も届かなければ定期の起動で確かめる
      console.error(JSON.stringify({ kind: "patrol_webhook_failed", ...errorForLog(error) }));
      await deps.store.releaseDelivery(caller.id);
      return c.json(apiError("internal", "結果を受け取れませんでした。", true), 500);
    }
  });
}
