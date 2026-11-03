import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// 画面はいつも接客サーバーと話す。開発中は /api と /shiori を接客サーバー（apps/server）へ中継する
const serverOrigin = process.env.MATSURI_SERVER_ORIGIN ?? "http://localhost:8787";

/** 3D の店が読む GLB。ないままビルドすると、画面が 2D に落ちるので、ビルドを止める */
const REQUIRED_MODELS = ["interior", "exterior", "player_penguin", "staff_hiyoko"];

function requireModels(): Plugin {
  return {
    name: "matsuri:require-3d-models",
    apply: "build",
    buildStart() {
      const missing = REQUIRED_MODELS.filter(
        (name) =>
          !existsSync(
            fileURLToPath(new URL(`../../assets/3d/models/${name}.glb`, import.meta.url)),
          ),
      );
      if (missing.length > 0) {
        this.error(
          `3D のモデルがありません（assets/3d/models）：${missing.map((name) => `${name}.glb`).join("、")}`,
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), requireModels()],
  server: {
    proxy: {
      "/api": serverOrigin,
      "/shiori": serverOrigin,
      "/healthz": serverOrigin,
    },
  },
  preview: {
    proxy: {
      "/api": serverOrigin,
      "/shiori": serverOrigin,
    },
  },
});
