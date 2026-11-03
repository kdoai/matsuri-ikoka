import { describe, expect, it } from "vitest";
import { expectedSize, modelUrl, overallProgress, SHOP_SCENE_MODELS } from "./modelFiles";

describe("overallProgress", () => {
  it("大きさが分かれば、取ったバイト数の割合にする", () => {
    expect(
      overallProgress([
        { loaded: 300, total: 1000, done: false },
        { loaded: 0, total: 3000, done: false },
      ]),
    ).toBeCloseTo(300 / 4000);
  });

  it("取り終えたファイルは、大きさの分だけ数える", () => {
    expect(
      overallProgress([
        { loaded: 1000, total: null, done: true },
        { loaded: 500, total: 1000, done: false },
      ]),
    ).toBeCloseTo(1500 / 2000);
  });

  it("まだ始まっていない・大きさの分からないファイルがあれば、取り終えた数で数える", () => {
    expect(overallProgress([{ loaded: 10, total: 10, done: true }, undefined])).toBe(0.5);
    expect(
      overallProgress([
        { loaded: 10, total: 10, done: true },
        { loaded: 99, total: null, done: false },
      ]),
    ).toBe(0.5);
  });

  it("すべて取り終えたら 1、何もなければ 1", () => {
    expect(overallProgress([{ loaded: 5, total: 5, done: true }])).toBe(1);
    expect(overallProgress([])).toBe(1);
  });
});

describe("店内の画面のモデル", () => {
  it("どのモデルも assets/3d/models にある", () => {
    for (const name of SHOP_SCENE_MODELS) {
      expect(modelUrl(name)).toContain(`${name}.glb`);
    }
  });
});

describe("expectedSize", () => {
  it("圧縮せずに送られたら、Content-Length を使う", () => {
    const headers = new Headers({ "content-length": "1234" });
    expect(expectedSize("/assets/exterior-B7Jhok7d.glb", headers)).toBe(1234);
  });

  it("圧縮して送られたら、モデルの一覧の元の大きさを使う（名前のハッシュは除く）", () => {
    const headers = new Headers({ "content-length": "10", "content-encoding": "br" });
    const size = expectedSize("/assets/motion_look_up-R0uZ_6-G.glb", headers);
    expect(size).toBeGreaterThan(1000);
    expect(expectedSize("/@fs/repo/assets/3d/models/motion_look_up.glb", headers)).toBe(size);
  });

  it("一覧にないファイルは、分からないとする", () => {
    expect(expectedSize("/assets/unknown-abcdefgh.glb", new Headers())).toBeNull();
  });
});
