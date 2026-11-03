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

/**
 * 画面が読む素材。ないままビルドすると、3D の店は 2D に落ち、会話の窓の顔は空の丸になるので、ビルドを止める
 * （顔の絵は src/ui/Portraits.tsx が import.meta.glob で拾うので、ないとエラーにならずに消える）
 */
const REQUIRED_ASSETS = [
  ...["interior", "exterior", "player_penguin", "staff_hiyoko"].map(
    (name) => `3d/models/${name}.glb`,
  ),
  ...["hiyoko", "owl", "hen", "sparrow", "penguin"].map((name) => `shiori/staff/face_${name}.webp`),
];

function requireAssets(): Plugin {
  return {
    name: "matsuri:require-assets",
    apply: "build",
    buildStart() {
      const missing = REQUIRED_ASSETS.filter(
        (file) => !existsSync(fileURLToPath(new URL(`../../assets/${file}`, import.meta.url))),
      );
      if (missing.length > 0) {
        this.error(`画面の素材がありません（assets）：${missing.join("、")}`);
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
  plugins: [react(), tailwindcss(), requireAssets(), precompress()],
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
