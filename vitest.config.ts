import { defineConfig } from "vitest/config";

// ワークスペースの各パッケージを1つのプロジェクトとして、まとめてテストする
export default defineConfig({
  test: {
    projects: ["apps/*", "packages/*"],
  },
});
