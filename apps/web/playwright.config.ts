import { defineConfig, devices } from "@playwright/test";

// 画面の通しテスト。画面だけのモックで、記録した相談を最初からしおりまで通す。
// ブラウザは Playwright の Chromium を使う（pnpm exec playwright install chromium）。
// 手元の Chrome で走らせるときは PLAYWRIGHT_CHANNEL=chrome を付ける。

const port = Number(process.env.E2E_PORT ?? 5179);
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
  webServer: {
    command: `pnpm exec vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
