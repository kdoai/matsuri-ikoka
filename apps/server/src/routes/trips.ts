import {
  type AuthConfig,
  type DeleteTripsResponse,
  SaveTripRequestSchema,
  type ShareResponse,
  type TripListResponse,
  type TripResponse,
  type TripSummary,
} from "@matsuri-ikoka/schema";
import type { Context, Hono } from "hono";
import { type IdTokenVerifier, requestUid } from "../account/idToken";
import { parseStoredItinerary, type StoragePersistence } from "../session/persistence";
import type { StoredTrip, StoredTripDetail } from "../storage/types";
import { apiError } from "./errors";

// ログインと自分の旅の API（docs/spec/account.md）。
// 相談はログインなしで始められる。旅を残す・あとで開く・一覧する・共有する・消すのは、ログインしてから。
// 利用者は、Authorization: Bearer の Firebase の ID トークンをサーバーで確かめて決める。

export interface TripDeps {
  persistence: StoragePersistence;
  /** ログインを用意していなければ null（旅の API は 404 で断る） */
  verifier: IdTokenVerifier | null;
  /** 画面に渡すログインの公開の設定 */
  authConfig: AuthConfig;
}

function summaryOf(trip: StoredTrip): TripSummary {
  return {
    itineraryId: trip.itineraryId,
    title: trip.title,
    date: trip.date,
    version: trip.version,
    updatedAt: new Date(trip.updatedAt).toISOString(),
  };
}

function tripResponse(detail: StoredTripDetail): TripResponse {
  return {
    trip: summaryOf(detail.trip),
    versions: detail.versions,
    itinerary: parseStoredItinerary(detail.itinerary) ?? null,
  };
}

/** 経路の値（ハンドラを包むと、Hono の型からは経路の名前が分からなくなるので、ここで文字列にする） */
const param = (c: Context, name: string): string => c.req.param(name) ?? "";

const notFound = (c: Context) =>
  c.json(apiError("bad_request", "旅が見つかりません。", false), 404);

export function registerTripRoutes(app: Hono, deps: TripDeps) {
  const storage = deps.persistence.storage;

  app.get("/api/auth/config", (c) => c.json(deps.authConfig));

  // ここから下はログインが要る。利用者の ID を c.var に置かず、各経路で確かめた値を使う
  const withUser =
    (handler: (c: Context, uid: string) => Promise<Response>) =>
    async (c: Context): Promise<Response> => {
      if (deps.verifier === null) {
        return c.json(apiError("bad_request", "ログインは用意していません。", false), 404);
      }
      const uid = await requestUid(c, deps.verifier);
      if (uid === null) {
        return c.json(apiError("unauthorized", "ログインしてください。", false), 401);
      }
      c.header("Cache-Control", "private, no-store");
      return handler(c, uid);
    };

  app.get(
    "/api/trips",
    withUser(async (c, uid) => {
      const trips = await storage.listTrips(uid);
      return c.json({ trips: trips.map(summaryOf) } satisfies TripListResponse);
    }),
  );

  // 相談の旅程を、自分の旅として残す。旅程の ID ではなく相談の ID で指す
  app.post(
    "/api/trips",
    withUser(async (c, uid) => {
      const parsed = SaveTripRequestSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!parsed.success) {
        return c.json(apiError("bad_request", "送った内容の形が正しくありません。", false), 400);
      }
      const session = await deps.persistence.load(parsed.data.sessionId);
      if (session === undefined) {
        return c.json(apiError("bad_request", "相談が見つかりません。", false), 404);
      }
      if (session.itineraryId === null) {
        return c.json(apiError("bad_request", "まだ旅程がありません。", false), 409);
      }
      await deps.persistence.flush(session.itineraryId);
      const result = await storage.claimTrip(uid, session.itineraryId);
      if (result.status === "not_found") return notFound(c);
      if (result.status === "forbidden") {
        return c.json(apiError("unauthorized", "この旅はほかの方が残しています。", false), 403);
      }
      return c.json(summaryOf(result.trip), 201);
    }),
  );

  app.get(
    "/api/trips/:id",
    withUser(async (c, uid) => {
      const detail = await storage.getTrip(uid, param(c, "id"));
      return detail === null ? notFound(c) : c.json(tripResponse(detail));
    }),
  );

  app.get(
    "/api/trips/:id/versions/:version{[0-9]{1,6}}",
    withUser(async (c, uid) => {
      const detail = await storage.getTrip(uid, param(c, "id"), Number(param(c, "version")));
      return detail === null ? notFound(c) : c.json(tripResponse(detail));
    }),
  );

  app.post(
    "/api/trips/:id/share",
    withUser(async (c, uid) => {
      const share = await storage.createShare(uid, param(c, "id"));
      if (share === null) return notFound(c);
      return c.json(
        {
          shareId: share.shareId,
          path: `/shiori/${share.shareId}`,
          expiresAt: new Date(share.expiresAt).toISOString(),
        } satisfies ShareResponse,
        201,
      );
    }),
  );

  // 旅を、すべての版と共有ごと消す
  app.delete(
    "/api/trips/:id",
    withUser(async (c, uid) => {
      const deleted = await storage.deleteTrip(uid, param(c, "id"));
      return deleted ? c.body(null, 204) : notFound(c);
    }),
  );

  app.delete(
    "/api/me/trips",
    withUser(async (c, uid) => {
      const deleted = await storage.deleteAllTrips(uid);
      return c.json({ deleted } satisfies DeleteTripsResponse);
    }),
  );
}
