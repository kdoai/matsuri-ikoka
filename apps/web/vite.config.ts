import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 開発中は API を接客サーバー（apps/server）へ中継する
const serverOrigin = process.env.MATSURI_SERVER_ORIGIN ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": serverOrigin,
      "/shiori": serverOrigin,
      "/healthz": serverOrigin,
    },
  },
});
