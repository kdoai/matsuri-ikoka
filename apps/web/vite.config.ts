import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
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

/** 圧縮して送るファイル。woff2・webp などはすでに圧縮されているので除く */
const COMPRESSIBLE = /\.(?:js|mjs|css|html|svg|json|glb|wasm|txt)$/;

/**
 * ビルドしたファイルの隣に、圧縮済みの .br と .gz を置く。接客サーバーはブラウザが受け取れる方を返す。
 * GLB は meshopt で詰めたあとでも、さらに半分ほどになる（meshopt はこのあとに圧縮をかける前提の形）
 */
function precompress(): Plugin {
  let outDir = "";
  return {
    name: "matsuri:precompress",
    apply: "build",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const files = (await readdir(outDir, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile() && COMPRESSIBLE.test(entry.name))
        .map((entry) => path.join(entry.parentPath, entry.name));
      await Promise.all(
        files.map(async (file) => {
          const data = await readFile(file);
          if (data.byteLength < 1024) return;
          const [br, gz] = await Promise.all([
            promisify(brotliCompress)(data, {
              params: {
                [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
                [constants.BROTLI_PARAM_SIZE_HINT]: data.byteLength,
              },
            }),
            promisify(gzip)(data, { level: constants.Z_BEST_COMPRESSION }),
          ]);
          // ほとんど縮まないものは置かない（そのまま送る）
          if (br.byteLength < data.byteLength * 0.95) await writeFile(`${file}.br`, br);
          if (gz.byteLength < data.byteLength * 0.95) await writeFile(`${file}.gz`, gz);
        }),
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), requireModels(), precompress()],
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
