import {
  AuthConfigSchema,
  DEFAULT_PREFERENCES,
  type Itinerary,
  ShareResponseSchema,
  TRIAL_ACCOUNT_UID,
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
import { StoragePersistence } from "../session/persistence";
import { ItineraryStore, SessionStore } from "../session/sessionStore";
import { MemoryTripStorage } from "../storage/memory";
import { ownerIdOf } from "../storage/owner";
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

function setup(
  options: { login?: boolean; runner?: AgentRunner; itineraries?: ItineraryStore } = {},
) {
  const itineraries = options.itineraries ?? new ItineraryStore();
  const sessions = new SessionStore();
  const storage = new MemoryTripStorage();
  const persistence = new StoragePersistence({ storage, itineraries, sessions });
  const app = createApp({
    runner: options.runner ?? runner,
    persistence,
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
    itineraries.save(itinerary, null);
    session.itineraryId = itinerary.id;
    return { session, itinerary };
  };
  return { app, call, sessions, itineraries, storage, persistence, sessionWithItinerary };
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

  it("ほかの人が残した旅は、同じ相談からでも残せず、あるかどうかも見せない", async () => {
    const { call, sessionWithItinerary } = setup();
    const { session } = sessionWithItinerary();
    const post = (user: string) =>
      call("/api/trips", { method: "POST", user, body: { sessionId: session.id } });

    expect((await post("alice")).status).toBe(201);
    const refused = await post("bob");
    const missing = await call("/api/trips", {
      method: "POST",
      user: "bob",
      body: { sessionId: "s-none" },
    });

    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual(await missing.json());
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

  it("旅を消すと写しを捨て、次の発言の前に相談から旅程を外す", async () => {
    const { call, sessions, itineraries, sessionWithItinerary } = setup();
    const { session, itinerary } = sessionWithItinerary();
    const body = { sessionId: session.id };
    await call("/api/trips", { method: "POST", user: "alice", body });

    const deleted = await call(`/api/trips/${itinerary.id}`, { method: "DELETE", user: "alice" });

    expect(deleted.status).toBe(204);
    expect(itineraries.get(itinerary.id)).toBeUndefined();

    const said = await call("/api/chat", {
      method: "POST",
      user: "alice",
      body: { ...body, message: "こんにちは", preferences: DEFAULT_PREFERENCES },
    });
    await said.text();

    expect(said.status).toBe(200);
    const after = sessions.get(session.id);
    expect(after?.itineraryId).toBeNull();
    expect(after?.stage).toBe("hearing");
    expect((await call("/api/trips", { method: "POST", user: "alice", body })).status).toBe(409);
  });

  describe("返事の途中に消したとき", () => {
    /** 返事を止められるまで動き、止められたあとに旅程を保存しようとする接客 */
    const holdingRunner = (itineraries: ItineraryStore, save: Itinerary) => {
      let started = () => {};
      const running = new Promise<void>((resolve) => {
        started = resolve;
      });
      const saved: boolean[] = [];
      const holding: AgentRunner = {
        mode: "mock",
        runTurn: (input) =>
          new Promise<void>((_resolve, reject) => {
            started();
            input.signal.addEventListener("abort", () => {
              saved.push(itineraries.saveForSession(input.session, save));
              reject(input.signal.reason);
            });
          }),
      };
      return { holding, running, saved };
    };

    const talkAndWait = async (
      context: ReturnType<typeof setup>,
      session: { id: string },
      running: Promise<void>,
    ) => {
      const reply = context.call("/api/chat", {
        method: "POST",
        user: "alice",
        body: {
          sessionId: session.id,
          message: "こんにちは",
          preferences: DEFAULT_PREFERENCES,
        },
      });
      const response = await reply;
      const body = response.text();
      await running;
      return { body };
    };

    it("すべて消すと返事が止まり、相談も旅程も戻らない", async () => {
      const replacement = { ...fictionalItinerary(), id: "trip-after-delete" };
      const itineraries = new ItineraryStore();
      const { holding, running, saved } = holdingRunner(itineraries, replacement);
      const context = setup({ runner: holding, itineraries });
      const { session } = context.sessionWithItinerary();
      await context.call("/api/trips", {
        method: "POST",
        user: "alice",
        body: { sessionId: session.id },
      });
      const { body } = await talkAndWait(context, session, running);

      const deleted = await context.call("/api/me/trips", { method: "DELETE", user: "alice" });
      expect(deleted.status).toBe(200);
      const text = await body;
      await context.persistence.flush();

      expect(text).toContain("旅を消したので");
      expect(saved).toEqual([false]);
      expect(await context.storage.getSession(session.id)).toBeNull();
      expect(context.itineraries.get(replacement.id)).toBeUndefined();
      expect(await context.storage.forOwner(ownerIdOf("alice")).getTrip(replacement.id)).toBeNull();
      // メモリからも外れて、もう開けない
      expect(context.sessions.get(session.id)).toBeUndefined();
      const again = await context.call("/api/chat", {
        method: "POST",
        user: "alice",
        body: { sessionId: session.id, message: "やあ", preferences: DEFAULT_PREFERENCES },
      });
      expect(again.status).toBe(404);
    });

    it("旅を1つ消すと返事が止まり、同じ ID で作り直されない", async () => {
      const itineraries = new ItineraryStore();
      const placeholder = { ...fictionalItinerary(), id: "placeholder" };
      const { holding, running, saved } = holdingRunner(itineraries, placeholder);
      const context = setup({ runner: holding, itineraries });
      const { session, itinerary } = context.sessionWithItinerary();
      await context.call("/api/trips", {
        method: "POST",
        user: "alice",
        body: { sessionId: session.id },
      });
      const { body } = await talkAndWait(context, session, running);

      const deleted = await context.call(`/api/trips/${itinerary.id}`, {
        method: "DELETE",
        user: "alice",
      });
      expect(deleted.status).toBe(204);
      expect(await body).toContain("旅を消したので");
      await context.persistence.flush();

      expect(saved).toEqual([false]);
      expect(context.itineraries.get(itinerary.id)).toBeUndefined();
      const read = await context.call(`/api/trips/${itinerary.id}`, { user: "alice" });
      expect(read.status).toBe(404);
      expect((await context.storage.readUnowned(itinerary.id)) ?? null).toBeNull();
    });

    it("ほかの人の旅を消そうとしても、その人の返事は止まらない", async () => {
      const itineraries = new ItineraryStore();
      const placeholder = { ...fictionalItinerary(), id: "placeholder" };
      const { holding, running } = holdingRunner(itineraries, placeholder);
      const context = setup({ runner: holding, itineraries });
      const { session, itinerary } = context.sessionWithItinerary();
      await context.call("/api/trips", {
        method: "POST",
        user: "alice",
        body: { sessionId: session.id },
      });
      const { body } = await talkAndWait(context, session, running);

      const refused = await context.call(`/api/trips/${itinerary.id}`, {
        method: "DELETE",
        user: "bob",
      });

      expect(refused.status).toBe(404);
      expect(context.sessions.get(session.id)?.tripDeleted).toBe(false);
      expect(context.sessions.get(session.id)?.stopTurn).not.toBeNull();
      context.sessions.get(session.id)?.stopTurn?.();
      await body;
    });
  });

  it("すべて消すと、相談の途中の状態も消え、もう続けられない", async () => {
    const { call, sessions, storage, itineraries, sessionWithItinerary } = setup();
    const { session, itinerary } = sessionWithItinerary();
    const others = sessions.create();
    const body = { sessionId: session.id };
    await call("/api/trips", { method: "POST", user: "alice", body });
    expect((await storage.getSession(session.id))?.ownerUid).toBe("alice");

    await call("/api/me/trips", { method: "DELETE", user: "alice" });

    expect(await storage.getSession(session.id)).toBeNull();
    expect(sessions.get(session.id)).toBeUndefined();
    expect(itineraries.get(itinerary.id)).toBeUndefined();
    expect(sessions.get(others.id)?.id).toBe(others.id);
    expect((await call("/api/trips", { method: "POST", user: "alice", body })).status).toBe(404);
  });

  it("お試し用のアカウントは、まとめて消せない。旅は残したままで、1つずつは消せる", async () => {
    const { call, sessionWithItinerary } = setup();
    const { session, itinerary } = sessionWithItinerary();
    await call("/api/trips", {
      method: "POST",
      user: TRIAL_ACCOUNT_UID,
      body: { sessionId: session.id },
    });

    const refused = await call("/api/me/trips", { method: "DELETE", user: TRIAL_ACCOUNT_UID });

    expect(refused.status).toBe(403);
    expect((await call(`/api/trips/${itinerary.id}`, { user: TRIAL_ACCOUNT_UID })).status).toBe(
      200,
    );
    expect(
      (await call(`/api/trips/${itinerary.id}`, { method: "DELETE", user: TRIAL_ACCOUNT_UID }))
        .status,
    ).toBe(204);
  });

  it("お試し用のアカウントと、ほかの人は、たがいの旅を読めない", async () => {
    const { call, sessionWithItinerary } = setup();
    const trial = sessionWithItinerary();
    const own = sessionWithItinerary();
    const keep = (sessionId: string, user: string) =>
      call("/api/trips", { method: "POST", user, body: { sessionId } });
    await keep(trial.session.id, TRIAL_ACCOUNT_UID);
    await keep(own.session.id, "alice");

    const read = (id: string, user: string) => call(`/api/trips/${id}`, { user });

    expect((await read(trial.itinerary.id, "alice")).status).toBe(404);
    expect((await read(own.itinerary.id, TRIAL_ACCOUNT_UID)).status).toBe(404);
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
