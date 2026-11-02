// サーバーを1つの ESM ファイルにまとめる。
// ワークスペース内のパッケージ（@matsuri-ikoka/*）は TypeScript のまま公開しているので一緒にまとめ、
// それ以外の依存は node_modules から読み込む。
import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const pkg = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8")) as {
  dependencies?: Record<string, string>;
};

const external = Object.keys(pkg.dependencies ?? {}).filter(
  (name) => !name.startsWith("@matsuri-ikoka/"),
);

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external,
  logLevel: "info",
});
