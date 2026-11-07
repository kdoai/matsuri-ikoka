import { fileURLToPath } from "node:url";
import {
  DEFAULT_PREFERENCES,
  decodeSseEvent,
  type SampleConversation,
  type SampleGuide,
  type SseEvent,
} from "@matsuri-ikoka/schema";
import { fictionalItinerary } from "@matsuri-ikoka/schema/testing";
import { beforeAll, describe, expect, it } from "vitest";
import type { IdTokenVerifier } from "../account/idToken";
import { loadSampleConversations, ReplayAgentRunner } from "../agent/replayRunner";
import type { AgentRunner } from "../agent/runner";
import { type AppDeps, createApp, declaredRoutes } from "../app";
import { type FestivalStore, loadFestivals } from "../data/festivalStore";
import { loadSampleGuides, ReplayGuideRunner } from "../guide/replayRunner";
import { snapshotOf } from "../session/persistence";
import { ItineraryStore, SessionStore } from "../session/sessionStore";
import { createShiori } from "../shiori";
import { MemoryTripStorage } from "../storage/memory";
import { ownerIdOf } from "../storage/owner";
import { ConcurrencyLimiter, DailyLimiter } from "./guard";

// 利用者ごとの分離。利用者 A の相談・旅・共有していない旅程に、利用者 B とログインなしの人が触れないことを、
// 経路ごとに確かめる。祭りと相談はサンプルの架空のもの。

const root = (relative: string) =>
  fileURLToPath(new URL(`../../../../${relative}`, import.meta.url));

let samples: SampleConversation[];
let guides: SampleGuide[];
let festivals: FestivalStore;

beforeAll(async () => {
  samples = await loadSampleConversations(root("data/samples/conversations"));
  guides = await loadSampleGuides(root("data/samples/guide"));
  festivals = (await loadFestivals([root("data/samples/festivals")])).store;
});

/** 「token-<利用者>」だけを通す、ネットワークに出ない ID トークンの確認 */
const fakeVerifier: IdTokenVerifier = {
  async verify(token) {
    const uid = token.startsWith("token-") ? token.slice("token-".length) : "";
    return uid === "" ? null : uid;
  },
};

const ALICE = "alice";
const BOB = "bob";

interface CallInit {
  method?: string;
  user?: string;
  /** Authorization にそのまま入れる値（偽のトークンを試す） */
  authorization?: string;
  body?: unknown;
}

function setup(overrides: Partial<AppDeps> = {}) {
  const itineraries = overrides.itineraries ?? new ItineraryStore();
  const sessions = overrides.sessions ?? new SessionStore();
  const storage = (overrides.storage as MemoryTripStorage | undefined) ?? new MemoryTripStorage();
  const app = createApp({
    runner: new ReplayAgentRunner(samples, itineraries, { speed: 0 }),
    guide: { runner: new ReplayGuideRunner(guides, { speed: 0 }) },
    limiter: new DailyLimiter(null, () => "2026-08-03"),
    festivals,
    accessPasscode: null,
    verifier: fakeVerifier,
    authConfig: {
      enabled: true,
      apiKey: "public-key",
      authDomain: "example.com",
      projectId: "demo",
    },
    shiori: createShiori({
      engine: {
        render: async () => ({ pdf: Buffer.from("%PDF-1.7 fake"), blocked: 0 }),
        close: async () => {},
      },
      config: {
        concurrency: 1,
        queue: 0,
        timeoutMs: 1000,
        cacheBytes: 1024 * 1024,
        executablePath: undefined,
      },
    }),
    ...overrides,
    itineraries,
    sessions,
    storage,
  });
  const call = (path: string, init: CallInit = {}) => {
    const authorization =
      init.authorization ?? (init.user === undefined ? undefined : `Bearer token-${init.user}`);
    return app.request(path, {
      method: init.method ?? "GET",
      headers: {
        "content-type": "application/json",
        ...(authorization === undefined ? {} : { authorization }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  };
  const chat = (sessionId: string, user?: string, message = "こんにちは") =>
    call("/api/chat", {
      method: "POST",
      body: { sessionId, message, preferences: DEFAULT_PREFERENCES },
      ...(user === undefined ? {} : { user }),
    });
  /** 相談を始める */
  const start = async (user?: string) => {
    const res = await call("/api/session", {
      method: "POST",
      body: {},
      ...(user === undefined ? {} : { user }),
    });
    return ((await res.json()) as { sessionId: string }).sessionId;
  };
  /** サンプルの相談を最後まで流し、しおりにできる旅程まで進める */
  const consult = async (user?: string) => {
    const sessionId = await start(user);
    for (const _ of samples[0]?.turns ?? []) await (await chat(sessionId, user)).text();
    const session = sessions.get(sessionId);
    const itineraryId = session?.itineraryId;
    if (session === undefined || !itineraryId) throw new Error("旅程がありません");
    return {
      sessionId,
      itineraryId,
      version: itineraries.get(itineraryId)?.version ?? 1,
      memoId: "memo-suzunari-sample-1",
    };
  };
  return { app, call, chat, start, consult, sessions, itineraries, storage };
}

/** SSE の本文をイベントにする */
async function readEvents(res: Response): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for (const block of (await res.text()).split(/\n\n/)) {
    const lines = block.split("\n").filter(Boolean);
    const event = lines
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (event) events.push(decodeSseEvent({ event, data }));
  }
  return events;
}

const ANCHOR = { festivalId: "suzunari-toro", date: "2026-08-16" };

interface Target {
  sessionId: string;
  itineraryId: string;
  version: number;
  /** ガイドの手帳の項目 */
  memoId: string;
}

/** 利用者のデータに触れる経路の表。other は利用者 B、anonymous はログインなし（偽のトークンも同じ扱い） */
const TABLE: {
  route: string;
  request: (target: Target) => { method?: string; path: string; body?: unknown };
  owner: number;
  other: number;
  anonymous: number;
}[] = [
  {
    route: "POST /api/chat",
    request: ({ sessionId }) => ({
      method: "POST",
      path: "/api/chat",
      body: { sessionId, message: "こんにちは", preferences: DEFAULT_PREFERENCES },
    }),
    owner: 200,
    other: 404,
    anonymous: 404,
  },
  {
    route: "PATCH /api/preferences",
    request: ({ sessionId }) => ({
      method: "PATCH",
      path: "/api/preferences",
      body: { sessionId, preferences: { ...DEFAULT_PREFERENCES, party: "kids" } },
    }),
    owner: 200,
    other: 404,
    anonymous: 404,
  },
  {
    route: "POST /api/festivals/search",
    request: ({ sessionId }) => ({
      method: "POST",
      path: "/api/festivals/search",
      body: { sessionId, kinds: [], season: null, prefectures: [] },
    }),
    owner: 200,
    other: 404,
    anonymous: 404,
  },
  {
    // 組み立ては公開の祭りのデータだけから計算するので断らない。相談には何も残さない
    route: "POST /api/festival-trips/preview",
    request: ({ sessionId }) => ({
      method: "POST",
      path: "/api/festival-trips/preview",
      body: { sessionId, anchor: ANCHOR, origin: "別の出発駅", nights: 2, wishes: [] },
    }),
    owner: 200,
    other: 200,
    anonymous: 200,
  },
  {
    route: "GET /api/trips",
    request: () => ({ path: "/api/trips" }),
    owner: 200,
    other: 200,
    anonymous: 401,
  },
  {
    route: "POST /api/trips",
    request: ({ sessionId }) => ({ method: "POST", path: "/api/trips", body: { sessionId } }),
    owner: 201,
    other: 404,
    anonymous: 401,
  },
  {
    route: "GET /api/trips/:id",
    request: ({ itineraryId }) => ({ path: `/api/trips/${itineraryId}` }),
    owner: 200,
    other: 404,
    anonymous: 401,
  },
  {
    route: "GET /api/trips/:id/versions/:version{[0-9]{1,6}}",
    request: ({ itineraryId, version }) => ({
      path: `/api/trips/${itineraryId}/versions/${version}`,
    }),
    owner: 200,
    other: 404,
    anonymous: 401,
  },
  {
    route: "POST /api/trips/:id/share",
    request: ({ itineraryId }) => ({ method: "POST", path: `/api/trips/${itineraryId}/share` }),
    owner: 201,
    other: 404,
    anonymous: 401,
  },
  {
    route: "DELETE /api/trips/:id",
    request: ({ itineraryId }) => ({ method: "DELETE", path: `/api/trips/${itineraryId}` }),
    owner: 204,
    other: 404,
    anonymous: 401,
  },
  {
    route: "DELETE /api/me/trips",
    request: () => ({ method: "DELETE", path: "/api/me/trips" }),
    owner: 200,
    other: 200,
    anonymous: 401,
  },
  {
    route: "GET /api/itinerary/:id",
    request: ({ itineraryId }) => ({ path: `/api/itinerary/${itineraryId}` }),
    owner: 200,
    other: 404,
    anonymous: 404,
  },
  {
    route: "GET /shiori/:id",
    request: ({ itineraryId }) => ({ path: `/shiori/${itineraryId}` }),
    owner: 200,
    other: 404,
    anonymous: 404,
  },
  {
    route: "GET /shiori/:id{[^/]+\\.pdf}",
    request: ({ itineraryId }) => ({ path: `/shiori/${itineraryId}.pdf` }),
    owner: 200,
    other: 404,
    anonymous: 404,
  },
  {
    route: "POST /api/guide/open",
    request: ({ itineraryId }) => ({
      method: "POST",
      path: "/api/guide/open",
      body: { tripId: itineraryId },
    }),
    owner: 201,
    other: 404,
    anonymous: 401,
  },
  {
    route: "POST /api/guide/state",
    request: ({ sessionId }) => ({
      method: "POST",
      path: "/api/guide/state",
      body: { sessionId },
    }),
    owner: 200,
    other: 404,
    anonymous: 404,
  },
  {
    route: "POST /api/guide/chat",
    request: ({ sessionId }) => ({
      method: "POST",
      path: "/api/guide/chat",
      body: { sessionId, message: "こんにちは" },
    }),
    owner: 200,
    other: 404,
    anonymous: 404,
  },
  {
    route: "POST /api/guide/memo/:id",
    request: ({ sessionId, memoId }) => ({
      method: "POST",
      path: `/api/guide/memo/${memoId}`,
      body: { sessionId, text: "連れはゆっくり歩く" },
    }),
    owner: 200,
    other: 404,
    anonymous: 404,
  },
  {
    route: "POST /api/guide/memo/:id/delete",
    request: ({ sessionId, memoId }) => ({
      method: "POST",
      path: `/api/guide/memo/${memoId}/delete`,
      body: { sessionId },
    }),
    owner: 204,
    other: 404,
    anonymous: 404,
  },
];

/** 決まりは「だれでも」で、利用者のデータに触れない経路 */
const PUBLIC_WITHOUT_USER_DATA = [
  "GET /healthz",
  "GET /health",
  "POST /api/session",
  "GET /api/festivals",
  "GET /api/festivals/:id",
  "GET /shiori/assets/*",
  "GET /api/auth/config",
];

/** 内部の入口。利用者のデータに触れるが、利用者の ID トークンでは通らない（下の「内部の入口」） */
const INTERNAL_ROUTES = ["POST /internal/patrol/start", "POST /internal/patrol/webhook"];

const label = (route: { method: string; path: string }) => `${route.method} ${route.path}`;

describe("経路の表", () => {
  it("すべての経路が、この表か「利用者のデータに触れない経路」のどちらかにある", () => {
    const { app } = setup();
    const declared = declaredRoutes(app).map(label).sort();
    const listed = [
      ...TABLE.map((row) => row.route),
      ...PUBLIC_WITHOUT_USER_DATA,
      ...INTERNAL_ROUTES,
    ].sort();

    expect(listed).toEqual(declared);
  });
});

describe("内部の入口", () => {
  const paths = INTERNAL_ROUTES.map((route) => route.replace("POST ", ""));

  it.each(paths)("%s は、検証の設定がなければ、利用者の ID トークンでも断る", async (path) => {
    const { call } = setup();

    expect((await call(path, { method: "POST", user: ALICE })).status).toBe(404);
    expect((await call(path, { method: "POST" })).status).toBe(404);
  });

  it.each(paths)("%s は、検証があるとき、利用者の ID トークンを通さない", async (path) => {
    const { call } = setup({
      internal: {
        oidc: { verify: async () => null },
        signature: { verify: async () => null },
      },
    });

    expect((await call(path, { method: "POST", user: ALICE })).status).toBe(401);
    expect((await call(path, { method: "POST" })).status).toBe(401);
  });
});

describe.each([
  { name: "ログインした相談の、残す前の旅程", keep: false },
  { name: "残した旅", keep: true },
])("利用者 A の$name", ({ keep }) => {
  const scenario = async () => {
    const context = setup();
    const target = await context.consult(ALICE);
    if (keep) {
      const kept = await context.call("/api/trips", {
        method: "POST",
        user: ALICE,
        body: { sessionId: target.sessionId },
      });
      expect(kept.status).toBe(201);
    }
    // ガイドに話しかけて、手帳に項目を残す（サンプルの架空の相談の、手帳の発言）
    const memo = await context.call("/api/guide/chat", {
      method: "POST",
      user: ALICE,
      body: {
        sessionId: target.sessionId,
        message: "連れは歩くのがゆっくりなので、気にしてもらえますか",
      },
    });
    await memo.text();
    expect(memo.status).toBe(200);
    /** A の相談と旅程が変わっていないことを確かめるための、いまの状態 */
    const state = () => ({
      session: snapshotOf(context.sessions.get(target.sessionId)!, 0),
      itinerary: context.itineraries.get(target.itineraryId),
    });
    return { ...context, target, state };
  };

  const send = (
    context: Awaited<ReturnType<typeof scenario>>,
    request: ReturnType<(typeof TABLE)[number]["request"]>,
    init: CallInit,
  ) =>
    context.call(request.path, {
      ...init,
      ...(request.method === undefined ? {} : { method: request.method }),
      ...(request.body === undefined ? {} : { body: request.body }),
    });

  it.each(TABLE)("$route：B もログインなしの人も、読めず、変えられない", async (row) => {
    const context = await scenario();
    const { target } = context;
    const before = context.state();
    const request = row.request(target);
    const missing = row.request({
      sessionId: "s-no-such-session",
      itineraryId: "trip-no-such-trip",
      version: target.version,
      memoId: target.memoId,
    });

    const refusals: { name: string; init: CallInit; status: number }[] = [
      { name: "利用者 B", init: { user: BOB }, status: row.other },
      { name: "ログインなし", init: {}, status: row.anonymous },
      {
        name: "偽のトークン",
        init: { authorization: "Bearer forged-token" },
        status: row.anonymous,
      },
    ];
    for (const { name, init, status } of refusals) {
      const res = await send(context, request, init);
      const text = await res.text();
      expect(res.status, name).toBe(status);
      // 応答に A のものが混ざらない
      expect(text, name).not.toContain(target.itineraryId);
      expect(text, name).not.toContain(target.sessionId);
      // ない相談・ない旅程のときと同じ応答で、あるかどうかが分からない
      const other = await send(context, missing, init);
      expect(other.status, name).toBe(res.status);
      if (res.status === 404) expect(await other.text(), name).toBe(text);
      else await other.text();
    }
    expect(context.state(), "A の相談と旅程は変わらない").toEqual(before);
    expect(context.sessions.get(target.sessionId)?.ownerUid).toBe(ALICE);
    expect((await context.storage.getSession(target.sessionId))?.ownerUid).toBe(ALICE);

    const own = await send(context, request, { user: ALICE });
    await own.text();
    expect(own.status, "持ち主は使える").toBe(row.owner);
  });

  it("ほかの人の一覧にも、ほかの人の「すべて消す」にも、A の旅は出てこない", async () => {
    const { call, target } = await scenario();

    expect(await (await call("/api/trips", { user: BOB })).json()).toEqual({ trips: [] });
    const deleted = await call("/api/me/trips", { method: "DELETE", user: BOB });

    expect(await deleted.json()).toEqual({ deleted: 0 });
    expect((await call(`/api/trips/${target.itineraryId}`, { user: ALICE })).status).toBe(200);
  });

  it("明示して作った共有の ID からは、だれでも読め、旅を消すと読めなくなる", async () => {
    const { call, target } = await scenario();
    const created = await call(`/api/trips/${target.itineraryId}/share`, {
      method: "POST",
      user: ALICE,
    });
    const { shareId } = (await created.json()) as { shareId: string };

    expect((await call(`/shiori/${shareId}`)).status).toBe(200);
    expect((await call(`/shiori/${shareId}.pdf`)).status).toBe(200);
    expect((await call(`/api/itinerary/${shareId}`, { user: BOB })).status).toBe(200);

    await call(`/api/trips/${target.itineraryId}`, { method: "DELETE", user: ALICE });

    expect((await call(`/shiori/${shareId}`)).status).toBe(404);
    expect((await call(`/api/itinerary/${shareId}`)).status).toBe(404);
  });
});

describe("ログインなしの相談は、いままでどおり", () => {
  it("相談の ID を知っていれば続けられ、旅程としおりは旅程の ID で開ける", async () => {
    const { call, chat, consult } = setup();
    const { sessionId, itineraryId } = await consult();

    expect((await chat(sessionId)).status).toBe(200);
    expect((await call(`/api/itinerary/${itineraryId}`)).status).toBe(200);
    expect((await call(`/shiori/${itineraryId}`)).status).toBe(200);
    expect((await call(`/shiori/${itineraryId}.pdf`)).status).toBe(200);
    expect((await call(`/api/itinerary/${itineraryId}`, { user: BOB })).status).toBe(200);
  });

  it("途中でログインして使うと、その人の相談になり、次の版からその人の旅程になる", async () => {
    const itineraries = new ItineraryStore();
    /** 発言のたびに、旅程の新しい版を保存する接客 */
    const saving: AgentRunner = {
      mode: "live",
      runTurn: async ({ session }) => {
        const id = session.itineraryId ?? `trip-${session.id}`;
        const version = (itineraries.get(id)?.version ?? 0) + 1;
        itineraries.save({ ...fictionalItinerary(), id, version }, session.ownerUid);
        session.itineraryId = id;
      },
    };
    const { call, chat, start, sessions } = setup({ itineraries, runner: saving });
    const sessionId = await start();
    await (await chat(sessionId)).text();
    const itineraryId = `trip-${sessionId}`;
    expect((await call(`/api/itinerary/${itineraryId}`)).status).toBe(200);

    // A がログインして続ける
    const res = await chat(sessionId, ALICE);
    await res.text();

    expect(res.status).toBe(200);
    expect(sessions.get(sessionId)?.ownerUid).toBe(ALICE);
    expect((await chat(sessionId)).status).toBe(404);
    expect((await chat(sessionId, BOB)).status).toBe(404);
    expect((await call(`/api/itinerary/${itineraryId}`)).status).toBe(404);
    expect((await call(`/api/itinerary/${itineraryId}`, { user: BOB })).status).toBe(404);
    expect((await call(`/api/itinerary/${itineraryId}`, { user: ALICE })).status).toBe(200);
  });

  it("持ち主のない相談の旅程を残すと、その人の相談と旅になる。あとから別の人は残せない", async () => {
    const { call, consult, sessions } = setup();
    const { sessionId, itineraryId } = await consult();
    const save = (user: string) =>
      call("/api/trips", { method: "POST", user, body: { sessionId } });

    expect((await save(ALICE)).status).toBe(201);
    expect(sessions.get(sessionId)?.ownerUid).toBe(ALICE);
    expect((await save(BOB)).status).toBe(404);
    expect((await call(`/shiori/${itineraryId}`)).status).toBe(404);
  });
});

describe("持ち主のない前の形の相談が、残した旅程を指しているとき", () => {
  const legacySession = async () => {
    const storage = new MemoryTripStorage();
    const earlier = setup({ storage });
    const { sessionId, itineraryId } = await earlier.consult();
    await earlier.call("/api/trips", { method: "POST", user: ALICE, body: { sessionId } });
    const saved = await storage.getSession(sessionId);
    if (saved === null) throw new Error("相談がありません");
    // 前の形の相談には持ち主の項目がない
    const { ownerUid: _ownerUid, ...legacy } = saved;
    const older = new MemoryTripStorage();
    const itinerary = earlier.itineraries.get(itineraryId);
    if (itinerary === undefined) throw new Error("旅程がありません");
    await older.saveItinerary(itinerary, null);
    await older.forOwner(ownerIdOf(ALICE)).claimTrip(itineraryId);
    await older.saveSession(legacy);
    return { storage: older, sessionId, itineraryId };
  };

  it("ログインなしで開いても、相談は壊れずに続けられ、旅程は読めない", async () => {
    const { storage, sessionId, itineraryId } = await legacySession();
    const { chat, call, sessions } = setup({ storage });

    const res = await chat(sessionId);
    const events = await readEvents(res);

    expect(res.status).toBe(200);
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
    expect(sessions.get(sessionId)?.ownerUid).toBeNull();
    expect((await call(`/api/itinerary/${itineraryId}`)).status).toBe(404);
  });

  it("旅程の持ち主がログインして開けば、相談が結びつき、旅程も戻る", async () => {
    const { storage, sessionId, itineraryId } = await legacySession();
    const { call, chat, sessions, itineraries } = setup({ storage });

    const res = await chat(sessionId, ALICE);
    await res.text();

    expect(res.status).toBe(200);
    expect(sessions.get(sessionId)?.ownerUid).toBe(ALICE);
    expect(sessions.get(sessionId)?.itineraryId).toBe(itineraryId);
    expect(itineraries.get(itineraryId)?.id).toBe(itineraryId);
    expect(
      (await call("/api/trips", { method: "POST", user: ALICE, body: { sessionId } })).status,
    ).toBe(201);
  });
});

describe("利用者の ID と会話の記録は、画面から指定できない", () => {
  it.each([
    ["POST /api/session", "/api/session", "POST", { ownerUid: ALICE }],
    [
      "POST /api/chat",
      "/api/chat",
      "POST",
      { sessionId: "s", message: "やあ", preferences: DEFAULT_PREFERENCES, ownerUid: ALICE },
    ],
    [
      "POST /api/chat（会話の記録）",
      "/api/chat",
      "POST",
      { sessionId: "s", message: "やあ", preferences: DEFAULT_PREFERENCES, resume: "sdk-other" },
    ],
    [
      "POST /api/chat（会話の記録）",
      "/api/chat",
      "POST",
      {
        sessionId: "s",
        message: "やあ",
        preferences: DEFAULT_PREFERENCES,
        agentSessionId: "sdk-other",
      },
    ],
    ["POST /api/trips", "/api/trips", "POST", { sessionId: "s", ownerUid: ALICE }],
  ])("%s は余分な項目を断る", async (_name, path, method, body) => {
    const { call } = setup();
    expect((await call(path, { method, body, user: BOB })).status).toBe(400);
  });
});

describe("別のインスタンスに届いても、持ち主は変わらない", () => {
  const twoInstances = () => {
    const storage = new MemoryTripStorage();
    return { storage, first: setup({ storage }), second: setup({ storage }) };
  };

  it("保存の口から戻した相談も、持ち主だけが続けられ、旅程もいっしょに戻る", async () => {
    const { first, second } = twoInstances();
    const { sessionId, itineraryId } = await first.consult(ALICE);

    expect((await second.chat(sessionId, BOB)).status).toBe(404);
    expect((await second.chat(sessionId)).status).toBe(404);
    const own = await second.chat(sessionId, ALICE);

    expect(own.status).toBe(200);
    await own.text();
    expect(second.sessions.get(sessionId)?.ownerUid).toBe(ALICE);
    expect(second.itineraries.get(itineraryId)?.id).toBe(itineraryId);
    expect((await second.call(`/api/itinerary/${itineraryId}`)).status).toBe(404);
  });

  it("持ち主のない相談は、別のインスタンスでも続けられる", async () => {
    const { first, second } = twoInstances();
    const { sessionId, itineraryId } = await first.consult();

    expect((await second.chat(sessionId)).status).toBe(200);
    expect(second.itineraries.get(itineraryId)?.id).toBe(itineraryId);
  });
});

/** 全員がそろうまで、返事の途中で止まる接客。相談ごとの目印を、すべてのイベントに入れる */
function overlappingRunner(itineraries: ItineraryStore, parties: number): AgentRunner {
  let arrived = 0;
  let open = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    mode: "live",
    runTurn: async ({ session, message }, emit) => {
      emit({ type: "message.delta", data: { messageId: `m-${session.id}`, text: `${message}1` } });
      arrived += 1;
      if (arrived === parties) open();
      await gate;
      const itinerary = { ...fictionalItinerary(), id: `trip-${session.id}`, title: message };
      itineraries.save(itinerary, session.ownerUid);
      session.itineraryId = itinerary.id;
      session.conditions = { origin: message };
      emit({
        type: "itinerary.updated",
        data: {
          itinerary,
          diff: {
            fromVersion: 0,
            toVersion: itinerary.version,
            added: [],
            changed: [],
            removed: [],
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 1));
      emit({ type: "message.delta", data: { messageId: `m-${session.id}`, text: `${message}2` } });
    },
  };
}

describe("同時に相談しても混ざらない", () => {
  it("A・B・ログインなしの3人が同時に返事を待っても、SSE のイベントと旅程は自分のものだけが届く", async () => {
    const itineraries = new ItineraryStore();
    const { call, start, chat } = setup({
      itineraries,
      runner: overlappingRunner(itineraries, 3),
    });
    const people = [
      { user: ALICE as string | undefined, message: "利用者Aの発言" },
      { user: BOB as string | undefined, message: "利用者Bの発言" },
      { user: undefined, message: "ログインなしの発言" },
    ];
    const opened = await Promise.all(
      people.map(async (person) => ({ ...person, sessionId: await start(person.user) })),
    );

    const replies = await Promise.all(
      opened.map(async (person) => ({
        ...person,
        events: await readEvents(await chat(person.sessionId, person.user, person.message)),
      })),
    );

    for (const { events, message, sessionId } of replies) {
      const texts = events.flatMap((e) => (e.type === "message.delta" ? [e.data.text] : []));
      const itineraryIds = events.flatMap((e) =>
        e.type === "itinerary.updated" ? [e.data.itinerary.id] : [],
      );
      const done = events.filter((e) => e.type === "done");
      expect(texts).toEqual([`${message}1`, `${message}2`]);
      expect(itineraryIds).toEqual([`trip-${sessionId}`]);
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({ data: { conditions: { origin: message } } });
      expect(JSON.stringify(events)).not.toContain(
        replies.find((reply) => reply.sessionId !== sessionId)?.sessionId,
      );
    }
    // 旅程も、持ち主どうしで読めない
    const [alice, bob, anonymous] = replies;
    const read = (id: string, user?: string) =>
      call(`/api/itinerary/${id}`, user === undefined ? {} : { user });
    expect((await read(`trip-${alice?.sessionId}`, ALICE)).status).toBe(200);
    expect((await read(`trip-${alice?.sessionId}`, BOB)).status).toBe(404);
    expect((await read(`trip-${bob?.sessionId}`, BOB)).status).toBe(200);
    expect((await read(`trip-${bob?.sessionId}`, ALICE)).status).toBe(404);
    expect((await read(`trip-${anonymous?.sessionId}`)).status).toBe(200);
  });

  it("サンプルの相談を同時に流しても、旅程の ID は相談ごとに分かれる", async () => {
    const { consult, sessions } = setup();

    const [alice, bob] = await Promise.all([consult(ALICE), consult(BOB)]);

    expect(alice.itineraryId).not.toBe(bob.itineraryId);
    expect(sessions.get(alice.sessionId)?.ownerUid).toBe(ALICE);
    expect(sessions.get(bob.sessionId)?.ownerUid).toBe(BOB);
  });
});

describe("上限は利用者（なければ IP）ごとに数える", () => {
  const silentLive: AgentRunner = { mode: "live", runTurn: async () => {} };

  it("1日の回数：A が使い切っても、B とほかの IP は使える", async () => {
    const context = setup({
      runner: silentLive,
      clientLimiter: new DailyLimiter(1, () => "2026-08-03"),
      clientIp: (c) => c.req.header("x-test-ip") ?? "unknown",
    });
    const post = (sessionId: string, user: string | undefined, ip: string) =>
      context.app.request("/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-ip": ip,
          ...(user === undefined ? {} : { authorization: `Bearer token-${user}` }),
        },
        body: JSON.stringify({ sessionId, message: "やあ", preferences: DEFAULT_PREFERENCES }),
      });
    const aliceSession = await context.start(ALICE);
    const bobSession = await context.start(BOB);
    const anonymousSession = await context.start();

    // 同じ IP の A と B と、ログインなしは、別々に数える
    await (await post(aliceSession, ALICE, "203.0.113.1")).text();
    expect((await post(aliceSession, ALICE, "203.0.113.2")).status).toBe(429);
    const bob = await post(bobSession, BOB, "203.0.113.1");
    expect(bob.status).toBe(200);
    await bob.text();
    const anonymous = await post(anonymousSession, undefined, "203.0.113.1");
    expect(anonymous.status).toBe(200);
    await anonymous.text();
    expect((await post(anonymousSession, undefined, "203.0.113.1")).status).toBe(429);
    const elsewhere = await post(anonymousSession, undefined, "203.0.113.2");
    expect(elsewhere.status).toBe(200);
    await elsewhere.text();
  });

  it("同時に作る数：A が自分の枠を使い切っても、B は空きを使える", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const context = setup({
      runner: { mode: "live", runTurn: () => held },
      concurrency: new ConcurrencyLimiter(2, 1),
    });
    const first = await context.start(ALICE);
    const second = await context.start(ALICE);
    const third = await context.start(BOB);

    const running = await context.chat(first, ALICE);
    const refused = await context.chat(second, ALICE);
    const other = await context.chat(third, BOB);

    expect(running.status).toBe(200);
    expect(refused.status).toBe(503);
    expect(other.status).toBe(200);
    release();
    await running.text();
    await other.text();
  });
});
