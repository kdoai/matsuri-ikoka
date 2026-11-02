import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createFestivalStore } from "../data/festivalStore";
import { ItineraryStore, SessionStore } from "../session/sessionStore";
import { DailyLimiter } from "./guard";

let dist: string;

beforeAll(async () => {
  dist = await mkdtemp(path.join(tmpdir(), "web-dist-"));
  await mkdir(path.join(dist, "assets"));
  await writeFile(path.join(dist, "index.html"), "<!doctype html><title>画面</title>");
  await writeFile(path.join(dist, "assets", "app-abc123.js"), "console.log(1)");
});

afterAll(async () => {
  await rm(dist, { recursive: true, force: true });
});

function app(webDist: string | null) {
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

describe("画面のビルドを同じオリジンから配る", () => {
  it("トップと assets を返す。assets は長く置き、ページは毎回確かめさせる", async () => {
    const top = await app(dist).request("/");
    const asset = await app(dist).request("/assets/app-abc123.js");

    expect(top.status).toBe(200);
    expect(await top.text()).toContain("<title>画面</title>");
    expect(top.headers.get("cache-control")).toBe("no-cache");
    expect(top.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");
  });

  it("画面の中の経路には index.html を返す", async () => {
    const res = await app(dist).request("/trip/abc");

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>画面</title>");
  });

  it("API・しおり・死活監視の経路は、画面のファイルで上書きしない", async () => {
    const api = await app(dist).request("/api/no-such");
    const shiori = await app(dist).request("/shiori/no-such");
    const health = await app(dist).request("/healthz");

    expect(api.status).toBe(404);
    expect(await api.text()).not.toContain("<title>画面</title>");
    expect(shiori.status).toBe(404);
    expect(await shiori.text()).toContain("しおりが見つかりません");
    expect(await health.json()).toEqual({ status: "ok" });
  });

  it("ディレクトリの外は読ませない", async () => {
    const res = await app(dist).request("/../package.json");

    expect(await res.text()).not.toContain('"name"');
  });

  it("画面のビルドを指定しなければ配らない", async () => {
    expect((await app(null).request("/")).status).toBe(404);
  });
});
