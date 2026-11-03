import { defineConfig, devices } from "@playwright/test";

// 画面の通しテスト。接客サーバーを mock（記録した相談の再生）で立ち上げ、画面をそこにつないで、
// 記録した架空の相談を最初からしおりまで通す。AI の部分だけが記録で、画面と通信は本物。
// ブラウザは Playwright の Chromium を使う（pnpm exec playwright install chromium）。
// 手元の Chrome で走らせるときは PLAYWRIGHT_CHANNEL=chrome を付ける。

const port = Number(process.env.E2E_PORT ?? 5179);
const serverPort = Number(process.env.E2E_SERVER_PORT ?? 8797);
const channel = process.env.PLAYWRIGHT_CHANNEL || undefined;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results/output",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${port}`,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, channel },
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"], channel },
    },
  ],
  webServer: [
    {
      // 接客サーバー（mock）。記録の間隔を半分にして流す
      command: "pnpm --filter @matsuri-ikoka/server exec tsx src/index.ts",
      url: `http://localhost:${serverPort}/healthz`,
      env: {
        PORT: String(serverPort),
        MATSURI_AGENT_MODE: "mock",
        MATSURI_REPLAY_SPEED: "2",
      },
      stdout: "pipe",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `pnpm exec vite --port ${port} --strictPort`,
      url: `http://localhost:${port}`,
      env: { MATSURI_SERVER_ORIGIN: `http://localhost:${serverPort}` },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
