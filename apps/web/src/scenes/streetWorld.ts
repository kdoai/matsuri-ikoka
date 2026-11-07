import { GUIDE_STALLS, type GuideStall } from "@matsuri-ikoka/schema";
import { BufferGeometry, Mesh, type Object3D, Vector3 } from "three";
import type { Target } from "./controls";
import { findNode, originalName } from "./models";
import { createNavMesh, type FlatPoint, meshWalkable, nearestOnNavMesh } from "./navmesh";
import type { Mark } from "./Staff";
import { streetGrid, streetWalkable } from "./streetPlan";
import { markOf, type WalkWorld } from "./world";

// 縁日の通り（ennichi.glb）から、歩ける床・屋台・目印を読み出す。

/** 屋台を開ける距離（m）。屋台の前に立つ目印から */
const STALL_RADIUS = 1;
/** 店へ戻れる距離（m）。通りに出て立つ位置（入口から 0.45 m）では、まだ出さない */
const DOOR_RADIUS = 0.4;
const SEAT_RADIUS = 0.8;

const FALLBACK: Mark = { x: 0, y: 0, z: 0, yaw: 0 };

export interface StreetWorld extends WalkWorld {
  /** ガイドが立つ場所 */
  guideMarks: { door: Mark; start: Mark; home: Mark } & Record<GuideStall, Mark>;
  /** 灯った提灯のノード（屋台ごと）。読み込んだら隠し、灯すときだけ見せる */
  lanterns: Partial<Record<GuideStall, Object3D>>;
}

function navMeshOf(root: Object3D): ReturnType<typeof createNavMesh> {
  const positions: number[] = [];
  const point = new Vector3();
  findNode(root, "nav.street")?.traverse((object) => {
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

const flat = (mark: Mark): FlatPoint => ({ x: mark.x, z: mark.z });

/** 屋台の正面の向き（旅人が向く先）を、立つ目印の向きから決める */
function ahead(mark: Mark): FlatPoint {
  return { x: mark.x + Math.sin(mark.yaw), z: mark.z + Math.cos(mark.yaw) };
}

export function readStreetWorld(root: Object3D): StreetWorld {
  root.updateMatrixWorld(true);
  const nav = navMeshOf(root);
  const start = markOf(root, "anchor.player.start") ?? FALLBACK;
  const door = markOf(root, "anchor.shop.door") ?? start;
  const targets: Target[] = [];

  const guideStalls = {} as Record<GuideStall, Mark>;
  const lanterns: StreetWorld["lanterns"] = {};
  for (const stall of GUIDE_STALLS) {
    const stand = markOf(root, `anchor.stall.${stall}`);
    guideStalls[stall] = markOf(root, `anchor.guide.${stall}`) ?? start;
    const lantern = findNode(root, `lantern.${stall}.on`);
    if (lantern !== undefined) {
      lanterns[stall] = lantern;
      // トーンマッピングを通すと発光の色が抜けて、灯ったことが見分けにくい
      lantern.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) material.toneMapped = false;
      });
    }
    if (stand === null) continue;
    targets.push({
      id: `stall.${stall}`,
      interaction: { kind: "stall", stall },
      stand: flat(stand),
      radius: STALL_RADIUS,
      face: ahead(stand),
    });
  }
  targets.push({
    id: "door",
    interaction: { kind: "door" },
    stand: flat(door),
    radius: DOOR_RADIUS,
    face: ahead(door),
  });

  const seats: WalkWorld["seats"] = {};
  root.traverse((object) => {
    const name = originalName(object);
    if (!name.startsWith("seat.street.")) return;
    const seat = markOf(root, name);
    if (seat === null) return;
    seats[name] = seat;
    targets.push({
      id: name,
      interaction: { kind: "sit", seat: name },
      stand: nearestOnNavMesh(nav, seat.x, seat.z),
      radius: SEAT_RADIUS,
      face: flat(seat),
    });
  });

  return {
    nav,
    grid: streetGrid(nav),
    walk: streetWalkable(nav),
    onFloor: meshWalkable(nav),
    start,
    groundY: start.y,
    targets,
    seats,
    // 通りには、押して出る入口がない（店へ戻るのは door の目印で使う）
    exit: null,
    guideMarks: {
      door,
      start: markOf(root, "anchor.guide.start") ?? start,
      home: markOf(root, "anchor.guide.home") ?? start,
      ...guideStalls,
    },
    lanterns,
  };
}
