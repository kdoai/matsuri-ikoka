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
  return { triangles, minX, maxX, minZ, maxZ };
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
  const { triangles } = mesh;
  for (let o = 0; o < triangles.length; o += 6) {
    if (inTriangle(triangles, o, x, z)) return true;
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

/**
 * from から (dx, dz) だけ進む。床から出るときは、壁に沿って滑る（x だけ・z だけを試す）。
 * どちらにも進めなければ、その場に止まる。
 */
export function slideMove(mesh: NavMesh, from: FlatPoint, dx: number, dz: number): FlatPoint {
  const tries: FlatPoint[] = [
    { x: from.x + dx, z: from.z + dz },
    { x: from.x + dx, z: from.z },
    { x: from.x, z: from.z + dz },
  ];
  for (const point of tries) {
    if ((point.x !== from.x || point.z !== from.z) && onNavMesh(mesh, point.x, point.z)) {
      return point;
    }
  }
  return { x: from.x, z: from.z };
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

/** 床を cell（m）四方の升目にする。升目の中心が床の上なら歩ける */
export function createNavGrid(mesh: NavMesh, cell = 0.1): NavGrid {
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
  return { cell, originX, originZ, columns, rows, walkable };
}

function cellOf(grid: NavGrid, point: FlatPoint): number | null {
  const c = Math.floor((point.x - grid.originX) / grid.cell);
  const r = Math.floor((point.z - grid.originZ) / grid.cell);
  if (c < 0 || r < 0 || c >= grid.columns || r >= grid.rows) return null;
  return r * grid.columns + c;
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
