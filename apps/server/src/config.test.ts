import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WISH_READER_MODEL,
  findRepoRoot,
  portInUseMessage,
  readConfig,
  startupNotice,
} from "./config";
import { ConcurrencyLimiter, clientIp, DailyLimiter } from "./routes/guard";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("readConfig", () => {
  it("何も指定しなければ mock で動き、合言葉と回数の上限は確かめない", () => {
    const config = readConfig({}, here);

    expect(config).toMatchObject({
      port: 8787,
      mode: "mock",
      production: false,
      festivalsDir: undefined,
      models: { concierge: undefined, staff: undefined, planner: undefined, verifier: undefined },
      accessPasscode: null,
      dailyChatLimit: null,
      replaySpeed: 1,
      maxBudgetUsd: undefined,
      webDist: null,
    });
    expect(config.repoRoot).toBe(path.resolve(here, "../../.."));
  });

  it("環境変数から読む", () => {
    const config = readConfig(
      {
        PORT: "9000",
        MATSURI_AGENT_MODE: "live",
        MODEL_CONCIERGE: "model-a",
        MODEL_STAFF: " model-b ",
        ACCESS_PASSCODE: "fictional",
        DAILY_CHAT_LIMIT: "100",
        AGENT_MAX_BUDGET_USD: "0.5",
        ANTHROPIC_API_KEY: "test-key",
        MATSURI_STORAGE: "firestore",
        NODE_ENV: "production",
      },
      here,
    );

    expect(config).toMatchObject({
      port: 9000,
      mode: "live",
      production: true,
      models: { concierge: "model-a", staff: "model-b", planner: "model-b", verifier: "model-b" },
      accessPasscode: "fictional",
      dailyChatLimit: 100,
      maxBudgetUsd: 0.5,
      webDist: path.resolve(here, "../../..", "apps", "web", "dist"),
    });
  });

  it("旅程係と再確認と評価係のモデルは、指定があればスタッフのモデルより優先する", () => {
    const config = readConfig(
      {
        MODEL_STAFF: "model-b",
        MODEL_PLANNER: "model-c",
        MODEL_VERIFIER: "model-d",
        MODEL_EVALUATOR: "model-e",
      },
      here,
    );

    expect(config.models).toEqual({
      concierge: undefined,
      staff: "model-b",
      planner: "model-c",
      verifier: "model-d",
      evaluator: "model-e",
      wishReader: DEFAULT_WISH_READER_MODEL,
    });
  });

  it("自由記述の読み取りのモデルは、指定がなければ軽いモデルの既定を使う", () => {
    expect(readConfig({ MODEL_WISH_READER: "model-w" }, here).models.wishReader).toBe("model-w");
    expect(readConfig({ MODEL_STAFF: "model-b" }, here).models.wishReader).toBe(
      DEFAULT_WISH_READER_MODEL,
    );
  });

  it("評価係のモデルは、指定がなければ旅程係のモデル、それもなければスタッフのモデル", () => {
    expect(
      readConfig({ MODEL_STAFF: "model-b", MODEL_PLANNER: "model-c" }, here).models,
    ).toMatchObject({
      evaluator: "model-c",
    });
    expect(readConfig({ MODEL_STAFF: "model-b" }, here).models).toMatchObject({
      evaluator: "model-b",
    });
  });

  it("DAILY_CHAT_LIMIT=0 は上限なし", () => {
    expect(readConfig({ DAILY_CHAT_LIMIT: "0" }, here).dailyChatLimit).toBeNull();
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

describe("DailyLimiter（キーごと）と、同時の数と、利用者の IP", () => {
  it("IP ごとに数え、allows は数えない", () => {
    const limiter = new DailyLimiter(1, () => "2026-08-03");

    expect(limiter.allows("203.0.113.1")).toBe(true);
    expect(limiter.consume("203.0.113.1")).toBe(true);
    expect(limiter.allows("203.0.113.1")).toBe(false);
    expect(limiter.consume("203.0.113.2")).toBe(true);
  });

  it("同時に動かせる数を超えたら取れず、返すと取れる。2回返しても数は狂わない", () => {
    const limiter = new ConcurrencyLimiter(1);
    const release = limiter.tryAcquire();

    expect(release).not.toBeNull();
    expect(limiter.tryAcquire()).toBeNull();
    release?.();
    release?.();
    expect(limiter.running).toBe(0);
    expect(limiter.tryAcquire()).not.toBeNull();
  });

  it("プロキシの数だけ X-Forwarded-For の右から数え、利用者が書いた左側は使わない", () => {
    const forwarded = "198.51.100.9, 203.0.113.7, 10.0.0.1";

    expect(clientIp(forwarded, "10.0.0.2", 1)).toBe("10.0.0.1");
    expect(clientIp(forwarded, "10.0.0.2", 2)).toBe("203.0.113.7");
    expect(clientIp(forwarded, "10.0.0.2", 0)).toBe("10.0.0.2");
    expect(clientIp(undefined, undefined, 1)).toBe("unknown");
  });
});

describe("本番の live の設定の確認", () => {
  const complete = {
    NODE_ENV: "production",
    MATSURI_AGENT_MODE: "live",
    ACCESS_PASSCODE: "fictional",
    DAILY_CHAT_LIMIT: "100",
    AGENT_MAX_BUDGET_USD: "0.5",
    ANTHROPIC_API_KEY: "test-key",
    MATSURI_STORAGE: "firestore",
  };

  it("合言葉・回数の上限・費用の上限・API キー・保存先がそろっていれば起動する", () => {
    expect(() => readConfig(complete, here)).not.toThrow();
  });

  it("欠けていれば、欠けている設定の名前を挙げて起動を止める", () => {
    const { ACCESS_PASSCODE: _, AGENT_MAX_BUDGET_USD: __, ...partial } = complete;

    expect(() => readConfig(partial, here)).toThrow("ACCESS_PASSCODE、AGENT_MAX_BUDGET_USD");
    expect(() => readConfig({ ...complete, DAILY_CHAT_LIMIT: "0" }, here)).toThrow(
      "DAILY_CHAT_LIMIT",
    );
  });

  it("保存先が Firestore でなければ、メモリと明示していても起動を止める", () => {
    const { MATSURI_STORAGE: _, ...unset } = complete;

    expect(() => readConfig(unset, here)).toThrow("MATSURI_STORAGE=firestore");
    expect(() => readConfig({ ...complete, MATSURI_STORAGE: "memory" }, here)).toThrow(
      "MATSURI_STORAGE=firestore",
    );
  });

  it("本番でも mock なら、開発でも live なら確かめない", () => {
    expect(() =>
      readConfig({ NODE_ENV: "production", MATSURI_AGENT_MODE: "mock" }, here),
    ).not.toThrow();
    expect(() => readConfig({ MATSURI_AGENT_MODE: "live" }, here)).not.toThrow();
  });

  it("IP ごとの上限・同時の数・プロキシの数を読む", () => {
    expect(
      readConfig(
        { DAILY_CHAT_LIMIT_PER_IP: "20", MAX_CONCURRENT_TURNS: "2", TRUSTED_PROXY_HOPS: "1" },
        here,
      ),
    ).toMatchObject({ dailyChatLimitPerIp: 20, maxConcurrentTurns: 2, trustedProxyHops: 1 });
    expect(readConfig({}, here)).toMatchObject({
      dailyChatLimitPerIp: null,
      maxConcurrentTurns: 4,
      trustedProxyHops: 0,
    });
  });
});

describe("起動のときの知らせ", () => {
  it("mock では、見本を再生していることと、live にする方法を出す", () => {
    const notice = startupNotice({
      mode: "mock",
      port: 8787,
      festivals: 2,
      festivalDirs: ["data/samples/festivals"],
      samples: ["sample-a"],
    });
    expect(notice.log).toEqual({
      kind: "server_started",
      mode: "mock",
      port: 8787,
      festivals: 2,
      festivalDirs: ["data/samples/festivals"],
      samples: ["sample-a"],
    });
    expect(notice.message).toContain("[mode] mock");
    expect(notice.message).toContain("sample-a");
    expect(notice.message).toContain("MATSURI_AGENT_MODE=live");
  });

  it("live では、読み込んだ祭りの件数と場所を出す", () => {
    const notice = startupNotice({
      mode: "live",
      port: 8787,
      festivals: 21,
      festivalDirs: ["data/festivals"],
      samples: [],
    });
    expect(notice.log).toMatchObject({ mode: "live", festivals: 21 });
    expect(notice.log).not.toHaveProperty("samples");
    expect(notice.message).toBe(
      "[mode] live：Claude が返事を作ります。祭りのデータ 21件（data/festivals）から探します",
    );
  });
});

describe("portInUseMessage", () => {
  it("ふさがっているポートと、ポートを変えて起動し直す方法を示す", () => {
    const message = portInUseMessage(8787);
    expect(message).toContain("ポート 8787");
    expect(message).toContain("PORT=8788 MATSURI_WEB_PORT=5174 pnpm dev");
  });
});
