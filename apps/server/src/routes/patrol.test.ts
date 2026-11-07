import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInternalVerifiers,
  createSignatureVerifier,
  type InternalVerifiers,
} from "../account/internalAuth";
import { type AppDeps, createApp } from "../app";
import { createFestivalStore } from "../data/festivalStore";
import {
  PAGE_URL,
  type PatrolHarness,
  pageLinesFor,
  patrolHarness,
  watchedTrip,
} from "../patrol/testing";
import type { Consultations } from "../session/consultations";
import type { StoragePersistence } from "../session/persistence";
import { ItineraryStore, SessionStore } from "../session/sessionStore";
import { DailyLimiter } from "./guard";
import { PATROL_START_PATH, PATROL_WEBHOOK_PATH, registerPatrolRoutes } from "./patrol";
import { SecureRoutes } from "./policy";

// 見回りの内部の入口。確かめられない呼び出しは、処理を始める前に断る。
// 鍵と値はテストのためだけのもの。ネットワークには出ない。

const KEY = Buffer.from("テストのための署名の鍵");
const SIGNING_KEY = `whsec_${KEY.toString("base64")}`;

const signedHeaders = (id: string, body: string, nowMs: number) => {
  const timestamp = String(Math.floor(nowMs / 1000));
  return {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${createHmac("sha256", KEY)
      .update(`${id}.${timestamp}.${body}`)
      .digest("base64")}`,
  };
};

const envelope = (id: string, type: string, sessionId: string) =>
  JSON.stringify({
    type: "event",
    id,
    created_at: "2026-08-10T06:05:00Z",
    data: {
      type,
      id: sessionId,
      organization_id: "00000000-0000-0000-0000-000000000000",
      workspace_id: "00000000-0000-0000-0000-000000000000",
    },
  });

let harness: PatrolHarness;

const app = (options: { internal?: InternalVerifiers; deps?: "none" | "ready" } = {}): Hono => {
  const raw = new Hono();
  const routes = new SecureRoutes(raw, {
    verifier: null,
    persistence: {} as StoragePersistence,
    consultations: {} as Consultations,
    internal: options.internal ?? {
      oidc: {
        verify: async (c) =>
          c.req.header("authorization") === "Bearer ok"
            ? { kind: "oidc", id: "scheduler@example.com" }
            : null,
      },
      signature: createSignatureVerifier(SIGNING_KEY, { now: () => harness.clock.now }),
    },
  });
  registerPatrolRoutes(routes, options.deps === "none" ? null : harness.deps);
  routes.seal();
  return raw;
};

const start = (server: Hono, headers: Record<string, string> = { authorization: "Bearer ok" }) =>
  server.request(PATROL_START_PATH, { method: "POST", headers });

const webhook = (server: Hono, body: string, headers: Record<string, string>) =>
  server.request(PATROL_WEBHOOK_PATH, { method: "POST", body, headers });

const deliver = (server: Hono, id: string, type: string, sessionId: string) => {
  const body = envelope(id, type, sessionId);
  return webhook(server, body, signedHeaders(id, body, harness.clock.now));
};

/** ページの変化を見つけて、見回り係のセッションを始めたところまで進める */
async function startedSession(server: Hono) {
  const { trip, itinerary } = watchedTrip("a");
  harness.store.putWatchedTrip(trip, itinerary);
  harness.pages.script.set(PAGE_URL, { status: "ok", lines: pageLinesFor() });
  await start(server);
  harness.clock.now += 7 * 60 * 60 * 1000;
  harness.pages.script.set(PAGE_URL, {
    status: "ok",
    lines: pageLinesFor("荒天のため 8月23日に順延します"),
  });
  await start(server);
  harness.agent.respond = (request) => ({
    state: "finished",
    patrolId: request.patrolId,
    text: JSON.stringify({
      patrolId: request.patrolId,
      findings: request.targets.map((target) => ({
        festivalId: target.festivalId,
        date: target.date,
        result: "changed",
        observed: { date: "2026-08-23", start: null, end: null },
        topics: [],
        dateText: "8月23日に順延します",
        pages: [PAGE_URL],
      })),
    }),
    fetchedUrls: [PAGE_URL],
    costCents: 25,
  });
  return trip;
}

beforeEach(() => {
  harness = patrolHarness();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /internal/patrol/start", () => {
  it("OIDC のない起動を断り、何も読まない", async () => {
    const list = vi.spyOn(harness.store, "listWatchedTrips");

    const response = await start(app(), {});

    expect(response.status).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });

  it("検証の設定がなければ、この入口だけが断る", async () => {
    const server = app({
      internal: createInternalVerifiers({ oidc: null, webhookSigningKey: null }),
    });

    expect((await start(server)).status).toBe(404);
  });

  it("見回りの設定がなければ、確かめたあとでも断る", async () => {
    expect((await start(app({ deps: "none" }))).status).toBe(404);
  });

  it("確かめられた起動で、受け付けた対象の数を返す", async () => {
    const { trip, itinerary } = watchedTrip("a");
    harness.store.putWatchedTrip(trip, itinerary);
    harness.pages.script.set(PAGE_URL, { status: "ok", lines: pageLinesFor() });

    const response = await start(app());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      targets: 1,
      sentToAgent: 0,
      skipped: 0,
      lodgingNotices: 0,
      reconciled: 0,
      guideCalls: 0,
    });
  });

  it("保存先の失敗は 500 で返し、再送できる", async () => {
    vi.spyOn(harness.store, "listOpenRuns").mockRejectedValue(new Error("保存先に届きません"));

    const response = await start(app());

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "internal", retryable: true });
  });
});

describe("POST /internal/patrol/webhook", () => {
  const body = () => envelope("whe_1", "session.status_idled", "session-1");

  it("署名のない配信を断り、本文を処理しない", async () => {
    const read = vi.spyOn(harness.agent, "read");
    const claim = vi.spyOn(harness.store, "claimDelivery");

    const response = await webhook(app(), body(), {});

    expect(response.status).toBe(401);
    expect(read).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it("署名の違う配信を断り、取得も保存もしない", async () => {
    const read = vi.spyOn(harness.agent, "read");
    const claim = vi.spyOn(harness.store, "claimDelivery");
    const headers = {
      ...signedHeaders("whe_1", body(), harness.clock.now),
      "webhook-signature": "v1,AAAA",
    };

    const response = await webhook(app(), body(), headers);

    expect(response.status).toBe(401);
    expect(read).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it("本文を書き換えた配信を断る", async () => {
    const headers = signedHeaders("whe_1", body(), harness.clock.now);

    const response = await webhook(app(), `${body()} `, headers);

    expect(response.status).toBe(401);
  });

  it("署名の鍵が設定されていなければ受け付けない", async () => {
    const server = app({
      internal: createInternalVerifiers({ oidc: null, webhookSigningKey: null }),
    });
    const headers = signedHeaders("whe_1", body(), harness.clock.now);

    expect((await webhook(server, body(), headers)).status).toBe(404);
  });

  it("空の署名の鍵でも受け付けない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const server = app({
      internal: createInternalVerifiers({ oidc: null, webhookSigningKey: "whsec_" }),
    });
    const headers = signedHeaders("whe_1", body(), harness.clock.now);

    expect((await webhook(server, body(), headers)).status).toBe(404);
    warn.mockRestore();
  });

  it("薄い通知を受けて結果を取りに行き、通知の候補を作り、セッションを消す", async () => {
    const server = app();
    const trip = await startedSession(server);

    const response = await deliver(server, "whe_1", "session.status_idled", "session-1");

    expect(response.status).toBe(204);
    expect(harness.store.noticesOf(trip.ref)).toHaveLength(1);
    expect(harness.agent.disposed).toEqual(["session-1"]);
  });

  it("同じ通知が2回届いても、結果を取りに行くのは1回", async () => {
    const server = app();
    const trip = await startedSession(server);
    const read = vi.spyOn(harness.agent, "read");

    await deliver(server, "whe_1", "session.status_idled", "session-1");
    const again = await deliver(server, "whe_1", "session.status_idled", "session-1");

    expect(again.status).toBe(204);
    expect(read).toHaveBeenCalledTimes(1);
    expect(harness.store.noticesOf(trip.ref)).toHaveLength(1);
  });

  it("別の通知で同じセッションが届いても、通知は増えない", async () => {
    const server = app();
    const trip = await startedSession(server);

    await deliver(server, "whe_1", "session.status_idled", "session-1");
    await deliver(server, "whe_2", "session.status_terminated", "session-1");

    expect(harness.store.noticesOf(trip.ref)).toHaveLength(1);
  });

  it("関係のない種類の通知は、受け取るだけで何もしない", async () => {
    const read = vi.spyOn(harness.agent, "read");
    const claim = vi.spyOn(harness.store, "claimDelivery");

    const response = await deliver(app(), "whe_9", "session.status_run_started", "session-1");

    expect(response.status).toBe(204);
    expect(read).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it("見回りでないセッションの通知は無視する", async () => {
    const response = await deliver(app(), "whe_8", "session.status_idled", "session-99");

    expect(response.status).toBe(204);
  });

  it("読めない本文は断る", async () => {
    const text = "読めない本文";

    const response = await webhook(app(), text, signedHeaders("whe_1", text, harness.clock.now));

    expect(response.status).toBe(400);
  });

  it("本文の ID と署名した配信の ID が違えば断る", async () => {
    const text = envelope("whe_other", "session.status_idled", "session-1");

    const response = await webhook(app(), text, signedHeaders("whe_1", text, harness.clock.now));

    expect(response.status).toBe(400);
  });

  it("結果を取りに行けなければ 500 を返し、再送で受け取り直す", async () => {
    const server = app();
    const trip = await startedSession(server);
    const read = vi
      .spyOn(harness.agent, "read")
      .mockRejectedValueOnce(new Error("混み合っています"));

    const failed = await deliver(server, "whe_1", "session.status_idled", "session-1");
    expect(failed.status).toBe(500);
    expect(harness.store.noticesOf(trip.ref)).toEqual([]);

    const retried = await deliver(server, "whe_1", "session.status_idled", "session-1");

    expect(retried.status).toBe(204);
    expect(read).toHaveBeenCalledTimes(2);
    expect(harness.store.noticesOf(trip.ref)).toHaveLength(1);
  });

  it("見回りの設定がなければ、確かめたあとでも断る", async () => {
    const response = await deliver(app({ deps: "none" }), "whe_1", "session.status_idled", "s");

    expect(response.status).toBe(404);
  });
});

describe("経路の宣言", () => {
  it("どちらも内部の決まりで宣言する", () => {
    const raw = new Hono();
    harness = patrolHarness();
    const routes = new SecureRoutes(raw, {
      verifier: null,
      persistence: {} as StoragePersistence,
      consultations: {} as Consultations,
    });

    registerPatrolRoutes(routes, null);

    expect(routes.declared).toEqual([
      { method: "POST", path: PATROL_START_PATH, policy: "internal" },
      { method: "POST", path: PATROL_WEBHOOK_PATH, policy: "internal" },
    ]);
  });
});

describe("配線したアプリ", () => {
  const wired = (over: Partial<AppDeps> = {}) =>
    createApp({
      runner: { mode: "mock", sampleFor: () => "fictional-sample", runTurn: async () => {} },
      sessions: new SessionStore(),
      itineraries: new ItineraryStore(),
      festivals: createFestivalStore([]),
      limiter: new DailyLimiter(null, () => "2026-08-03"),
      accessPasscode: null,
      ...over,
    });
  const oidcOk: InternalVerifiers = {
    oidc: {
      verify: async (c) =>
        c.req.header("authorization") === "Bearer ok"
          ? { kind: "oidc", id: "scheduler@example.com" }
          : null,
    },
  };
  const post = (server: Hono, path: string, headers: Record<string, string> = {}) =>
    server.request(path, { method: "POST", headers });

  it("設定がなければ、見回りの入口だけが断り、相談はそのまま動く", async () => {
    const server = wired();

    expect((await post(server, PATROL_START_PATH)).status).toBe(404);
    expect((await post(server, PATROL_WEBHOOK_PATH)).status).toBe(404);
    expect((await server.request("/healthz")).status).toBe(200);
    expect((await post(server, "/api/session")).status).toBe(201);
  });

  it("鍵があっても、検証の設定がなければ、見回りを動かさない", async () => {
    const server = wired({ patrol: harness.deps });

    expect((await post(server, PATROL_START_PATH)).status).toBe(404);
    expect((await post(server, PATROL_WEBHOOK_PATH)).status).toBe(404);
    expect(harness.agent.requests).toEqual([]);
  });

  it("検証の設定があるときは確かめ、見回りの鍵がなければ入口だけが断る", async () => {
    const server = wired({ internal: oidcOk, patrol: null });

    expect((await post(server, PATROL_START_PATH)).status).toBe(401);
    expect((await post(server, PATROL_START_PATH, { authorization: "Bearer ok" })).status).toBe(
      404,
    );
    // 署名の鍵がなければ、Webhook の入口は確かめる前に断る
    expect((await post(server, PATROL_WEBHOOK_PATH)).status).toBe(404);
  });

  it("配線すると、検証を通った起動が見回りを動かす", async () => {
    const { trip, itinerary } = watchedTrip("a");
    harness.store.putWatchedTrip(trip, itinerary);
    harness.pages.script.set(PAGE_URL, { status: "ok", lines: pageLinesFor() });
    const server = wired({ internal: oidcOk, patrol: harness.deps });

    const res = await post(server, PATROL_START_PATH, { authorization: "Bearer ok" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ targets: 1, sentToAgent: 0 });
  });

  it("合言葉があっても、内部の入口は合言葉で確かめない", async () => {
    const server = wired({
      internal: oidcOk,
      patrol: harness.deps,
      accessPasscode: "test-passcode",
    });

    expect((await post(server, PATROL_START_PATH)).status).toBe(401);
    expect((await post(server, PATROL_START_PATH, { authorization: "Bearer ok" })).status).toBe(
      200,
    );
  });

  it("大きすぎる本文は、処理の前に断る", async () => {
    const server = wired({
      internal: {
        signature: createSignatureVerifier(SIGNING_KEY, { now: () => harness.clock.now }),
      },
      patrol: harness.deps,
    });
    const body = "x".repeat(64 * 1024);

    const res = await server.request(PATROL_WEBHOOK_PATH, {
      method: "POST",
      body,
      headers: { "content-length": String(body.length) },
    });

    expect(res.status).toBe(413);
  });
});
