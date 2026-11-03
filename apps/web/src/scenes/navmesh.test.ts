import { describe, expect, it } from "vitest";
import {
  clearWalkable,
  createNavGrid,
  createNavMesh,
  createObstacles,
  findPath,
  gridWalkable,
  lineOfSight,
  meshWalkable,
  nearestClear,
  nearestOnNavMesh,
  onNavMesh,
  onObstacle,
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
    const moved = slideMove(meshWalkable(square), { x: 1, z: 1 }, 0.3, -0.2);
    expect(moved.x).toBeCloseTo(1.3);
    expect(moved.z).toBeCloseTo(0.8);
  });

  it("床の外へ斜めに進むと、縁まで進んでから壁に沿って滑る", () => {
    const moved = slideMove(meshWalkable(square), { x: 1.9, z: 1 }, 0.3, 0.2);
    expect(moved.x).toBeGreaterThan(1.9);
    expect(moved.x).toBeLessThanOrEqual(2);
    expect(moved.z).toBeCloseTo(1.2);
  });

  it("角に向かって進むと、角で止まり、床から出ない", () => {
    const moved = slideMove(meshWalkable(square), { x: 1.95, z: 1.95 }, 0.2, 0.2);
    expect(onNavMesh(square, moved.x, moved.z)).toBe(true);
    expect(moved.x).toBeLessThanOrEqual(2);
    expect(moved.z).toBeLessThanOrEqual(2);
  });

  it("縁から体の太さぶん削った升目で動くと、体が縁に重ならない", () => {
    const body = gridWalkable(createNavGrid(square, 0.02, 0.12));
    const moved = slideMove(body, { x: 1, z: 1 }, 2, 0);
    expect(moved.x).toBeLessThanOrEqual(2 - 0.12 + 0.02);
    expect(moved.x).toBeGreaterThan(1.8);
  });

  it("一度に長く進んでも、細い隙間（床のない帯）を飛び越えない", () => {
    // x 0〜1 と x 1.1〜2 の2枚の床。間の 0.1 m は床がない
    const split = createNavMesh([
      0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1.1, 0, 0, 2, 0, 0, 2, 0, 1, 1.1, 0, 0,
      2, 0, 1, 1.1, 0, 1,
    ]);
    const moved = slideMove(meshWalkable(split), { x: 0.9, z: 0.5 }, 0.5, 0);
    expect(moved.x).toBeLessThanOrEqual(1);
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

describe("体の太さと角", () => {
  // L 字の床：下の帯（x 0〜2、z 0〜1）と、左の帯（x 0〜1、z 1〜2）。内側の角は (1, 1)
  const l = rectangles([0, 0, 2, 1], [0, 1, 1, 2]);
  const body = gridWalkable(createNavGrid(l, 0.02, 0.12));
  // 段のある床：x 0〜1 は z 0.2〜1、x 1〜2 は z 0〜1（左の下が少し狭い）
  const step = rectangles([0, 0.2, 1, 1], [1, 0, 2, 1]);
  const stepBody = gridWalkable(createNavGrid(step, 0.02, 0.12));

  it("内側の角のそばでも、引っかからずに進める", () => {
    let at = { x: 1.5, z: 0.5 };
    for (let i = 0; i < 40; i++) at = slideMove(body, at, -0.03, 0.03);
    expect(at.x).toBeLessThan(0.9);
    expect(at.z).toBeGreaterThan(1.1);
  });

  it("壁にまっすぐ押し付けても、体は床の縁にめり込まない", () => {
    let at = { x: 1.5, z: 0.5 };
    for (let i = 0; i < 40; i++) at = slideMove(body, at, 0, 0.03);
    expect(at.z).toBeLessThanOrEqual(1 - 0.12 + 0.02);
  });

  it("縁に段があっても、斜めに押しながら壁に沿って進める", () => {
    let at = { x: 1.8, z: 0.2 };
    for (let i = 0; i < 80; i++) at = slideMove(stepBody, at, -0.03, -0.008);
    expect(at.x).toBeLessThan(0.5);
  });

  it("いまの位置が升目の外でも、床の上なら抜け出せる", () => {
    const moved = slideMove(body, { x: 1.99, z: 0.5 }, -0.2, 0, meshWalkable(l));
    expect(moved.x).toBeLessThan(1.9);
  });
});

/** 水平な長方形（高さ y）を、2つの三角形の頂点の並び（x, y, z）にする */
function slab(x0: number, z0: number, x1: number, z1: number, y: number): number[] {
  // biome-ignore format: 頂点の並び
  return [
    x0, y, z0, x1, y, z0, x1, y, z1,
    x0, y, z0, x1, y, z1, x0, y, z1,
  ];
}

describe("床に穴の開いていない家具", () => {
  // 2m × 2m の床の真ん中に、脚の間が空いたベンチ（座面は高さ 0.4 m、x: 0.6〜1.4、z: 0.9〜1.1）。
  // 床は脚だけをよけて作ってあり、座面の下は床のまま
  const bench = createObstacles(slab(0.6, 0.9, 1.4, 1.1, 0.4), 0.08, 0.45, 0.2);

  it("体の高さにかかる三角形だけを家具とする（じゅうたんや棚の上の物は含めない）", () => {
    const obstacles = createObstacles(
      [...slab(0, 0, 2, 2, 0.006), ...slab(0.6, 0.9, 1.4, 1.1, 0.4), ...slab(0, 0, 2, 0.3, 1.5)],
      0.08,
      0.45,
      0,
    );
    expect(onObstacle(obstacles, 1, 1)).toBe(true);
    expect(onObstacle(obstacles, 1, 0.5)).toBe(false);
    expect(onObstacle(obstacles, 1, 0.1)).toBe(false);
  });

  it("家具から margin のうちは家具にかかるとする", () => {
    expect(onObstacle(bench, 1, 1)).toBe(true);
    expect(onObstacle(bench, 1, 0.75)).toBe(true);
    expect(onObstacle(bench, 1, 0.65)).toBe(false);
    expect(onObstacle(bench, 0.45, 1)).toBe(true);
    expect(onObstacle(bench, 0.35, 1)).toBe(false);
  });

  it("家具がなければ、どこも家具にかからない", () => {
    const none = createObstacles(slab(0, 0, 2, 2, 0.006), 0.08, 0.45, 0.2);
    expect(onObstacle(none, 1, 1)).toBe(false);
    expect(onNavMesh(none.shape, 1, 1)).toBe(false);
  });

  it("升目から家具の下を除くので、座面の下を通り抜けられない", () => {
    const before = gridWalkable(createNavGrid(square, 0.03, 0.12));
    const after = gridWalkable(createNavGrid(square, 0.03, 0.12, bench));
    expect(before(1, 1)).toBe(true);
    expect(after(1, 1)).toBe(false);
    // ベンチの手前からまっすぐ押しても、座面の手前で止まる
    const moved = slideMove(after, { x: 1, z: 0.4 }, 0, 1.2);
    expect(moved.z).toBeLessThan(0.9 - 0.2);
  });

  it("道は家具を回り込む", () => {
    const grid = createNavGrid(square, 0.1, 0.1, bench);
    expect(lineOfSight(grid, { x: 1, z: 0.4 }, { x: 1, z: 1.6 })).toBe(false);
    const path = findPath(grid, { x: 1, z: 0.4 }, { x: 1, z: 1.6 });
    expect(path.length).toBeGreaterThan(1);
    expect(path.at(-1)).toEqual({ x: 1, z: 1.6 });
  });

  it("抜け出すときの床からも、家具の下を除く", () => {
    const floor = clearWalkable(square, bench);
    expect(floor(1, 1)).toBe(false);
    expect(floor(1, 0.5)).toBe(true);
    expect(floor(2.5, 1)).toBe(false);
  });

  it("座面の上の目印には、家具の外のいちばん近いところに立つ", () => {
    const stand = nearestClear(square, bench, 1.2, 1);
    expect(onObstacle(bench, stand.x, stand.z)).toBe(false);
    expect(onNavMesh(square, stand.x, stand.z)).toBe(true);
    // 座面の手前（z が小さいほう）か奥の、真正面に立つ
    expect(stand.x).toBeCloseTo(1.2, 1);
    expect(Math.abs(stand.z - 1)).toBeLessThan(0.35);
  });

  it("家具にかからない点は、床の上のいちばん近い点のまま", () => {
    expect(nearestClear(square, bench, 1, 0.3)).toEqual(nearestOnNavMesh(square, 1, 0.3));
  });
});
