import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { describe, expect, it } from "vitest";
import { IDLE_STAFF } from "../state/initial";
import { staffPlan } from "./choreography";
import {
  createNavMesh,
  type FlatPoint,
  findPath,
  type NavGrid,
  type NavMesh,
  nearestOnNavMesh,
} from "./navmesh";
import { guideRest, guideTravel, streetFov, streetGrid, streetWalkable } from "./streetPlan";

// 縁日の通りのモデル（ennichi.glb）の歩ける床を、画面と同じ設定で読み、
// 屋台の前とベンチまで歩いて着けることを確かめる。

interface GlbJson {
  nodes: {
    name?: string;
    mesh?: number;
    translation?: number[];
    scale?: number[];
    rotation?: number[];
  }[];
  meshes: { primitives: { attributes: { POSITION: number }; indices?: number }[] }[];
  accessors: {
    bufferView: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    normalized?: boolean;
  }[];
  bufferViews: {
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
    extensions?: {
      EXT_meshopt_compression?: {
        buffer: number;
        byteOffset?: number;
        byteLength: number;
        byteStride: number;
        count: number;
        mode: "ATTRIBUTES" | "TRIANGLES" | "INDICES";
        filter?: "NONE" | "OCTAHEDRAL" | "QUATERNION" | "EXPONENTIAL";
      };
    };
  }[];
}

/** ファイルを読む（Node で動くテストだけ。画面の型には Node の型を入れない） */
async function readModelFile(): Promise<Uint8Array> {
  const module = "node:fs/promises";
  const { readFile } = (await import(/* @vite-ignore */ module)) as {
    readFile(path: URL): Promise<Uint8Array>;
  };
  return readFile(new URL("../../../../assets/3d/models/ennichi.glb", import.meta.url));
}

async function readGlb(): Promise<{ json: GlbJson; bin: Uint8Array }> {
  const file = await readModelFile();
  const jsonLength = new DataView(file.buffer, file.byteOffset).getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(file.subarray(20, 20 + jsonLength))) as GlbJson;
  return { json, bin: file.subarray(20 + jsonLength + 8) };
}

async function bufferViewBytes(glb: { json: GlbJson; bin: Uint8Array }, index: number) {
  const view = glb.json.bufferViews[index];
  if (view === undefined) throw new Error("bufferView がありません");
  const packed = view.extensions?.EXT_meshopt_compression;
  if (packed === undefined) {
    return glb.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  }
  await MeshoptDecoder.ready;
  const out = new Uint8Array(packed.count * packed.byteStride);
  const source = glb.bin.subarray(
    packed.byteOffset ?? 0,
    (packed.byteOffset ?? 0) + packed.byteLength,
  );
  MeshoptDecoder.decodeGltfBuffer(
    out,
    packed.count,
    packed.byteStride,
    source,
    packed.mode,
    packed.filter ?? "NONE",
  );
  return out;
}

const COMPONENT = {
  5120: { size: 1, read: "getInt8", max: 127 },
  5121: { size: 1, read: "getUint8", max: 255 },
  5122: { size: 2, read: "getInt16", max: 32767 },
  5123: { size: 2, read: "getUint16", max: 65535 },
  5125: { size: 4, read: "getUint32", max: 4294967295 },
  5126: { size: 4, read: "getFloat32", max: 1 },
} as const;

async function accessorValues(glb: { json: GlbJson; bin: Uint8Array }, index: number) {
  const accessor = glb.json.accessors[index];
  if (accessor === undefined) throw new Error("accessor がありません");
  const view = glb.json.bufferViews[accessor.bufferView];
  const bytes = await bufferViewBytes(glb, accessor.bufferView);
  const component = COMPONENT[accessor.componentType as keyof typeof COMPONENT];
  const width = accessor.type === "VEC3" ? 3 : 1;
  const stride =
    view?.byteStride ??
    view?.extensions?.EXT_meshopt_compression?.byteStride ??
    component.size * width;
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = accessor.byteOffset ?? 0;
  const values: number[] = [];
  for (let i = 0; i < accessor.count; i++) {
    for (let c = 0; c < width; c++) {
      const raw = data[component.read](offset + i * stride + c * component.size, true);
      values.push(accessor.normalized ? raw / component.max : raw);
    }
  }
  return values;
}

function nodeNamed(json: GlbJson, name: string) {
  const node = json.nodes.find((item) => item.name === name);
  if (node === undefined) throw new Error(`${name} がありません`);
  return node;
}

async function readNav(glb: { json: GlbJson; bin: Uint8Array }): Promise<NavMesh> {
  const node = nodeNamed(glb.json, "nav.street");
  const mesh = glb.json.meshes[node.mesh ?? -1];
  const primitive = mesh?.primitives[0];
  if (primitive === undefined) throw new Error("nav.street の形がありません");
  const raw = await accessorValues(glb, primitive.attributes.POSITION);
  const [tx = 0, ty = 0, tz = 0] = node.translation ?? [];
  const [sx = 1, sy = 1, sz = 1] = node.scale ?? [];
  const positions = raw.map((value, index) =>
    index % 3 === 0 ? value * sx + tx : index % 3 === 1 ? value * sy + ty : value * sz + tz,
  );
  const indices =
    primitive.indices === undefined ? undefined : await accessorValues(glb, primitive.indices);
  return createNavMesh(positions, indices);
}

function markAt(json: GlbJson, name: string): FlatPoint {
  const [x = 0, , z = 0] = nodeNamed(json, name).translation ?? [];
  return { x, z };
}

/** 道の終わりが、目的地のすぐそばまで届いているか */
function reaches(grid: NavGrid, from: FlatPoint, to: FlatPoint, within: number): boolean {
  const path = findPath(grid, from, to);
  const end = path.at(-1);
  return end !== undefined && Math.hypot(end.x - to.x, end.z - to.z) <= within;
}

describe("縁日の通りの歩ける床", () => {
  it("通りの入り口から、すべての屋台の前と店の入口へ、ガイドの立つ位置へ歩いて着ける", async () => {
    const glb = await readGlb();
    const nav = await readNav(glb);
    const grid = streetGrid(nav);
    const start = markAt(glb.json, "anchor.player.start");
    const names = [
      "anchor.shop.door",
      "anchor.guide.home",
      ...["access", "lodging", "etiquette", "food", "weather", "headquarters"].flatMap((role) => [
        `anchor.stall.${role}`,
        `anchor.guide.${role}`,
      ]),
    ];
    for (const name of names) {
      expect(reaches(grid, start, markAt(glb.json, name), 0.2), name).toBe(true);
    }
  });

  it("休憩所のベンチのそばまで道ができる", async () => {
    const glb = await readGlb();
    const nav = await readNav(glb);
    const grid = streetGrid(nav);
    const start = markAt(glb.json, "anchor.player.start");
    for (const name of ["seat.street.0", "seat.street.1"]) {
      // 座面は床の外にあるので、座面にいちばん近い床の上（ここに立って座る）まで歩けることを見る
      const seat = markAt(glb.json, name);
      const stand = nearestOnNavMesh(nav, seat.x, seat.z);
      expect(Math.hypot(stand.x - seat.x, stand.z - seat.z), name).toBeLessThan(1.3);
      expect(reaches(grid, start, stand, 0.15), name).toBe(true);
    }
  });

  it("旅人が立てる升目は、屋台の前で立てる", async () => {
    const glb = await readGlb();
    const nav = await readNav(glb);
    const walk = streetWalkable(nav);
    for (const role of ["access", "lodging", "etiquette", "food", "weather", "headquarters"]) {
      const stand = markAt(glb.json, `anchor.stall.${role}`);
      expect(walk(stand.x, stand.z), role).toBe(true);
    }
  });
});

describe("ガイドの段取り", () => {
  it("旅人のそばへは駆け寄り、屋台へは旗を掲げて先導する", () => {
    expect(guideTravel("player").motion).toBe("run");
    expect(guideTravel("food").motion).toBe("lead");
    expect(guideTravel("home").motion).toBe("lead");
  });

  it("屋台の脇では旗を振り、返答の間は話す", () => {
    expect(guideRest("food", false).motion).toBe("wave_flag");
    expect(guideRest("player", true).motion).toBe("talk");
    expect(guideRest("home", false).motion).toBe("idle");
  });

  it("店の外へ先導するとき、コンシェルジュだけが帽子と旗を持つ", () => {
    const plan = staffPlan("concierge", IDLE_STAFF, false, { leadingOut: true });
    expect(plan.props).toEqual(["prop.guide_cap", "prop.guide_flag"]);
    expect(plan.motion).toBe("wave_flag");
    expect(staffPlan("scout", IDLE_STAFF, false, { leadingOut: true }).props).toEqual([]);
  });
});

describe("streetFov", () => {
  it("横長の画面ではそのまま、縦長の画面では広げ、広げすぎない", () => {
    expect(streetFov(0.56, 16 / 9)).toBeCloseTo(0.56);
    expect(streetFov(0.56, 0.8)).toBeCloseTo(0.7);
    expect(streetFov(0.56, 0.4)).toBeCloseTo(0.56 / 0.6);
  });
});
