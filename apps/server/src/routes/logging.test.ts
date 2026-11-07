import { inspect } from "node:util";
import { DEFAULT_PREFERENCES } from "@matsuri-ikoka/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunner } from "../agent/runner";
import { type AppDeps, createApp } from "../app";
import { createFestivalStore } from "../data/festivalStore";
import { testFestival } from "../domain/testFestivals";
import { errorForLog } from "../log";
import { ItineraryStore, SessionStore } from "../session/sessionStore";
import { MemoryTripStorage } from "../storage/memory";
import type { TripStorage } from "../storage/types";
import { DailyLimiter } from "./guard";

// 発言の本文・位置・トークンをログに残さない。
// 例外の文に入力がそのまま入るライブラリがあるので、失敗の経路でも残らないことを確かめる。

const SECRET_MESSAGE = "ひみつの発言7f3a";
const SECRET_ORIGIN = "ひみつの出発地5c1e";
const SECRET_WISH = "ひみつの希望9b2d";
const SECRET_TOKEN = "secret-id-token-4e8f";
const SECRET_PASSCODE = "secret-passcode-1a6c";
const SECRETS = [SECRET_MESSAGE, SECRET_ORIGIN, SECRET_WISH, SECRET_TOKEN, SECRET_PASSCODE];

let logged: string[];

beforeEach(() => {
  logged = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => inspect(arg, { depth: 8 })).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

const expectNoSecrets = () => {
  expect(logged.length, "失敗の経路を通っている").toBeGreaterThan(0);
  for (const secret of SECRETS) {
    expect(logged.filter((line) => line.includes(secret))).toEqual([]);
  }
};

function setup(overrides: Partial<AppDeps> = {}) {
  const app = createApp({
    runner: { mode: "live", runTurn: async () => {} },
    sessions: new SessionStore(),
    itineraries: new ItineraryStore(),
    festivals: createFestivalStore([testFestival({ id: "suzunari-toro" })]),
    limiter: new DailyLimiter(null, () => "2026-08-03"),
    accessPasscode: SECRET_PASSCODE,
    today: () => "2026-08-03",
    verifier: {
      verify: async (token) => {
        throw new Error(`確かめられないトークン：${token}`);
      },
    },
    ...overrides,
  });
  const post = (path: string, body: unknown, method = "POST") =>
    app.request(path, {
      method,
      headers: {
        "content-type": "application/json",
        "x-access-passcode": SECRET_PASSCODE,
      },
      body: JSON.stringify(body),
    });
  const start = async () =>
    ((await (await post("/api/session", {})).json()) as { sessionId: string }).sessionId;
  return { app, post, start };
}

/** 入力を例外の文に入れて失敗する接客 */
const echoingRunner: AgentRunner = {
  mode: "live",
  runTurn: async ({ message }) => {
    throw new Error(`返事を作れませんでした：${message}`);
  },
};

describe("ログに残さないもの", () => {
  it("発言の本文：返事を作るのに失敗しても、例外の文を残さない", async () => {
    const { post, start } = setup({ runner: echoingRunner });
    const sessionId = await start();

    const res = await post("/api/chat", {
      sessionId,
      message: SECRET_MESSAGE,
      preferences: DEFAULT_PREFERENCES,
    });
    await res.text();

    expectNoSecrets();
    expect(logged.some((line) => line.includes("turn_failed"))).toBe(true);
  });

  it("発言の本文：うまくいった返事でも残さない", async () => {
    const { post, start } = setup();
    const sessionId = await start();

    const res = await post("/api/chat", {
      sessionId,
      message: SECRET_MESSAGE,
      preferences: DEFAULT_PREFERENCES,
    });
    await res.text();

    expectNoSecrets();
  });

  it("位置：出発地は保存に失敗しても残さない", async () => {
    const storage = new MemoryTripStorage();
    const failing: TripStorage = new Proxy(storage, {
      get(target, name) {
        if (name === "saveSession") {
          return async (snapshot: unknown) => {
            throw new Error(`書けませんでした：${JSON.stringify(snapshot)}`);
          };
        }
        const value = Reflect.get(target, name, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const { post, start } = setup({ storage: failing });
    const sessionId = await start();

    const res = await post("/api/festival-trips/preview", {
      sessionId,
      anchor: { festivalId: "suzunari-toro", date: "2026-08-16" },
      origin: SECRET_ORIGIN,
      nights: 1,
      wishes: [],
    });
    expect(res.status).toBe(200);

    expectNoSecrets();
    expect(logged.some((line) => line.includes("storage_failed"))).toBe(true);
  });

  it("自由記述：読み取りに失敗しても残さない", async () => {
    const { post, start } = setup({
      readFestivalWish: async (wish) => {
        throw new Error(`読めませんでした：${wish}`);
      },
    });
    const sessionId = await start();

    const res = await post("/api/festivals/search", {
      sessionId,
      kinds: [],
      season: null,
      prefectures: [],
      wish: SECRET_WISH,
    });
    expect(res.status).toBe(200);

    expectNoSecrets();
    expect(logged.some((line) => line.includes("wish_read_failed"))).toBe(true);
  });

  it("トークンと合言葉：確かめるのに失敗しても残さない", async () => {
    const { app } = setup();

    const res = await app.request("/api/session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-access-passcode": SECRET_PASSCODE,
        authorization: `Bearer ${SECRET_TOKEN}`,
      },
      body: "{}",
    });
    expect(res.status).toBe(500);

    expectNoSecrets();
    expect(logged.some((line) => line.includes('"kind":"unhandled"'))).toBe(true);
  });
});

describe("errorForLog", () => {
  it("例外の文を除き、種類と場所だけを残す", () => {
    const error = Object.assign(new TypeError(`読めません：${SECRET_MESSAGE}`), {
      code: "permission-denied",
    });

    const log = errorForLog(error);

    expect(log.errorName).toBe("TypeError");
    expect(log.errorCode).toBe("permission-denied");
    expect(log.frames?.every((line) => line.startsWith("at "))).toBe(true);
    expect(JSON.stringify(log)).not.toContain(SECRET_MESSAGE);
  });

  it("例外でないものは、種類だけを残す", () => {
    expect(errorForLog(SECRET_MESSAGE)).toEqual({ errorName: "string" });
  });
});
