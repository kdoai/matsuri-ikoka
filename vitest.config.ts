import { defineConfig } from "vitest/config";

// ワークスペースの各パッケージと scripts/ を1つずつのプロジェクトとして、まとめてテストする
export default defineConfig({
  test: {
    projects: ["apps/*", "packages/*", "scripts"],
  },
});
