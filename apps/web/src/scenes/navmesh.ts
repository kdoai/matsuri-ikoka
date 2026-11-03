// 歩ける床（interior.glb の nav.customer）の判定。床の三角形を真上から見た平面（x, z）で扱う。
// 旅人が進めるのは、この三角形の上だけ。three.js には依存しない。

export interface FlatPoint {
  x: number;
  z: number;
}

export interface NavMesh {
  /** 三角形ごとに x0, z0, x1, z1, x2, z2 */
  triangles: Float64Array;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** 区画（BUCKET m 四方）ごとの、重なる三角形の位置（triangles の添字）。判定を速くする */
  buckets: Map<number, number[]>;
}

/** 三角形を引く区画の大きさ（m） */
const BUCKET = 0.5;

function bucketKey(column: number, row: number): number {
  return column * 4096 + row;
}

/**
 * 頂点の座標（x, y, z の並び。ワールド座標）と、三角形の頂点の番号から、歩ける床を作る。
 * index がなければ、3頂点ずつを1つの三角形にする。
 */
export function createNavMesh(positions: ArrayLike<number>, index?: ArrayLike<number>): NavMesh {
  const count =
    index === undefined ? Math.floor(positions.length / 9) : Math.floor(index.length / 3);
  const triangles = new Float64Array(count * 6);
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let t = 0; t < count; t++) {
    for (let v = 0; v < 3; v++) {
      const vertex = index === undefined ? t * 3 + v : (index[t * 3 + v] ?? 0);
      const x = positions[vertex * 3] ?? 0;
      const z = positions[vertex * 3 + 2] ?? 0;
      triangles[t * 6 + v * 2] = x;
      triangles[t * 6 + v * 2 + 1] = z;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
  }
  const buckets = new Map<number, number[]>();
  for (let o = 0; o < triangles.length; o += 6) {
    const xs = [triangles[o] ?? 0, triangles[o + 2] ?? 0, triangles[o + 4] ?? 0];
    const zs = [triangles[o + 1] ?? 0, triangles[o + 3] ?? 0, triangles[o + 5] ?? 0];
    const c0 = Math.floor((Math.min(...xs) - minX) / BUCKET);
    const c1 = Math.floor((Math.max(...xs) - minX) / BUCKET);
    const r0 = Math.floor((Math.min(...zs) - minZ) / BUCKET);
    const r1 = Math.floor((Math.max(...zs) - minZ) / BUCKET);
    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) {
        const key = bucketKey(c, r);
        const list = buckets.get(key);
        if (list === undefined) buckets.set(key, [o]);
        else list.push(o);
      }
    }
  }
  return { triangles, minX, maxX, minZ, maxZ, buckets };
}

const EPSILON = 1e-9;

function inTriangle(tri: Float64Array, o: number, x: number, z: number): boolean {
  const ax = tri[o] ?? 0;
  const az = tri[o + 1] ?? 0;
  const bx = tri[o + 2] ?? 0;
  const bz = tri[o + 3] ?? 0;
  const cx = tri[o + 4] ?? 0;
  const cz = tri[o + 5] ?? 0;
  const d1 = (x - bx) * (az - bz) - (ax - bx) * (z - bz);
  const d2 = (x - cx) * (bz - cz) - (bx - cx) * (z - cz);
  const d3 = (x - ax) * (cz - az) - (cx - ax) * (z - az);
  const negative = d1 < -EPSILON || d2 < -EPSILON || d3 < -EPSILON;
  const positive = d1 > EPSILON || d2 > EPSILON || d3 > EPSILON;
  return !(negative && positive);
}

/** その点が歩ける床の上か */
export function onNavMesh(mesh: NavMesh, x: number, z: number): boolean {
  if (x < mesh.minX || x > mesh.maxX || z < mesh.minZ || z > mesh.maxZ) return false;
  const list = mesh.buckets.get(
    bucketKey(Math.floor((x - mesh.minX) / BUCKET), Math.floor((z - mesh.minZ) / BUCKET)),
  );
  if (list === undefined) return false;
  for (const o of list) {
    if (inTriangle(mesh.triangles, o, x, z)) return true;
  }
  return false;
}

function closestOnSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): FlatPoint {
  const dx = bx - ax;
  const dz = bz - az;
  const length = dx * dx + dz * dz;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / length));
  return { x: ax + dx * t, z: az + dz * t };
}

/** 歩ける床の上で、その点にいちばん近い点（床の上ならその点のまま） */
export function nearestOnNavMesh(mesh: NavMesh, x: number, z: number): FlatPoint {
  if (onNavMesh(mesh, x, z)) return { x, z };
  const { triangles } = mesh;
  let best: FlatPoint = { x, z };
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let o = 0; o < triangles.length; o += 6) {
    for (let e = 0; e < 3; e++) {
      const a = o + e * 2;
      const b = o + ((e + 1) % 3) * 2;
      const point = closestOnSegment(
        x,
        z,
        triangles[a] ?? 0,
        triangles[a + 1] ?? 0,
        triangles[b] ?? 0,
        triangles[b + 1] ?? 0,
      );
      const distance = (point.x - x) ** 2 + (point.z - z) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = point;
      }
    }
  }
  // 縁のちょうど上は、丸めの誤差で外に出ることがあるので、内側へ少しだけ寄せる
  const inward = 1e-4;
  const dx = x - best.x;
  const dz = z - best.z;
  const length = Math.hypot(dx, dz);
  if (length > 0) {
    const nudged = { x: best.x - (dx / length) * inward, z: best.z - (dz / length) * inward };
    if (onNavMesh(mesh, nudged.x, nudged.z)) return nudged;
  }
  return best;
}

// ---------------------------------------------------------------------------
// 歩ける床に穴の開いていない家具。床は家具の脚だけをよけて作ってあるので、ベンチの座面や
// 台の天板のように、脚と脚の間が体の高さでふさがっている家具は、店内の形から足してよける。

export interface Obstacles {
  /** 体の高さにある三角形を、真上から見たもの */
  shape: NavMesh;
  /** 三角形からこの距離（m）のうちには立てない */
  margin: number;
}

/**
 * 店内の三角形（x, y, z の並び。3頂点ずつ。ワールド座標）のうち、高さが low〜high（m）に
 * かかるものを、家具の形とする。
 */
export function createObstacles(
  positions: ArrayLike<number>,
  low: number,
  high: number,
  margin: number,
): Obstacles {
  const kept: number[] = [];
  for (let o = 0; o + 8 < positions.length; o += 9) {
    const y0 = positions[o + 1] ?? 0;
    const y1 = positions[o + 4] ?? 0;
    const y2 = positions[o + 7] ?? 0;
    if (Math.max(y0, y1, y2) < low || Math.min(y0, y1, y2) > high) continue;
    for (let i = 0; i < 9; i++) kept.push(positions[o + i] ?? 0);
  }
  return { shape: createNavMesh(kept), margin };
}

/** 三角形（triangles の o から）と点の、真上から見た距離が d 以下か */
function withinTriangle(tri: Float64Array, o: number, x: number, z: number, d: number): boolean {
  if (inTriangle(tri, o, x, z)) return true;
  for (let e = 0; e < 3; e++) {
    const a = o + e * 2;
    const b = o + ((e + 1) % 3) * 2;
    const point = closestOnSegment(
      x,
      z,
      tri[a] ?? 0,
      tri[a + 1] ?? 0,
      tri[b] ?? 0,
      tri[b + 1] ?? 0,
    );
    if ((point.x - x) ** 2 + (point.z - z) ** 2 <= d * d) return true;
  }
  return false;
}

/** その点が家具にかかるか（家具から margin のうちか） */
export function onObstacle(obstacles: Obstacles, x: number, z: number): boolean {
  const { shape, margin } = obstacles;
  if (shape.triangles.length === 0) return false;
  if (
    x < shape.minX - margin ||
    x > shape.maxX + margin ||
    z < shape.minZ - margin ||
    z > shape.maxZ + margin
  ) {
    return false;
  }
  const c0 = Math.floor((x - margin - shape.minX) / BUCKET);
  const c1 = Math.floor((x + margin - shape.minX) / BUCKET);
  const r0 = Math.floor((z - margin - shape.minZ) / BUCKET);
  const r1 = Math.floor((z + margin - shape.minZ) / BUCKET);
  for (let c = c0; c <= c1; c++) {
    for (let r = r0; r <= r1; r++) {
      for (const o of shape.buckets.get(bucketKey(c, r)) ?? []) {
        if (withinTriangle(shape.triangles, o, x, z, margin)) return true;
      }
    }
  }
  return false;
}

/** 歩ける床の上で、家具にかからないところ */
export function clearWalkable(mesh: NavMesh, obstacles: Obstacles): Walkable {
  return (x, z) => onNavMesh(mesh, x, z) && !onObstacle(obstacles, x, z);
}

/** 歩ける床の上で、その点にいちばん近い、家具にかからない点 */
export function nearestClear(mesh: NavMesh, obstacles: Obstacles, x: number, z: number): FlatPoint {
  const near = nearestOnNavMesh(mesh, x, z);
  if (!onObstacle(obstacles, near.x, near.z)) return near;
  // 家具にかかるときは、まわりを 5 cm 刻みで広げて、床の上で家具から離れた点を探す。
  // 斜めの升は遠いので、見つけてからも少し先まで広げて、いちばん近い点にする
  const step = 0.05;
  let best: FlatPoint | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let last = 40;
  for (let ring = 1; ring <= last; ring++) {
    for (let i = -ring; i <= ring; i++) {
      for (let j = -ring; j <= ring; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
        const px = near.x + i * step;
        const pz = near.z + j * step;
        if (!onNavMesh(mesh, px, pz) || onObstacle(obstacles, px, pz)) continue;
        const distance = (px - x) ** 2 + (pz - z) ** 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = { x: px, z: pz };
        }
      }
    }
    if (best !== null && last === 40) last = Math.min(40, Math.ceil(ring * Math.SQRT2) + 1);
  }
  return best ?? near;
}

// ---------------------------------------------------------------------------
// 道を探す（タップした場所へ、家具をよけて歩く）。床を細かい升目にして A* で探し、
// 見通せる升目は飛ばして、曲がり角だけの道にする。

export interface NavGrid {
  cell: number;
  originX: number;
  originZ: number;
  columns: number;
  rows: number;
  /** 1 なら歩ける升目 */
  walkable: Uint8Array;
}

/**
 * 床を cell（m）四方の升目にする。升目の中心が床の上なら歩ける（obstacles を渡すと、家具にかかる升目は除く）。
 * clearance（m）を渡すと、その距離のうちに歩けない升目がある升目も歩けないことにする（体の太さ）
 */
export function createNavGrid(
  mesh: NavMesh,
  cell = 0.1,
  clearance = 0,
  obstacles?: Obstacles,
): NavGrid {
  const originX = mesh.minX;
  const originZ = mesh.minZ;
  const columns = Math.max(1, Math.ceil((mesh.maxX - mesh.minX) / cell));
  const rows = Math.max(1, Math.ceil((mesh.maxZ - mesh.minZ) / cell));
  const walkable = new Uint8Array(columns * rows);
  const { triangles } = mesh;
  for (let o = 0; o < triangles.length; o += 6) {
    const xs = [triangles[o] ?? 0, triangles[o + 2] ?? 0, triangles[o + 4] ?? 0];
    const zs = [triangles[o + 1] ?? 0, triangles[o + 3] ?? 0, triangles[o + 5] ?? 0];
    const c0 = Math.max(0, Math.floor((Math.min(...xs) - originX) / cell));
    const c1 = Math.min(columns - 1, Math.floor((Math.max(...xs) - originX) / cell));
    const r0 = Math.max(0, Math.floor((Math.min(...zs) - originZ) / cell));
    const r1 = Math.min(rows - 1, Math.floor((Math.max(...zs) - originZ) / cell));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const index = r * columns + c;
        if (walkable[index] === 1) continue;
        if (inTriangle(triangles, o, originX + (c + 0.5) * cell, originZ + (r + 0.5) * cell)) {
          walkable[index] = 1;
        }
      }
    }
  }
  if (obstacles !== undefined) {
    // 家具の三角形ごとに、まわり margin までの升目を確かめて除く
    const { margin } = obstacles;
    const shape = obstacles.shape.triangles;
    for (let o = 0; o < shape.length; o += 6) {
      const xs = [shape[o] ?? 0, shape[o + 2] ?? 0, shape[o + 4] ?? 0];
      const zs = [shape[o + 1] ?? 0, shape[o + 3] ?? 0, shape[o + 5] ?? 0];
      const c0 = Math.max(0, Math.floor((Math.min(...xs) - margin - originX) / cell));
      const c1 = Math.min(columns - 1, Math.floor((Math.max(...xs) + margin - originX) / cell));
      const r0 = Math.max(0, Math.floor((Math.min(...zs) - margin - originZ) / cell));
      const r1 = Math.min(rows - 1, Math.floor((Math.max(...zs) + margin - originZ) / cell));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const index = r * columns + c;
          if (walkable[index] !== 1) continue;
          const x = originX + (c + 0.5) * cell;
          const z = originZ + (r + 0.5) * cell;
          if (withinTriangle(shape, o, x, z, margin)) walkable[index] = 0;
        }
      }
    }
  }
  const reach = Math.round(clearance / cell);
  if (reach <= 0) return { cell, originX, originZ, columns, rows, walkable };
  // 縁から reach 升ぶん削る
  const eroded = new Uint8Array(walkable);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      if (walkable[r * columns + c] !== 1) continue;
      let open = true;
      for (let dr = -reach; dr <= reach && open; dr++) {
        for (let dc = -reach; dc <= reach; dc++) {
          const nr = r + dr;
          const nc = c + dc;
          if (
            nr < 0 ||
            nc < 0 ||
            nr >= rows ||
            nc >= columns ||
            walkable[nr * columns + nc] !== 1
          ) {
            open = false;
            break;
          }
        }
      }
      if (!open) eroded[r * columns + c] = 0;
    }
  }
  return { cell, originX, originZ, columns, rows, walkable: eroded };
}

function cellOf(grid: NavGrid, point: FlatPoint): number | null {
  const c = Math.floor((point.x - grid.originX) / grid.cell);
  const r = Math.floor((point.z - grid.originZ) / grid.cell);
  if (c < 0 || r < 0 || c >= grid.columns || r >= grid.rows) return null;
  return r * grid.columns + c;
}

/** 回り込む先を探る距離（m） */
const PROBE = 0.3;

/**
 * step（x か z の一方の軸）の向きに進めないとき、axis の向きにどれだけずれれば進めるかを、
 * 近いほうから探る。見つかれば、その向きへ length だけずれた位置を返す（ずれる途中も立てるところだけ）
 */
function around(
  fits: Walkable,
  at: FlatPoint,
  step: FlatPoint,
  axis: "x" | "z",
  length: number,
): FlatPoint | null {
  for (let d = length; d <= PROBE + 1e-9; d += length) {
    for (const sign of [1, -1]) {
      const offset = axis === "x" ? { x: sign * d, z: 0 } : { x: 0, z: sign * d };
      if (!fits(at.x + offset.x + step.x, at.z + offset.z + step.z)) continue;
      const move =
        axis === "x" ? { x: at.x + sign * length, z: at.z } : { x: at.x, z: at.z + sign * length };
      if (fits(move.x, move.z)) return move;
    }
  }
  return null;
}

/** その点に立てるか */
export type Walkable = (x: number, z: number) => boolean;

/** 歩ける床の三角形の上なら立てる */
export function meshWalkable(mesh: NavMesh): Walkable {
  return (x, z) => onNavMesh(mesh, x, z);
}

/** 升目（体の太さぶん縁から削ったもの）の上なら立てる */
export function gridWalkable(grid: NavGrid): Walkable {
  return (x, z) => {
    const index = cellOf(grid, { x, z });
    return index !== null && grid.walkable[index] === 1;
  };
}

/** 進めないときに試す、向きのずらし方（ラジアン）。ずらしたぶん遅くなる */
const SLIDE_TURNS = [0.5, -0.5, 1, -1];

/** 1回に確かめる移動の長さ（m）。これより長い移動は刻んで、細い家具を飛び越えないようにする */
const SUBSTEP = 0.03;

/**
 * from から (dx, dz) だけ進む。進めないときは、向きを少しずつずらし、x だけ・z だけを試して、
 * 壁に沿って滑る。どれでも進めなければ、その場に止まる。
 * いまの位置が walkable の外にあるとき（入店して立つ位置が縁に近いなど）は、fallback で確かめて抜け出す。
 */
export function slideMove(
  walkable: Walkable,
  from: FlatPoint,
  dx: number,
  dz: number,
  fallback?: Walkable,
): FlatPoint {
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / SUBSTEP));
  let at: FlatPoint = { x: from.x, z: from.z };
  for (let i = 0; i < steps; i++) {
    const fits = fallback !== undefined && !walkable(at.x, at.z) ? fallback : walkable;
    const sx = dx / steps;
    const sz = dz / steps;
    const turned = SLIDE_TURNS.map((angle) => {
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      return { x: at.x + (sx * cos - sz * sin) * cos, z: at.z + (sx * sin + sz * cos) * cos };
    });
    const ok = (point: FlatPoint) =>
      (point.x !== at.x || point.z !== at.z) && fits(point.x, point.z);
    const length = Math.hypot(sx, sz);
    const next =
      [{ x: at.x + sx, z: at.z + sz }, ...turned.slice(0, 2)].find(ok) ??
      // 押している向きの主な軸で進めないときは、その軸と直角に、どちらへずれれば進めるかを探り、
      // そちらへ回り込む（床の縁の段で、押している向きの逆の成分へ戻って行ったり来たりしない）
      (Math.abs(sx) >= Math.abs(sz)
        ? ((fits(at.x + sx, at.z) ? { x: at.x + sx, z: at.z } : null) ??
          around(fits, at, { x: sx, z: 0 }, "z", length))
        : ((fits(at.x, at.z + sz) ? { x: at.x, z: at.z + sz } : null) ??
          around(fits, at, { x: 0, z: sz }, "x", length))) ??
      [{ x: at.x + sx, z: at.z }, { x: at.x, z: at.z + sz }, ...turned.slice(2)].find(ok);
    if (next === undefined) break;
    at = next;
  }
  return at;
}

/** いちばん近い歩ける升目（その点の升目が歩けなければ、まわりを広げて探す） */
function nearestWalkable(grid: NavGrid, point: FlatPoint): number | null {
  const c0 = Math.min(
    grid.columns - 1,
    Math.max(0, Math.floor((point.x - grid.originX) / grid.cell)),
  );
  const r0 = Math.min(grid.rows - 1, Math.max(0, Math.floor((point.z - grid.originZ) / grid.cell)));
  const limit = Math.max(grid.columns, grid.rows);
  for (let radius = 0; radius < limit; radius++) {
    let best: number | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let r = r0 - radius; r <= r0 + radius; r++) {
      for (let c = c0 - radius; c <= c0 + radius; c++) {
        if (Math.max(Math.abs(r - r0), Math.abs(c - c0)) !== radius) continue;
        if (c < 0 || r < 0 || c >= grid.columns || r >= grid.rows) continue;
        const index = r * grid.columns + c;
        if (grid.walkable[index] !== 1) continue;
        const distance = (c - c0) ** 2 + (r - r0) ** 2;
        if (distance < bestDistance) {
          best = index;
          bestDistance = distance;
        }
      }
    }
    if (best !== null) return best;
  }
  return null;
}

function centerOfCell(grid: NavGrid, index: number): FlatPoint {
  const c = index % grid.columns;
  const r = Math.floor(index / grid.columns);
  return { x: grid.originX + (c + 0.5) * grid.cell, z: grid.originZ + (r + 0.5) * grid.cell };
}

/** 2点の間が、歩ける升目だけでつながっているか（升目の半分の刻みで確かめる） */
export function lineOfSight(grid: NavGrid, a: FlatPoint, b: FlatPoint): boolean {
  const distance = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(1, Math.ceil(distance / (grid.cell / 2)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const index = cellOf(grid, { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    if (index === null || grid.walkable[index] !== 1) return false;
  }
  return true;
}

/**
 * from から to への道（通る点の並び。from は含めず、最後は to か、to に近い歩ける点）。
 * 道がなければ空の配列。
 */
export function findPath(grid: NavGrid, from: FlatPoint, to: FlatPoint): FlatPoint[] {
  const start = nearestWalkable(grid, from);
  const goal = nearestWalkable(grid, to);
  if (start === null || goal === null) return [];
  const goalPoint = cellOf(grid, to) === goal ? to : centerOfCell(grid, goal);
  if (start === goal || lineOfSight(grid, from, goalPoint)) return [goalPoint];

  const size = grid.columns * grid.rows;
  const cost = new Float64Array(size).fill(Number.POSITIVE_INFINITY);
  const came = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);
  const goalCell = centerOfCell(grid, goal);
  const heuristic = (index: number) => {
    const p = centerOfCell(grid, index);
    return Math.hypot(p.x - goalCell.x, p.z - goalCell.z);
  };
  // 升目の数は数千なので、開いている升目は配列から最小を探す
  const open: number[] = [start];
  cost[start] = 0;
  const neighbors = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [-1, -1, Math.SQRT2],
  ] as const;
  while (open.length > 0) {
    let bestAt = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let i = 0; i < open.length; i++) {
      const index = open[i] ?? 0;
      const score = (cost[index] ?? 0) + heuristic(index);
      if (score < bestScore) {
        bestScore = score;
        bestAt = i;
      }
    }
    const current: number = open.splice(bestAt, 1)[0] ?? start;
    if (current === goal) break;
    closed[current] = 1;
    const c: number = current % grid.columns;
    const r: number = Math.floor(current / grid.columns);
    for (const [dc, dr, step] of neighbors) {
      const nc: number = c + dc;
      const nr: number = r + dr;
      if (nc < 0 || nr < 0 || nc >= grid.columns || nr >= grid.rows) continue;
      const next = nr * grid.columns + nc;
      if (grid.walkable[next] !== 1 || closed[next] === 1) continue;
      // 斜めに進むときは、角をかすめないよう両脇も歩ける升目に限る
      if (
        dc !== 0 &&
        dr !== 0 &&
        (grid.walkable[r * grid.columns + nc] !== 1 || grid.walkable[nr * grid.columns + c] !== 1)
      ) {
        continue;
      }
      const tentative = (cost[current] ?? 0) + step * grid.cell;
      if (tentative < (cost[next] ?? Number.POSITIVE_INFINITY)) {
        if (!Number.isFinite(cost[next] ?? Number.POSITIVE_INFINITY)) open.push(next);
        cost[next] = tentative;
        came[next] = current;
      }
    }
  }
  if (came[goal] === -1) return [];

  const cells: FlatPoint[] = [];
  for (let index = goal; index !== start && index !== -1; index = came[index] ?? -1) {
    cells.push(centerOfCell(grid, index));
  }
  cells.reverse();
  cells[cells.length - 1] = goalPoint;
  // 見通せる点は飛ばして、曲がり角だけを残す
  const path: FlatPoint[] = [];
  let anchor = from;
  let i = 0;
  while (i < cells.length) {
    let far = i;
    for (let j = cells.length - 1; j > i; j--) {
      if (lineOfSight(grid, anchor, cells[j] as FlatPoint)) {
        far = j;
        break;
      }
    }
    const point = cells[far] as FlatPoint;
    path.push(point);
    anchor = point;
    i = far + 1;
  }
  return path;
}
