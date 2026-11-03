import { describe, expect, it } from "vitest";
import {
  createNavGrid,
  createNavMesh,
  findPath,
  lineOfSight,
  nearestOnNavMesh,
  onNavMesh,
  slideMove,
} from "./navmesh";

// 2m × 2m の正方形の床（x: 0〜2、z: 0〜2）。2つの三角形でできている
const square = createNavMesh(
  // biome-ignore format: 頂点の並び
  [
    0, 0, 0,
    2, 0, 0,
    2, 0, 2,
    0, 0, 2,
  ],
  [0, 1, 2, 0, 2, 3],
);

describe("歩ける床", () => {
  it("三角形の上だけを床とする", () => {
    expect(onNavMesh(square, 1, 1)).toBe(true);
    expect(onNavMesh(square, 0.1, 1.9)).toBe(true);
    expect(onNavMesh(square, 2.1, 1)).toBe(false);
    expect(onNavMesh(square, -0.1, 1)).toBe(false);
  });

  it("index がなければ、3頂点ずつを三角形にする", () => {
    const mesh = createNavMesh([0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(onNavMesh(mesh, 0.2, 0.2)).toBe(true);
    expect(onNavMesh(mesh, 0.8, 0.8)).toBe(false);
  });

  it("床の中ではそのまま進む", () => {
    expect(slideMove(square, { x: 1, z: 1 }, 0.3, -0.2)).toEqual({ x: 1.3, z: 0.8 });
  });

  it("床の外へ斜めに進むと、壁に沿って滑る", () => {
    const moved = slideMove(square, { x: 1.9, z: 1 }, 0.3, 0.2);
    expect(moved.x).toBe(1.9);
    expect(moved.z).toBeCloseTo(1.2);
  });

  it("角に向かって進むと、その場に止まる", () => {
    expect(slideMove(square, { x: 1.95, z: 1.95 }, 0.2, 0.2)).toEqual({ x: 1.95, z: 1.95 });
  });

  it("床の外の点は、床の縁のいちばん近い点に寄せる", () => {
    const near = nearestOnNavMesh(square, 3, 1);
    expect(near.x).toBeCloseTo(2, 3);
    expect(near.z).toBeCloseTo(1, 3);
    expect(onNavMesh(square, near.x, near.z)).toBe(true);
    expect(nearestOnNavMesh(square, 1, 1)).toEqual({ x: 1, z: 1 });
  });
});

/** 長方形を並べた床（x0, z0, x1, z1 の並び） */
function rectangles(...rects: [number, number, number, number][]) {
  const positions: number[] = [];
  for (const [x0, z0, x1, z1] of rects) {
    positions.push(x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z0, x1, 0, z1, x0, 0, z1);
  }
  return createNavMesh(positions);
}

describe("道を探す", () => {
  // コの字の床：左の通路（x 0〜1）・下の通路（z 3〜4）・右の通路（x 3〜4）。真ん中は通れない
  const u = rectangles([0, 0, 1, 4], [0, 3, 4, 4], [3, 0, 4, 4]);
  const grid = createNavGrid(u, 0.1);

  it("通れない真ん中を見通せない", () => {
    expect(lineOfSight(grid, { x: 0.5, z: 0.5 }, { x: 3.5, z: 0.5 })).toBe(false);
    expect(lineOfSight(grid, { x: 0.5, z: 0.5 }, { x: 0.5, z: 3.5 })).toBe(true);
  });

  it("見通せるときは、まっすぐ目的地へ行く", () => {
    expect(findPath(grid, { x: 0.5, z: 0.5 }, { x: 0.5, z: 2 })).toEqual([{ x: 0.5, z: 2 }]);
  });

  it("通れない場所は回り込み、曲がり角だけを通る", () => {
    const path = findPath(grid, { x: 0.5, z: 0.5 }, { x: 3.5, z: 0.5 });
    expect(path.length).toBeGreaterThanOrEqual(2);
    expect(path.length).toBeLessThanOrEqual(4);
    expect(path.at(-1)).toEqual({ x: 3.5, z: 0.5 });
    // どの区間も床の上だけを通る
    let from = { x: 0.5, z: 0.5 };
    for (const point of path) {
      expect(lineOfSight(grid, from, point)).toBe(true);
      from = point;
    }
  });

  it("床の外を目指すと、いちばん近い床まで行く", () => {
    const path = findPath(grid, { x: 0.5, z: 0.5 }, { x: 2, z: 1 });
    const last = path.at(-1);
    expect(last).toBeDefined();
    expect(onNavMesh(u, last?.x ?? -1, last?.z ?? -1)).toBe(true);
  });
});
