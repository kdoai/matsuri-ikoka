import { Box3, BufferGeometry, Mesh, type Object3D, Quaternion, Vector3 } from "three";
import {
  CHICKS,
  type Chick,
  GIMMICK_STANDS,
  GIMMICKS,
  type Gimmick,
  gimmickNode,
  type Target,
} from "./controls";
import { findNode, originalName } from "./models";
import {
  clearWalkable,
  createNavGrid,
  createNavMesh,
  createObstacles,
  type FlatPoint,
  gridWalkable,
  type NavGrid,
  type NavMesh,
  nearestClear,
  nearestOnNavMesh,
  type Obstacles,
  type Walkable,
} from "./navmesh";
import type { Mark } from "./Staff";

// 店内（interior.glb）から、旅人が遊ぶのに要るものを読み出す：歩ける床、入口、
// 仕掛け・座る場所・隠れひよこの位置、入口の壁、時計の針。

/** 旅人の体の太さ（m）。歩ける床の縁から、さらにこれだけ離れたところを歩く */
const BODY_RADIUS = 0.12;

/** 入口の床の縁から、この距離のうちに立つと「外に出る」を出す（入店して立つ位置よりは外側） */
const EXIT_RADIUS = 0.35;

/**
 * 体の高さ（m）。この高さにかかる家具は、脚の間も通れないようにする（ベンチの座面・台の天板）。
 * 天板の高い机（0.5 m より上）の下には、旅人の体が入るので含めない
 */
const BODY_LOW = 0.08;
const BODY_HIGH = 0.45;

/** 家具から離れて歩く距離（m）。歩ける床を作るときに家具の脚から離した距離と同じ */
const FURNITURE_MARGIN = 0.2;

/** 家具の形を読まないもの：床と外の通り、旅人が入口の近くにいる間に透かす入口の壁 */
const NOT_FURNITURE = ["baked.floor", "baked.street", "baked.entrance_wall"];

/** 仕掛けの本体からこの距離より遠い床にしか立てないときは、タップでだけ動かす（従業員の区域） */
const REACH_LIMIT = 1.6;

export interface ShopWorld {
  nav: NavMesh;
  /** 道を探す升目（10 cm 四方） */
  grid: NavGrid;
  /** 旅人が立てるところ（3 cm の升目を、体の太さぶん縁から削ったもの） */
  walk: Walkable;
  /** 歩ける床の三角形の上で、家具にかからないところ（縁に近すぎる位置から抜け出すときに使う） */
  onFloor: Walkable;
  /** 入店して立つ位置（入口） */
  start: Mark;
  /** カウンターでコンシェルジュと話す位置（カメラの基準） */
  counter: Mark;
  /** 歩いて近づいて使うもの（スタッフと話すのは毎フレーム足す） */
  targets: Target[];
  seats: Record<string, Mark>;
  /** 従業員の区域の椅子（地図の机・読書机・踏み台）。柵の向こうなので座れない */
  staffSeats: FlatPoint[];
  /** 仕掛けの本体の位置（タップしたものを見分ける・向く） */
  gimmicks: Partial<Record<Gimmick, FlatPoint>>;
  chicks: Partial<Record<Chick, FlatPoint>>;
  /** 旅人が入口の近くにいる間、半透明にするもの */
  entrance: Object3D[];
  noren: FlatPoint | null;
  /** のれんの内側で、ここに立つと店の外へ出られる（入口の床の縁） */
  exit: FlatPoint | null;
  clock: { hour: Object3D | null; minute: Object3D | null };
}

export function markOf(root: Object3D, name: string): Mark | null {
  const node = findNode(root, name);
  if (node === undefined) return null;
  const position = new Vector3();
  const quaternion = new Quaternion();
  node.getWorldPosition(position);
  node.getWorldQuaternion(quaternion);
  // 目印の向き（Y 軸まわり）。キャラクターの正面は +Z
  const forward = new Vector3(0, 0, 1).applyQuaternion(quaternion);
  return { x: position.x, y: position.y, z: position.z, yaw: Math.atan2(forward.x, forward.z) };
}

/** ノードの形の中心（床の上の位置）。ノードの原点が形から離れている仕掛けもある */
function centerOf(root: Object3D, name: string): FlatPoint | null {
  const node = findNode(root, name);
  if (node === undefined) return null;
  const box = new Box3().setFromObject(node);
  if (box.isEmpty()) {
    const mark = markOf(root, name);
    return mark === null ? null : flat(mark);
  }
  const center = box.getCenter(new Vector3());
  return { x: center.x, z: center.z };
}

/** 床のメッシュの三角形を、ワールド座標でまとめる */
function navMeshOf(root: Object3D, name: string): NavMesh {
  const positions: number[] = [];
  const point = new Vector3();
  findNode(root, name)?.traverse((object) => {
    if (!(object instanceof Mesh) || !(object.geometry instanceof BufferGeometry)) return;
    const geometry =
      object.geometry.index === null ? object.geometry : object.geometry.toNonIndexed();
    const attribute = geometry.getAttribute("position");
    for (let i = 0; i < attribute.count; i++) {
      point.fromBufferAttribute(attribute, i).applyMatrix4(object.matrixWorld);
      positions.push(point.x, point.y, point.z);
    }
  });
  return createNavMesh(positions);
}

/** 焼き込んだ家具（baked.*）の三角形のうち、体の高さにかかるもの */
function obstaclesOf(root: Object3D): Obstacles {
  const positions: number[] = [];
  const point = new Vector3();
  for (const group of root.children) {
    const name = originalName(group);
    if (!name.startsWith("baked.") || NOT_FURNITURE.includes(name)) continue;
    group.traverse((object) => {
      if (!(object instanceof Mesh) || !(object.geometry instanceof BufferGeometry)) return;
      const geometry =
        object.geometry.index === null ? object.geometry : object.geometry.toNonIndexed();
      const attribute = geometry.getAttribute("position");
      for (let i = 0; i < attribute.count; i++) {
        point.fromBufferAttribute(attribute, i).applyMatrix4(object.matrixWorld);
        positions.push(point.x, point.y, point.z);
      }
    });
  }
  return createObstacles(positions, BODY_LOW, BODY_HIGH, FURNITURE_MARGIN);
}

function flat(mark: Mark): FlatPoint {
  return { x: mark.x, z: mark.z };
}

export function readShopWorld(interior: Object3D): ShopWorld {
  interior.updateMatrixWorld(true);
  const nav = navMeshOf(interior, "nav.customer");
  const obstacles = obstaclesOf(interior);
  const fallback: Mark = { x: 0, y: 0, z: 0, yaw: Math.PI };
  const counter = markOf(interior, "anchor.player.counter") ?? fallback;
  const start = markOf(interior, "anchor.player.start") ?? counter;
  const targets: Target[] = [];

  const gimmicks: Partial<Record<Gimmick, FlatPoint>> = {};
  for (const gimmick of GIMMICKS) {
    const body = centerOf(interior, gimmickNode(gimmick));
    if (body === null) continue;
    gimmicks[gimmick] = body;
    // のれんは、くぐると揺れる。近づいたときは「外に出る」にする（下の exit）
    if (gimmick === "noren") continue;
    const standName = GIMMICK_STANDS[gimmick];
    const stand = standName === undefined ? null : markOf(interior, standName);
    const spot = stand === null ? nearestOnNavMesh(nav, body.x, body.z) : flat(stand);
    const reach = Math.hypot(spot.x - body.x, spot.z - body.z);
    if (stand === null && reach > REACH_LIMIT) continue;
    targets.push({
      id: `gimmick.${gimmick}`,
      interaction: { kind: "gimmick", gimmick },
      stand: spot,
      radius: stand === null ? 0.9 : 0.75,
      face: body,
    });
  }

  const seats: Record<string, Mark> = {};
  const staffSeats: FlatPoint[] = [];
  interior.traverse((object) => {
    const name = originalName(object);
    if (name.startsWith("seat.staff.")) {
      const seat = markOf(interior, name);
      if (seat !== null) staffSeats.push(flat(seat));
    }
    if (!name.startsWith("seat.customer.")) return;
    const seat = markOf(interior, name);
    if (seat === null) return;
    seats[name] = seat;
    targets.push({
      id: name,
      interaction: { kind: "sit", seat: name },
      // ベンチの座面は床の上にかかるので、家具の外の、座面にいちばん近いところに立って座る
      stand: nearestClear(nav, obstacles, seat.x, seat.z),
      radius: 0.8,
      face: flat(seat),
    });
  });

  const chicks: Partial<Record<Chick, FlatPoint>> = {};
  for (const chick of CHICKS) {
    const node = centerOf(interior, `secret.chick.${chick}`);
    if (node === null) continue;
    chicks[chick] = node;
    const stand = nearestOnNavMesh(nav, node.x, node.z);
    if (Math.hypot(stand.x - node.x, stand.z - node.z) > REACH_LIMIT) continue;
    targets.push({
      id: `chick.${chick}`,
      interaction: { kind: "chick", chick },
      stand,
      radius: 0.9,
      face: node,
    });
  }

  const entrance: Object3D[] = [];
  interior.traverse((object) => {
    const name = originalName(object);
    if (name === "baked.entrance_wall" || name.startsWith("chochin_door.")) entrance.push(object);
  });
  // 透かすのは入口だけにする（ほかの提灯と同じマテリアルを分けておく）
  for (const object of entrance) {
    object.traverse((child) => {
      if (child instanceof Mesh) {
        child.material = Array.isArray(child.material)
          ? child.material.map((material) => material.clone())
          : child.material.clone();
      }
    });
  }

  const noren = markOf(interior, "gimmick.noren");
  const norenBody = gimmicks.noren ?? (noren === null ? null : flat(noren));
  const exit = norenBody === null ? null : nearestOnNavMesh(nav, norenBody.x, norenBody.z);
  if (exit !== null && norenBody !== null) {
    targets.push({
      id: "exit",
      interaction: { kind: "exit" },
      stand: exit,
      radius: EXIT_RADIUS,
      face: norenBody,
    });
  }
  return {
    nav,
    // 道は体の太さ（0.1 m）ぶん縁から離して探す
    grid: createNavGrid(nav, 0.1, 0.1, obstacles),
    // 歩ける床は家具から 0.2 m 離してあるが、ペンギンの体（帽子とリュック）はそれより太いので、
    // さらに体の太さぶん縁から離れたところだけを歩く
    walk: gridWalkable(createNavGrid(nav, 0.03, BODY_RADIUS, obstacles)),
    onFloor: clearWalkable(nav, obstacles),
    start,
    counter,
    targets,
    seats,
    staffSeats,
    gimmicks,
    chicks,
    entrance,
    noren: noren === null ? null : flat(noren),
    exit,
    clock: {
      hour: findNode(interior, "clock.hand.hour") ?? null,
      minute: findNode(interior, "clock.hand.minute") ?? null,
    },
  };
}
