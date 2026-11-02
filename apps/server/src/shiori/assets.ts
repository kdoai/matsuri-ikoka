import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { findRepoRoot } from "../config";

// しおりの素材（assets/shiori）。SVG は1つの <symbol> の束にしてページに埋め込み、
// フォントとスタッフの静止画は、しおりの URL の下（/shiori/assets/…）から配る。PDF を作るときも外へは取りに行かない。

export interface ShioriAsset {
  body: Buffer;
  contentType: string;
}

export interface ShioriAssets {
  /** ページの先頭に置く、すべての SVG の <symbol>（id は「s-」＋ファイル名） */
  sprite: string;
  /** symbol の名前（ファイル名から .svg を除いたもの） */
  symbols: ReadonlySet<string>;
  /** /shiori/assets/ の下のパス（fonts/…・staff/…）ごとのファイル */
  files: ReadonlyMap<string, ShioriAsset>;
}

const CONTENT_TYPES: Record<string, string> = {
  ".woff2": "font/woff2",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
};

// 自分で書いた素材だけを置くが、念のため動きや外への参照を持つ SVG は読み込まない
const UNSAFE_SVG =
  /<script|<foreignObject|<image|\bon[a-z]+\s*=|href\s*=|url\s*\(|<!ENTITY|<style/i;

/** 素材の置き場所。MATSURI_SHIORI_ASSETS_DIR か、リポジトリの assets/shiori */
export function defaultAssetsDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.MATSURI_SHIORI_ASSETS_DIR?.trim();
  return configured
    ? path.resolve(configured)
    : path.join(findRepoRoot(process.cwd()), "assets", "shiori");
}

export function svgToSymbol(name: string, svg: string): string {
  if (UNSAFE_SVG.test(svg)) throw new Error(`SVG に使えない要素があります：${name}`);
  const match = /<svg\b[^>]*\bviewBox="([^"]+)"[^>]*>([\s\S]*)<\/svg>\s*$/.exec(svg.trim());
  if (match === null) throw new Error(`SVG の形が読めません：${name}`);
  return `<symbol id="s-${name}" viewBox="${match[1]}">${(match[2] ?? "").trim()}</symbol>`;
}

export function loadShioriAssets(dir: string = defaultAssetsDir()): ShioriAssets {
  const svgDir = path.join(dir, "svg");
  const names = readdirSync(svgDir)
    .filter((f) => f.endsWith(".svg"))
    .sort();
  const symbols = names.map((f) =>
    svgToSymbol(f.slice(0, -4), readFileSync(path.join(svgDir, f), "utf8")),
  );
  const files = new Map<string, ShioriAsset>();
  for (const sub of ["fonts", "staff"]) {
    for (const file of readdirSync(path.join(dir, sub)).sort()) {
      const contentType = CONTENT_TYPES[path.extname(file)];
      if (contentType === undefined) continue;
      files.set(`${sub}/${file}`, { body: readFileSync(path.join(dir, sub, file)), contentType });
    }
  }
  return {
    sprite: `<svg xmlns="http://www.w3.org/2000/svg" class="sprite" aria-hidden="true">${symbols.join("")}</svg>`,
    symbols: new Set(names.map((f) => f.slice(0, -4))),
    files,
  };
}
