import {
  type AuthConfig,
  type DeleteTripsResponse,
  isTrialAccount,
  SaveTripRequestSchema,
  type ShareResponse,
  type TripListResponse,
  type TripResponse,
  type TripSummary,
} from "@matsuri-ikoka/schema";
import type { Context } from "hono";
import { parseStoredItinerary, type StoragePersistence } from "../session/persistence";
import type { StoredTrip, StoredTripDetail } from "../storage/types";
import { apiError } from "./errors";
import { routeParam, type SecureRoutes } from "./policy";

// ログインと自分の旅の API（docs/spec/account.md）。
// 相談はログインなしで始められる。旅を残す・あとで開く・一覧する・共有する・消すのは、ログインしてから。
// 読み書きは、決まり（routes/policy.ts）が渡す、その人に絞った保存の口だけで行う。

export interface TripDeps {
  persistence: StoragePersistence;
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

/** 自分の旅でなければ、あるかどうかも見せない */
const notFound = (c: Context) =>
  c.json(apiError("bad_request", "旅が見つかりません。", false), 404);

export function registerTripRoutes(routes: SecureRoutes, deps: TripDeps) {
  routes.public("GET", "/api/auth/config", (c) => c.json(deps.authConfig));

  routes.owner("GET", "/api/trips", async (c, { trips }) => {
    const list = await trips.listTrips();
    return c.json({ trips: list.map(summaryOf) } satisfies TripListResponse);
  });

  // 相談の旅程を、自分の旅として残す。旅程の ID ではなく相談の ID で指す
  routes.owner("POST", "/api/trips", async (c, { trips, open }) => {
    const parsed = SaveTripRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json(apiError("bad_request", "送った内容の形が正しくありません。", false), 400);
    }
    const session = await open(parsed.data.sessionId);
    if (session === undefined) {
      return c.json(apiError("bad_request", "相談が見つかりません。", false), 404);
    }
    if (session.itineraryId === null) {
      return c.json(apiError("bad_request", "まだ旅程がありません。", false), 409);
    }
    await deps.persistence.flush(session.itineraryId);
    const result = await trips.claimTrip(session.itineraryId);
    if (result.status === "not_found") return notFound(c);
    return c.json(summaryOf(result.trip), 201);
  });

  routes.owner("GET", "/api/trips/:id", async (c, { trips }) => {
    const id = routeParam(c, "id");
    await deps.persistence.flush(id);
    const detail = await trips.getTrip(id);
    return detail === null ? notFound(c) : c.json(tripResponse(detail));
  });

  routes.owner("GET", "/api/trips/:id/versions/:version{[0-9]{1,6}}", async (c, { trips }) => {
    const id = routeParam(c, "id");
    await deps.persistence.flush(id);
    const detail = await trips.getTrip(id, Number(routeParam(c, "version")));
    return detail === null ? notFound(c) : c.json(tripResponse(detail));
  });

  routes.owner("POST", "/api/trips/:id/share", async (c, { trips }) => {
    const id = routeParam(c, "id");
    // 返事を作り終えた直後でも、いちばん新しい版を共有する
    await deps.persistence.flush(id);
    const share = await trips.createShare(id);
    if (share === null) return notFound(c);
    return c.json(
      {
        shareId: share.shareId,
        path: `/shiori/${share.shareId}`,
        expiresAt: new Date(share.expiresAt).toISOString(),
      } satisfies ShareResponse,
      201,
    );
  });

  // 旅を、すべての版と共有ごと消す
  routes.owner("DELETE", "/api/trips/:id", async (c, { trips }) => {
    const id = routeParam(c, "id");
    await deps.persistence.flush(id);
    const deleted = await trips.deleteTrip(id);
    if (!deleted) return notFound(c);
    // 消した旅を、次の発言で作り直さない
    await deps.persistence.forgetTrip(id);
    return c.body(null, 204);
  });

  routes.owner("DELETE", "/api/me/trips", async (c, { owner, trips }) => {
    // お試し用のアカウントは何人かで使うので、ひとりの操作で空にしない（戻すのは初期化のスクリプト）
    if (isTrialAccount(owner)) {
      return c.json(apiError("bad_request", "お試し用のアカウントは消せません。", false), 403);
    }
    await deps.persistence.flush();
    deps.persistence.forgetOwner(owner);
    const deleted = await trips.deleteAllTrips();
    return c.json({ deleted } satisfies DeleteTripsResponse);
  });
}
