import { describe, expect, it } from "vitest";
import type { Palette } from "./design";
import { screenScaleRules, shioriStyle } from "./style";

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

describe("しおりの見た目", () => {
  it("どのページも和紙の色の紙にし、表紙の風景の空は表紙の地の色（夜の祭りは夜空）にする", () => {
    const css = shioriStyle(palette);
    expect(css).toMatch(/\.sheet\s*\{[^}]*background:\s*var\(--paper\)/);
    expect(css).toMatch(
      /\.cover \.scene \{[^}]*background:\s*linear-gradient\([^)]*var\(--cover-bg\)/,
    );
  });

  it("印刷・PDF・画面のどれでも、どのページも A4 の同じ大きさの紙にする", () => {
    const css = shioriStyle(palette);
    expect(css).toContain("@page { size: A4; margin: 0; }");
    // 表紙だけ余白を変えるような、名前つきのページの決まりは作らない
    expect(css).not.toMatch(/@page\s+\w+/);
    expect(css).toMatch(/\.page \{ width: 210mm; height: 297mm;/);
  });

  it("画面では、見開きの置き場に収まるいちばん大きな縮尺にする（広いほど大きく、あとの規則が勝つ）", () => {
    const pattern =
      /orientation: landscape\) and \(min-width: (\d+)px\) and \(min-height: (\d+)px\) \{ \.page \{ zoom: ([\d.]+); \}/g;
    const landscape = [...screenScaleRules().matchAll(pattern)].map((m) => ({
      w: Number(m[1]),
      h: Number(m[2]),
      z: Number(m[3]),
    }));
    expect(landscape.length).toBeGreaterThan(10);
    landscape.slice(1).forEach((b, i) => {
      const a = landscape[i] as (typeof landscape)[number];
      expect(b.z).toBeGreaterThan(a.z);
      expect(b.w).toBeGreaterThanOrEqual(a.w);
      expect(b.h).toBeGreaterThanOrEqual(a.h);
    });
    // 等倍（z = 1）は、見開き（420mm = 約 1587px）とめくる矢印が収まる幅から
    expect(landscape.find((r) => r.z === 1)?.w).toBeGreaterThan(1587);
  });
});
