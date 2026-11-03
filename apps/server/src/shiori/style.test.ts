import { describe, expect, it } from "vitest";
import type { Palette } from "./design";
import { shioriStyle } from "./style";

const palette: Palette = {
  coverBg: "#1b2a4a",
  coverInk: "#f6efe0",
  accent: "#b8302a",
  onAccent: "#ffffff",
  soft: "#fbf3e4",
  c1: "#111111",
  c2: "#222222",
  c3: "#333333",
  s1: "#444444",
  s2: "#555555",
  s3: "#666666",
};

/** `@media screen {` の中身（入れ子の波かっこを数えて取り出す） */
function screenBlock(css: string): string {
  const head = "@media screen {";
  const start = css.indexOf(head);
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = start + head.length - 1; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}") depth--;
    if (depth === 0) return css.slice(start + head.length, i);
  }
  throw new Error("@media screen が閉じていない");
}

describe("画面で見るときのしおりの見た目", () => {
  it("用紙の地の色を付けたあとも、表紙は表紙の地の色のまま", () => {
    const block = screenBlock(shioriStyle(palette));
    const sheet = block.search(/\.sheet\s*\{[^}]*background:\s*var\(--paper\)/);
    const cover = block.search(/\.sheet\.cover\s*\{[^}]*background:\s*var\(--cover-bg\)/);
    expect(sheet).toBeGreaterThanOrEqual(0);
    expect(cover).toBeGreaterThan(sheet);
  });
});
