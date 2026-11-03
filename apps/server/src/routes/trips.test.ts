import {
  AuthConfigSchema,
  ShareResponseSchema,
  TripListResponseSchema,
  TripResponseSchema,
  TripSummarySchema,
} from "@matsuri-ikoka/schema";
import { fictionalItinerary } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import type { IdTokenVerifier } from "../account/idToken";
import type { AgentRunner } from "../agent/runner";
import { createApp } from "../app";
import { createFestivalStore } from "../data/festivalStore";
import { ItineraryStore, SessionStore } from "../session/sessionStore";
import { MemoryTripStorage } from "../storage/memory";
import { DailyLimiter } from "./guard";

/** 「token-<利用者>」だけを通す、ネットワークに出ない ID トークンの確認 */
const fakeVerifier: IdTokenVerifier = {
  async verify(token) {
    const uid = token.startsWith("token-") ? token.slice("token-".length) : "";
    return uid === "" ? null : uid;
  },
};

/** 返事を作らない接客（このテストでは相談の中身を使わない） */
const runner: AgentRunner = { mode: "mock", runTurn: async () => {} };

function setup(options: { login?: boolean } = {}) {
  const itineraries = new ItineraryStore();
  const sessions = new SessionStore();
  const storage = new MemoryTripStorage();
  const app = createApp({
    runner,
    sessions,
    itineraries,
    festivals: createFestivalStore([]),
    limiter: new DailyLimiter(null, () => "2026-08-03"),
    accessPasscode: null,
    storage,
    verifier: options.login === false ? null : fakeVerifier,
    authConfig:
      options.login === false
        ? { enabled: false }
        : { enabled: true, apiKey: "public-key", authDomain: "example.com", projectId: "demo" },
  });
  const call = (path: string, init: { method?: string; user?: string; body?: unknown } = {}) =>
    app.request(path, {
      method: init.method ?? "GET",
      headers: {
        "content-type": "application/json",
        ...(init.user === undefined ? {} : { authorization: `Bearer token-${init.user}` }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  /** 旅程のある相談を作る */
  const sessionWithItinerary = () => {
    const session = sessions.create();
    const itinerary = { ...fictionalItinerary(), id: `it-${session.id}` };
    itineraries.save(itinerary);
    session.itineraryId = itinerary.id;
    return { session, itinerary };
  };
  return { app, call, sessions, sessionWithItinerary };
}

describe("ログインと自分の旅の API", () => {
  it("ログインの公開の設定を返す", async () => {
    const { call } = setup();
    const config = AuthConfigSchema.parse(await (await call("/api/auth/config")).json());
    expect(config.enabled).toBe(true);
    const off = setup({ login: false });
    expect(await (await off.call("/api/auth/config")).json()).toEqual({ enabled: false });
  });

  it("ログインしていなければ 401、ログインを用意していなければ 404", async () => {
    const { call } = setup();
    expect((await call("/api/trips")).status).toBe(401);
    expect((await call("/api/trips", { user: "" })).status).toBe(401);
    const off = setup({ login: false });
    expect((await off.call("/api/trips", { user: "alice" })).status).toBe(404);
  });

  it("相談の旅程を自分の旅として残し、一覧から開ける", async () => {
    const { call, sessionWithItinerary } = setup();
    const { session, itinerary } = sessionWithItinerary();

    const saved = await call("/api/trips", {
      method: "POST",
      user: "alice",
      body: { sessionId: session.id },
    });
    const list = TripListResponseSchema.parse(
      await (await call("/api/trips", { user: "alice" })).json(),
    );
    const opened = await call(`/api/trips/${itinerary.id}`, { user: "alice" });

    expect(saved.status).toBe(201);
    expect(TripSummarySchema.parse(await saved.json()).itineraryId).toBe(itinerary.id);
    expect(list.trips.map((trip) => trip.title)).toEqual([itinerary.title]);
    expect(opened.headers.get("cache-control")).toBe("private, no-store");
    const body = TripResponseSchema.parse(await opened.json());
    expect(body.itinerary).toEqual(itinerary);
    expect(body.versions).toEqual([itinerary.version]);
    // ほかの人の一覧には出ない
    const others = await (await call("/api/trips", { user: "bob" })).json();
    expect(others).toEqual({ trips: [] });
    expect((await call(`/api/trips/${itinerary.id}`, { user: "bob" })).status).toBe(404);
  });

  it("旅程のない相談・ない相談・形の違う本文は残せない", async () => {
    const { call, sessions } = setup();
    const empty = sessions.create();
    const post = (body: unknown) => call("/api/trips", { method: "POST", user: "alice", body });

    expect((await post({ sessionId: empty.id })).status).toBe(409);
    expect((await post({ sessionId: "s-none" })).status).toBe(404);
    expect((await post({ itineraryId: "it-1" })).status).toBe(400);
  });

  it("ほかの人が残した旅は、同じ相談からでも残せない", async () => {
    const { call, sessionWithItinerary } = setup();
    const { session } = sessionWithItinerary();
    const post = (user: string) =>
      call("/api/trips", { method: "POST", user, body: { sessionId: session.id } });

    expect((await post("alice")).status).toBe(201);
    expect((await post("bob")).status).toBe(403);
  });

  it("共有の ID でしおりの旅程を読める", async () => {
    const { call, sessionWithItinerary } = setup();
    const { session, itinerary } = sessionWithItinerary();
    await call("/api/trips", { method: "POST", user: "alice", body: { sessionId: session.id } });

    const res = await call(`/api/trips/${itinerary.id}/share`, { method: "POST", user: "alice" });
    const share = ShareResponseSchema.parse(await res.json());

    expect(res.status).toBe(201);
    expect(share.path).toBe(`/shiori/${share.shareId}`);
    expect(await (await call(`/api/itinerary/${share.shareId}`)).json()).toEqual(itinerary);
    const notMine = await call(`/api/trips/${itinerary.id}/share`, { method: "POST", user: "bob" });
    expect(notMine.status).toBe(404);
  });

  it("旅を消すと、一覧・共有・旅程の URL から消える", async () => {
    const { call, sessionWithItinerary } = setup();
    const { session, itinerary } = sessionWithItinerary();
    await call("/api/trips", { method: "POST", user: "alice", body: { sessionId: session.id } });
    const share = ShareResponseSchema.parse(
      await (
        await call(`/api/trips/${itinerary.id}/share`, { method: "POST", user: "alice" })
      ).json(),
    );

    expect(
      (await call(`/api/trips/${itinerary.id}`, { method: "DELETE", user: "bob" })).status,
    ).toBe(404);
    const deleted = await call(`/api/trips/${itinerary.id}`, { method: "DELETE", user: "alice" });

    expect(deleted.status).toBe(204);
    expect(await (await call("/api/trips", { user: "alice" })).json()).toEqual({ trips: [] });
    expect((await call(`/api/itinerary/${share.shareId}`)).status).toBe(404);
    expect((await call(`/api/itinerary/${itinerary.id}`)).status).toBe(404);
  });

  it("自分の旅をすべて消せる", async () => {
    const { call, sessionWithItinerary } = setup();
    for (let i = 0; i < 2; i += 1) {
      const { session } = sessionWithItinerary();
      await call("/api/trips", { method: "POST", user: "alice", body: { sessionId: session.id } });
    }

    const res = await call("/api/me/trips", { method: "DELETE", user: "alice" });

    expect(await res.json()).toEqual({ deleted: 2 });
    expect(await (await call("/api/trips", { user: "alice" })).json()).toEqual({ trips: [] });
  });

  it("前の版も開ける", async () => {
    const { call, sessionWithItinerary, sessions } = setup();
    const { session, itinerary } = sessionWithItinerary();
    await call("/api/trips", { method: "POST", user: "alice", body: { sessionId: session.id } });
    expect(sessions.get(session.id)).toBeDefined();

    const res = await call(`/api/trips/${itinerary.id}/versions/${itinerary.version}`, {
      user: "alice",
    });
    const missing = await call(`/api/trips/${itinerary.id}/versions/99`, { user: "alice" });

    expect(TripResponseSchema.parse(await res.json()).itinerary?.version).toBe(itinerary.version);
    expect(missing.status).toBe(404);
  });
});
