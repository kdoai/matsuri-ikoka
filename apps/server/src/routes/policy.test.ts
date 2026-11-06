import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp, declaredRoutes } from "../app";
import { createFestivalStore } from "../data/festivalStore";
import { Consultations } from "../session/consultations";
import { StoragePersistence } from "../session/persistence";
import { ItineraryStore, SessionStore } from "../session/sessionStore";
import { MemoryTripStorage } from "../storage/memory";
import { DailyLimiter } from "./guard";
import { type RouteGuards, type RoutePolicy, SecureRoutes, UndeclaredRouteError } from "./policy";

// すべての経路に認可の決まりを宣言させる。宣言のない経路があると、ここで落ちる。

const root = (relative: string) =>
  fileURLToPath(new URL(`../../../../${relative}`, import.meta.url));

function app(webDist: string | null = null) {
  return createApp({
    runner: { mode: "mock", runTurn: async () => {} },
    sessions: new SessionStore(),
    itineraries: new ItineraryStore(),
    festivals: createFestivalStore([]),
    limiter: new DailyLimiter(null, () => "2026-08-03"),
    accessPasscode: null,
    webDist,
  });
}

function guards(overrides: Partial<RouteGuards> = {}): RouteGuards {
  const sessions = new SessionStore();
  const persistence = new StoragePersistence({
    storage: new MemoryTripStorage(),
    itineraries: new ItineraryStore(),
    sessions,
  });
  return {
    verifier: null,
    persistence,
    consultations: new Consultations({ sessions, persistence }),
    ...overrides,
  };
}

/** 経路と決まりの表。経路を足したら、ここと docs/spec/api.md の表に足す */
const ROUTES: [string, string, RoutePolicy][] = [
  ["GET", "/healthz", "public"],
  ["GET", "/health", "public"],
  ["POST", "/api/session", "public"],
  ["POST", "/api/chat", "consultation"],
  ["PATCH", "/api/preferences", "consultation"],
  ["POST", "/api/festivals/search", "consultation"],
  ["GET", "/api/festivals", "public"],
  ["GET", "/api/festivals/:id", "public"],
  ["POST", "/api/festival-trips/preview", "consultation"],
  ["GET", "/api/itinerary/:id", "public"],
  ["GET", "/shiori/assets/*", "public"],
  ["GET", "/shiori/:id{[^/]+\\.pdf}", "public"],
  ["GET", "/shiori/:id", "public"],
  ["GET", "/api/auth/config", "public"],
  ["GET", "/api/trips", "owner"],
  ["POST", "/api/trips", "owner"],
  ["GET", "/api/trips/:id", "owner"],
  ["GET", "/api/trips/:id/versions/:version{[0-9]{1,6}}", "owner"],
  ["POST", "/api/trips/:id/share", "owner"],
  ["DELETE", "/api/trips/:id", "owner"],
  ["DELETE", "/api/me/trips", "owner"],
];

const POLICY_LABELS: Record<RoutePolicy, string> = {
  public: "だれでも",
  consultation: "相談の持ち主",
  owner: "ログインした持ち主",
  internal: "内部",
};

describe("経路と認可の決まり", () => {
  it("すべての経路が決まりを宣言している", () => {
    const declared = declaredRoutes(app()).map((r) => [r.method, r.path, r.policy]);
    expect(declared).toEqual(ROUTES);
  });

  it("画面のファイルも、だれでも読める経路として宣言している", () => {
    expect(declaredRoutes(app(root("apps/web/dist")))).toContainEqual({
      method: "GET",
      path: "*",
      policy: "public",
    });
  });

  it("文書の表と、宣言した経路がそろっている", async () => {
    const doc = await readFile(root("docs/spec/api.md"), "utf8");
    // 表の行のはじめの3列（メソッド・パス・決まり）
    const rows = new Set(
      doc
        .split(/\r?\n/)
        .filter((line) => line.startsWith("|"))
        .map((line) =>
          line
            .split("|")
            .slice(1, 4)
            .map((cell) => cell.trim())
            .join(" "),
        ),
    );
    const pathOf = (path: string) =>
      path.replace("{[^/]+\\.pdf}", ".pdf").replace("{[0-9]{1,6}}", "");
    for (const [method, path, policy] of ROUTES) {
      const row = `${method} \`${pathOf(path)}\` ${POLICY_LABELS[policy]}`;
      expect(rows.has(row), row).toBe(true);
    }
  });

  it.each([
    ["app.get", (raw: Hono) => raw.get("/api/undeclared", (c) => c.text("x"))],
    ["app.post", (raw: Hono) => raw.post("/api/undeclared", (c) => c.text("x"))],
    ["app.all", (raw: Hono) => raw.all("/api/undeclared", (c) => c.text("x"))],
    ["app.use", (raw: Hono) => raw.use("/api/undeclared", (_c, next) => next())],
    ["app.on", (raw: Hono) => raw.on("PATCH", "/api/undeclared", (c) => c.text("x"))],
  ])("決まりを宣言せずに %s で足した経路があると、起動を止める", (_name, register) => {
    const raw = new Hono();
    const routes = new SecureRoutes(raw, guards());
    routes.public("GET", "/api/declared", (c) => c.text("ok"));
    expect(() => routes.seal()).not.toThrow();

    register(raw);

    expect(() => routes.seal()).toThrow(UndeclaredRouteError);
    expect(() => routes.seal()).toThrow("/api/undeclared");
  });
});

describe("ログインした持ち主の経路", () => {
  const ownerApp = (verifier: RouteGuards["verifier"]) => {
    const raw = new Hono();
    const routes = new SecureRoutes(raw, guards({ verifier }));
    routes.owner("GET", "/api/mine", (c, { owner, trips }) =>
      c.json({ owner, scopedTo: trips.owner }),
    );
    return raw;
  };

  it("ログインを用意していなければ 404、トークンがなければ 401", async () => {
    expect((await ownerApp(null).request("/api/mine")).status).toBe(404);
    const verifier = { verify: async () => "alice" };
    expect((await ownerApp(verifier).request("/api/mine")).status).toBe(401);
  });

  it("確かめた利用者に絞った保存の口だけを渡し、キャッシュさせない", async () => {
    const verifier = { verify: async (token: string) => (token === "good" ? "alice" : null) };
    const res = await ownerApp(verifier).request("/api/mine", {
      headers: { authorization: "Bearer good" },
    });

    expect(await res.json()).toEqual({ owner: "alice", scopedTo: "alice" });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const bad = await ownerApp(verifier).request("/api/mine", {
      headers: { authorization: "Bearer bad" },
    });
    expect(bad.status).toBe(401);
  });
});

describe("内部の入口", () => {
  const internalApp = (internal?: RouteGuards["internal"]) => {
    const raw = new Hono();
    const routes = new SecureRoutes(raw, guards(internal === undefined ? {} : { internal }));
    routes.internal("POST", "/internal/tick", "oidc", (c, caller) => c.json({ caller: caller.id }));
    return raw;
  };

  it("検証の設定がなければ、その入口だけが断る", async () => {
    expect((await internalApp().request("/internal/tick", { method: "POST" })).status).toBe(404);
    // 別の検証の設定があっても、宣言した検証がなければ断る
    const signatureOnly = internalApp({
      signature: { verify: async () => ({ kind: "signature", id: "x" }) },
    });
    expect((await signatureOnly.request("/internal/tick", { method: "POST" })).status).toBe(404);
  });

  it("確かめられなければ 401、確かめられたら呼び出し元を渡す", async () => {
    const refused = internalApp({ oidc: { verify: async () => null } });
    const allowed = internalApp({
      oidc: { verify: async () => ({ kind: "oidc", id: "scheduler@example.com" }) },
    });

    expect((await refused.request("/internal/tick", { method: "POST" })).status).toBe(401);
    const res = await allowed.request("/internal/tick", { method: "POST" });
    expect(await res.json()).toEqual({ caller: "scheduler@example.com" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("検証の設定がなくても、サーバーは起動し、今の経路は動く", async () => {
    const server = app();

    expect((await server.request("/health")).status).toBe(200);
    expect((await server.request("/internal/tick", { method: "POST" })).status).toBe(404);
    expect((await server.request("/api/festivals")).status).toBe(200);
  });
});
