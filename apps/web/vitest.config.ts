import { defineProject } from "vitest/config";

// 画面の単体テスト（ストアとイベントの変換など）。Playwright の e2e/ は含めない
export default defineProject({
  test: {
    name: "web",
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
