import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findRepoRoot, readConfig } from "./config";
import { DailyLimiter } from "./routes/guard";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("readConfig", () => {
  it("何も指定しなければ mock で動き、合言葉と回数の上限は確かめない", () => {
    const config = readConfig({}, here);

    expect(config).toMatchObject({
      port: 8787,
      mode: "mock",
      production: false,
      festivalsDir: undefined,
      models: { concierge: undefined, staff: undefined },
      accessPasscode: null,
      dailyChatLimit: null,
      replaySpeed: 1,
    });
    expect(config.repoRoot).toBe(path.resolve(here, "../../.."));
  });

  it("環境変数から読む。DAILY_CHAT_LIMIT=0 は上限なし", () => {
    const config = readConfig(
      {
        PORT: "9000",
        MATSURI_AGENT_MODE: "live",
        MODEL_CONCIERGE: "model-a",
        MODEL_STAFF: " model-b ",
        ACCESS_PASSCODE: "fictional",
        DAILY_CHAT_LIMIT: "0",
        NODE_ENV: "production",
      },
      here,
    );

    expect(config).toMatchObject({
      port: 9000,
      mode: "live",
      production: true,
      models: { concierge: "model-a", staff: "model-b" },
      accessPasscode: "fictional",
      dailyChatLimit: null,
    });
  });

  it("おかしな値は起動のときに止める", () => {
    expect(() => readConfig({ MATSURI_AGENT_MODE: "real" }, here)).toThrow("MATSURI_AGENT_MODE");
    expect(() => readConfig({ DAILY_CHAT_LIMIT: "many" }, here)).toThrow("DAILY_CHAT_LIMIT");
  });

  it("リポジトリの根は pnpm-workspace.yaml のある場所", () => {
    expect(findRepoRoot(here)).toBe(path.resolve(here, "../../.."));
  });
});

describe("DailyLimiter", () => {
  it("日本の日付が変わると数え直す", () => {
    let today = "2026-08-03";
    const limiter = new DailyLimiter(2, () => today);

    expect([limiter.consume(), limiter.consume(), limiter.consume()]).toEqual([true, true, false]);
    today = "2026-08-04";
    expect(limiter.consume()).toBe(true);
  });

  it("上限がなければ、いつも通す", () => {
    const limiter = new DailyLimiter(null, () => "2026-08-03");

    expect(Array.from({ length: 5 }, () => limiter.consume()).every(Boolean)).toBe(true);
  });
});
