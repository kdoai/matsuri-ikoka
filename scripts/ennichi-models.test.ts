// assets/3d/models の縁日の通りとガイドの GLB を読み、画面が頼るノードとアニメーションがあることと、
// スマホでも動く大きさに収まっていることを確かめる。GLB の中身の JSON だけを読む。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GUIDE_STALLS } from "../packages/schema/src";

const MODELS = join(dirname(fileURLToPath(import.meta.url)), "../assets/3d/models");

interface GltfNode {
  name?: string;
  mesh?: number;
  camera?: number;
  children?: number[];
}
interface GltfMaterial {
  emissiveFactor?: number[];
  emissiveTexture?: unknown;
  extensions?: Record<string, unknown>;
}
interface GltfPrimitive {
  material?: number;
  mode?: number;
  indices?: number;
  attributes: Record<string, number>;
}
interface Gltf {
  nodes?: GltfNode[];
  meshes?: { primitives: GltfPrimitive[] }[];
  materials?: GltfMaterial[];
  accessors?: { count: number }[];
  animations?: { name?: string; channels: { target: { node?: number } }[] }[];
}

/** GLB の先頭の JSON のかたまりを読む */
function readGltf(name: string): Gltf {
  const file = readFileSync(join(MODELS, `${name}.glb`));
  expect(file.readUInt32LE(0)).toBe(0x46546c67); // "glTF"
  const length = file.readUInt32LE(12);
  expect(file.readUInt32LE(16)).toBe(0x4e4f534a); // "JSON"
  return JSON.parse(file.toString("utf8", 20, 20 + length)) as Gltf;
}

function node(gltf: Gltf, name: string): GltfNode {
  const found = gltf.nodes?.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`ノードがありません：${name}`);
  return found;
}

function parentName(gltf: Gltf, name: string): string | undefined {
  const nodes = gltf.nodes ?? [];
  const index = nodes.findIndex((entry) => entry.name === name);
  return nodes.find((entry) => entry.children?.includes(index))?.name;
}

function materialsOf(gltf: Gltf, name: string): GltfMaterial[] {
  const mesh = gltf.meshes?.[node(gltf, name).mesh ?? -1];
  if (mesh === undefined) throw new Error(`メッシュがありません：${name}`);
  return mesh.primitives.map((primitive) => gltf.materials?.[primitive.material ?? -1] ?? {});
}

function glows(material: GltfMaterial): boolean {
  return (
    material.emissiveTexture !== undefined || (material.emissiveFactor ?? []).some((v) => v > 0)
  );
}

const TRIANGLES = 4;

/** GLB の三角形を数える。同じメッシュを使うノードは、その数だけ描かれる */
function countTriangles(gltf: Gltf): number {
  let total = 0;
  for (const entry of gltf.nodes ?? []) {
    if (entry.mesh === undefined) continue;
    for (const primitive of gltf.meshes?.[entry.mesh]?.primitives ?? []) {
      if ((primitive.mode ?? TRIANGLES) !== TRIANGLES) continue;
      const accessor = primitive.indices ?? primitive.attributes.POSITION;
      const count = gltf.accessors?.[accessor ?? -1]?.count;
      if (count === undefined) throw new Error("頂点の数が読めません");
      total += Math.floor(count / 3);
    }
  }
  return total;
}

describe("縁日の通り（ennichi.glb）", () => {
  const street = readGltf("ennichi");

  it.each(GUIDE_STALLS)("屋台 %s に、形・提灯・立つ位置・カメラがある", (stall) => {
    expect(node(street, `baked.stall_${stall}`).mesh).toBeDefined();
    expect(node(street, `lantern.${stall}.on`).mesh).toBeDefined();
    expect(node(street, `anchor.stall.${stall}`).mesh).toBeUndefined();
    expect(node(street, `anchor.guide.${stall}`).mesh).toBeUndefined();
    expect(
      node(street, `cam.stall.${stall}`).camera ?? node(street, `cam.stall.${stall}`).children,
    ).toBeDefined();
  });

  it("灯った提灯だけが光り、消えた提灯は焼き込みの中にある", () => {
    for (const stall of GUIDE_STALLS) {
      expect(materialsOf(street, `lantern.${stall}.on`).some(glows)).toBe(true);
      const baked = materialsOf(street, `baked.stall_${stall}`);
      expect(baked.every((material) => "KHR_materials_unlit" in (material.extensions ?? {}))).toBe(
        true,
      );
      expect(baked.some(glows)).toBe(false);
    }
  });

  it("提灯のノードは、屋台ごとに別で、ほかのノードの子ではない", () => {
    for (const stall of GUIDE_STALLS) {
      expect(parentName(street, `lantern.${stall}.on`)).toBeUndefined();
    }
  });

  it("歩ける床、店を出たときの目印、休憩所の席、全景のカメラがある", () => {
    for (const name of [
      "nav.street",
      "anchor.shop.door",
      "anchor.player.start",
      "anchor.guide.start",
      "anchor.guide.home",
      "seat.street.0",
      "seat.street.1",
      "cam.ennichi",
    ]) {
      expect(node(street, name)).toBeDefined();
    }
  });
});

describe("ガイドの帽子と旗（staff_hiyoko.glb）", () => {
  const hiyoko = readGltf("staff_hiyoko");

  it("帽子は頭に、旗は右手についている", () => {
    expect(parentName(hiyoko, "prop.guide_cap")).toBe("head");
    expect(parentName(hiyoko, "prop.guide_flag")).toBe("hand.R");
  });
});

describe("ガイドのモーション", () => {
  it.each(["lead", "wave_flag", "run"])(
    "motion_%s は同じ名前のアニメーション1本だけを持つ",
    (name) => {
      const motion = readGltf(`motion_${name}`);
      expect(motion.animations?.map((animation) => animation.name)).toEqual([name]);
      const targets = motion.animations?.[0]?.channels.map(
        (channel) => motion.nodes?.[channel.target.node ?? -1]?.name,
      );
      expect(targets).toEqual(expect.arrayContaining(["root", "body", "head", "wing.R", "hand.R"]));
    },
  );
});

describe("モデルの大きさ（manifest.json）", () => {
  const manifest = JSON.parse(readFileSync(join(MODELS, "manifest.json"), "utf8")) as {
    files: { file: string; kilobytes: number; triangles: number }[];
    total_kilobytes: number;
  };
  const files = readdirSync(MODELS)
    .filter((name) => name.endsWith(".glb"))
    .sort();
  const trianglesOf = (file: string) => countTriangles(readGltf(file.replace(/\.glb$/, "")));

  it("一覧に載っているモデルと、models/ の GLB が一致する", () => {
    expect(manifest.files.map((entry) => entry.file).sort()).toEqual(files);
  });

  it.each(manifest.files)("$file の三角形数とサイズが、実際のファイルと合う", (entry) => {
    expect(trianglesOf(entry.file)).toBe(entry.triangles);
    expect(statSync(join(MODELS, entry.file)).size / 1024).toBeCloseTo(entry.kilobytes, 0);
  });

  it("一覧の合計は、行の和と合い、15 MB 以下", () => {
    const sum = manifest.files.reduce((total, entry) => total + entry.kilobytes, 0);
    expect(manifest.total_kilobytes).toBeCloseTo(sum, 1);
    expect(manifest.total_kilobytes).toBeLessThanOrEqual(15 * 1024);
  });

  it("店内と縁日の通りは、それぞれ 15 万三角形以下", () => {
    for (const file of ["interior.glb", "ennichi.glb"]) {
      expect(files).toContain(file);
      expect(trianglesOf(file)).toBeLessThanOrEqual(150_000);
    }
  });

  it("キャラクターは1体 1.5 万三角形以下", () => {
    const characters = files.filter((file) => /^(staff|player)_/.test(file));
    expect(characters).toEqual(expect.arrayContaining(["staff_hiyoko.glb", "player_penguin.glb"]));
    for (const file of characters) {
      expect(trianglesOf(file)).toBeLessThanOrEqual(15_000);
    }
  });
});
