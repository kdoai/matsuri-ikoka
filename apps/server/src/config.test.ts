import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WISH_READER_MODEL,
  findRepoRoot,
  missingRecommendedConfig,
  portInUseMessage,
  RECOMMENDED_PRODUCTION_ENV,
  REQUIRED_PRODUCTION_ENV,
  readConfig,
  startupNotice,
} from "./config";
import { DEFAULT_GUIDE_LIMITS } from "./guide/limits";
import { ConcurrencyLimiter, clientIp, DailyLimiter, limitKey } from "./routes/guard";

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

  it("ガイドのモデルは、指定がなければコンシェルジュのモデル、それもなければ持たない", () => {
    expect(readConfig({ MODEL_GUIDE: "model-g" }, here).models.guide).toBe("model-g");
    expect(
      readConfig({ MODEL_CONCIERGE: "model-a", MODEL_STAFF: "model-b" }, here).models.guide,
    ).toBe("model-a");
    expect(readConfig({ MODEL_STAFF: "model-b" }, here).models.guide).toBeUndefined();
  });

  it("ガイドの上限は、指定がなければ既定の値を使い、上限なしにしない", () => {
    expect(readConfig({}, here).guideLimits).toEqual(DEFAULT_GUIDE_LIMITS);
    expect(
      readConfig(
        {
          GUIDE_DAILY_TURNS_PER_USER: "9",
          GUIDE_DAILY_TURNS_PER_TRIP: "8",
          GUIDE_DAILY_COST_USD_PER_USER: "1.5",
          GUIDE_DAILY_COST_USD_PER_TRIP: "0.5",
        },
        here,
      ).guideLimits,
    ).toEqual({
      turnsPerUser: 9,
      turnsPerTrip: 8,
      costUsdPerUser: 1.5,
      costUsdPerTrip: 0.5,
      costUsdTrialTotal: DEFAULT_GUIDE_LIMITS.costUsdTrialTotal,
    });
    expect(() => readConfig({ GUIDE_DAILY_TURNS_PER_USER: "many" }, here)).toThrow(
      "GUIDE_DAILY_TURNS_PER_USER",
    );
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

  it("1人の上限を超えたら、全体に空きがあってもその人だけ取れない", () => {
    const limiter = new ConcurrencyLimiter(3, 1);
    const mine = limiter.tryAcquire("uid:alice");

    expect(limiter.tryAcquire("uid:alice")).toBeNull();
    expect(limiter.tryAcquire("uid:bob")).not.toBeNull();
    expect(limiter.tryAcquire("203.0.113.1")).not.toBeNull();
    expect(limiter.running).toBe(3);
    expect(limiter.tryAcquire("uid:carol")).toBeNull();
    mine?.();
    mine?.();
    expect(limiter.tryAcquire("uid:alice")).not.toBeNull();
  });

  it("上限を数える単位は、ログインしていれば利用者、していなければ IP", () => {
    expect(limitKey("alice", "203.0.113.1")).toBe("uid:alice");
    expect(limitKey(null, "203.0.113.1")).toBe("203.0.113.1");
  });

  it("1人の上限の既定は全体の半分（切り上げ）で、設定で変えられる", () => {
    expect(readConfig({}).maxConcurrentTurnsPerClient).toBe(2);
    expect(readConfig({ MAX_CONCURRENT_TURNS: "5" }).maxConcurrentTurnsPerClient).toBe(3);
    expect(readConfig({ MAX_CONCURRENT_TURNS: "1" }).maxConcurrentTurnsPerClient).toBe(1);
    expect(
      readConfig({ MAX_CONCURRENT_TURNS: "8", MAX_CONCURRENT_TURNS_PER_CLIENT: "1" })
        .maxConcurrentTurnsPerClient,
    ).toBe(1);
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

  it("起動を止める設定の一覧は、そろっている設定と同じ名前を持つ", () => {
    expect(
      Object.keys(complete).filter((name) => name !== "NODE_ENV" && name !== "MATSURI_AGENT_MODE"),
    ).toEqual([...REQUIRED_PRODUCTION_ENV]);
  });

  it("勧める設定が欠けていれば、起動は止めずに名前を挙げる", () => {
    const env = { ...complete, MODEL_STAFF: "model-b", MODEL_GUIDE: " " };
    const config = readConfig(env, here);

    expect(missingRecommendedConfig(config, env)).toEqual([
      "MODEL_CONCIERGE",
      "MODEL_GUIDE",
      "DAILY_CHAT_LIMIT_PER_IP",
      "TRUSTED_PROXY_HOPS",
    ]);
    const filled = {
      ...complete,
      ...Object.fromEntries(RECOMMENDED_PRODUCTION_ENV.map((name) => [name, "1"])),
    };
    expect(missingRecommendedConfig(readConfig(filled, here), filled)).toEqual([]);
  });

  it("勧める設定は、本番の live のときだけ挙げる", () => {
    const mock = { NODE_ENV: "production", MATSURI_AGENT_MODE: "mock" };
    expect(missingRecommendedConfig(readConfig(mock, here), mock)).toEqual([]);
    const dev = { MATSURI_AGENT_MODE: "live" };
    expect(missingRecommendedConfig(readConfig(dev, here), dev)).toEqual([]);
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
