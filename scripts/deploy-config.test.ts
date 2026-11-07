import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RECOMMENDED_PRODUCTION_ENV, REQUIRED_PRODUCTION_ENV } from "../apps/server/src/config";
import { TURN_MAX_MS } from "../apps/server/src/routes/turnStream";

// デプロイ（deploy.yml）で版ごとに決める設定が、サーバーの決まりと食い違わないことを確かめる。

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
const deploy = read(".github/workflows/deploy.yml");

/** Cloud Run のリクエストの時間切れの上限（秒） */
const CLOUD_RUN_MAX_TIMEOUT_SECONDS = 3600;

describe("リクエストの時間切れ", () => {
  const seconds = Number(/^ {6}REQUEST_TIMEOUT_SECONDS: "(\d+)"$/m.exec(deploy)?.[1]);

  it("相談1回の全体の上限のあとに、時間切れの案内と done を送り終える時間を残す", () => {
    expect(seconds * 1000).toBeGreaterThanOrEqual(TURN_MAX_MS + 30_000);
    expect(seconds).toBeLessThanOrEqual(CLOUD_RUN_MAX_TIMEOUT_SECONDS);
  });

  it("新しい版を置くときに、版の時間切れを決め直す", () => {
    expect(deploy).toContain('--timeout "$REQUEST_TIMEOUT_SECONDS"');
  });
});

describe("利用者の IP の決め方", () => {
  it("新しい版を置くときに TRUSTED_PROXY_HOPS を付け、変数がなければ Cloud Run の既定の URL の 1 にする", () => {
    expect(deploy).toMatch(
      /^ {6}TRUSTED_PROXY_HOPS: \$\{\{ vars\.TRUSTED_PROXY_HOPS \|\| '1' \}\}$/m,
    );
    expect(deploy).toMatch(
      /--update-env-vars "[^"]*TRUSTED_PROXY_HOPS=\$\{TRUSTED_PROXY_HOPS\}[^"]*"/,
    );
  });
});

describe("本番の設定の不足", () => {
  const listed = JSON.parse(read("scripts/lib/production-env.json")) as {
    required: string[];
    recommended: string[];
  };

  it("外からの確かめが見る設定の一覧は、サーバーの起動の決まりと同じ", () => {
    expect(listed.required).toEqual([...REQUIRED_PRODUCTION_ENV]);
    expect(listed.recommended).toEqual([...RECOMMENDED_PRODUCTION_ENV]);
  });

  it("外からの確かめに、サービスに設定してある環境変数の名前を渡す", () => {
    const checks = deploy.match(/node scripts\/check-deployed\.mjs "\$url"/g) ?? [];
    const names =
      deploy.match(/SERVICE_ENV_NAMES: \$\{\{ steps\.passcode\.outputs\.names \}\}/g) ?? [];
    expect(checks.length).toBe(2);
    expect(names.length).toBe(checks.length);
  });
});
