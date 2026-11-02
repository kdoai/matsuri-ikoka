import { useLoader } from "@react-three/fiber";
import type { AnimationClip, Object3D } from "three";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { type GLTF, GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// 3D のモデル。GLB は assets/3d/models だけに置き、複製しない。
// Vite が ?url で配る（開発ではそのまま、ビルドでは dist/assets に名前にハッシュを付けて出す）。

const urls = import.meta.glob<string>("../../../../assets/3d/models/*.glb", {
  query: "?url",
  import: "default",
  eager: true,
});

export type ModelName =
  | "interior"
  | "exterior"
  | "staff_hiyoko"
  | "staff_owl"
  | "staff_hen"
  | "staff_sparrow"
  | "player_penguin"
  | `motion_${string}`;

export function modelUrl(name: ModelName): string {
  const key = Object.keys(urls).find((path) => path.endsWith(`/${name}.glb`));
  const url = key === undefined ? undefined : urls[key];
  if (url === undefined) {
    throw new Error(`3D のモデルが見つかりません：${name}.glb`);
  }
  return url;
}

/** meshopt で圧縮した GLB を読めるようにする（テクスチャの WebP はそのまま読める） */
function withMeshopt(loader: GLTFLoader): void {
  loader.setMeshoptDecoder(MeshoptDecoder);
}

/** GLB を読み込む（読み終わるまで Suspense で待つ。同じ URL は1回だけ読む） */
export function useModels(names: readonly ModelName[]): GLTF[] {
  return useLoader(
    GLTFLoader,
    names.map((name) => modelUrl(name)),
    withMeshopt,
  );
}

/** 店内と外観（同じ座標で重ねる） */
export function useSetModels(): { interior: GLTF; exterior: GLTF } {
  const [interior, exterior] = useModels(["interior", "exterior"]);
  if (interior === undefined || exterior === undefined) {
    throw new Error("店内と外観の 3D のモデルを読み込めませんでした");
  }
  return { interior, exterior };
}

/**
 * ノードを元の名前で探す。three.js はノードの名前から「.」などを取り除くので、
 * GLB の名前（anchor.concierge.post など）は userData.name に残っている。
 */
export function findNode(root: Object3D, name: string): Object3D | undefined {
  let found: Object3D | undefined;
  root.traverse((object) => {
    if (found === undefined && (object.userData.name === name || object.name === name)) {
      found = object;
    }
  });
  return found;
}

export function originalName(object: Object3D): string {
  return typeof object.userData.name === "string" ? object.userData.name : object.name;
}

export function clipNamed(gltf: GLTF, name: string): AnimationClip | undefined {
  return gltf.animations.find((clip) => clip.name === name);
}
