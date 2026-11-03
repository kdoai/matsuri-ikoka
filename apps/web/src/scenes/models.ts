import { useLoader } from "@react-three/fiber";
import { type AnimationClip, LoaderUtils, type Object3D } from "three";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { type GLTF, GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { fetchModelFile, type ModelName, modelUrl, releaseModelFile } from "./modelFiles";

export type { ModelName } from "./modelFiles";
export { modelUrl } from "./modelFiles";

// 3D のモデルを three.js のオブジェクトにする。ファイルは modelFiles.ts が取ってくる
// （three.js のコードより先に取り始めておけるように、取る処理と読み込む処理を分けてある）。

const parsed = new Map<string, Promise<GLTF>>();

/**
 * 先に取ってある GLB を使う GLTFLoader。同じ URL は1回だけ読む
 * （店の外観で先に読んだモデルを、店内でもう一度読み直さない）
 */
class PrefetchedGLTFLoader extends GLTFLoader {
  override load(
    url: string,
    onLoad: (gltf: GLTF) => void,
    _onProgress?: (event: ProgressEvent) => void,
    onError?: (error: unknown) => void,
  ): void {
    let request = parsed.get(url);
    if (request === undefined) {
      request = fetchModelFile(url).then(
        (buffer) =>
          new Promise<GLTF>((resolve, reject) => {
            releaseModelFile(url);
            this.parse(buffer, LoaderUtils.extractUrlBase(url), resolve, reject);
          }),
      );
      request.catch(() => parsed.delete(url));
      parsed.set(url, request);
    }
    request.then(onLoad, (error: unknown) => onError?.(error));
  }
}

/** meshopt で圧縮した GLB を読めるようにする（テクスチャの WebP はそのまま読める） */
function withMeshopt(loader: PrefetchedGLTFLoader): void {
  loader.setMeshoptDecoder(MeshoptDecoder);
}

/** GLB を読み込む（読み終わるまで Suspense で待つ。同じ URL は1回だけ読む） */
export function useModels(names: readonly ModelName[]): GLTF[] {
  return useLoader(
    PrefetchedGLTFLoader,
    names.map((name) => modelUrl(name)),
    withMeshopt,
  );
}

/** 先に読み込み始めておく（店の外観を見ている間に、店内で使うモデルを読んでおく） */
export function preloadModels(names: readonly ModelName[]): void {
  useLoader.preload(
    PrefetchedGLTFLoader,
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
