import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import {
  AgXToneMapping,
  AnimationMixer,
  Color,
  LoopOnce,
  type Material,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PerspectiveCamera,
  Quaternion,
  Vector3,
} from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { fitVerticalFov } from "./choreography";
import { clipNamed, findNode, originalName } from "./models";

// 店内と外観を置く舞台：照明、焼き込んだマテリアルの扱い、カメラの目印。

/** 店の外（窓の外や店の脇）の色。夕暮れの通り */
export const BACKGROUND = "#1d140c";

/** 夕暮れの店内に合わせた、キャラクターだけを照らす光（assets/3d/README.md） */
export function Lights() {
  return (
    <>
      <hemisphereLight args={["#9a90e0", "#6a4a30", 0.9]} />
      <directionalLight color="#ffc88a" intensity={2.2} position={[-3, 7, 5]} />
    </>
  );
}

/** レンダラーの設定：AgX の色の見た目と、店の外の色 */
export function useRenderer(): void {
  const { gl, scene } = useThree();
  useEffect(() => {
    gl.toneMapping = AgXToneMapping;
    scene.background = new Color(BACKGROUND);
  }, [gl, scene]);
}

function materialsOf(object: Object3D): Material[] {
  if (!(object instanceof Mesh)) return [];
  return Array.isArray(object.material) ? object.material : [object.material];
}

/**
 * 店内・外観のシーンを、画面に出せる形に整える。
 * - 焼き込んだ unlit のマテリアルは、Blender の AgX の色をすでに含むので、トーンマッピングしない
 * - 歩ける床（nav.*）は表示しない
 */
export function prepareSet(root: Object3D): void {
  root.traverse((object) => {
    const name = originalName(object);
    if (name.startsWith("nav.")) {
      object.visible = false;
    }
    for (const material of materialsOf(object)) {
      if (material instanceof MeshBasicMaterial) {
        material.toneMapped = false;
      }
    }
  });
}

/** 外観の不透明度を変える（入店のカメラが上がり始めたら消す） */
export function setOpacity(root: Object3D, opacity: number): void {
  root.visible = opacity > 0;
  root.traverse((object) => {
    for (const material of materialsOf(object)) {
      const fading = opacity < 1;
      if (material.transparent !== fading) {
        material.transparent = fading;
        material.needsUpdate = true;
      }
      material.opacity = opacity;
      material.depthWrite = !fading;
    }
  });
}

export interface CameraPose {
  position: Vector3;
  quaternion: Quaternion;
  /** 設計した 16:9 での縦の画角（ラジアン） */
  yfov: number;
}

/** GLB のカメラの目印から、位置・向き・画角を読む */
export function cameraPose(root: Object3D, name: string): CameraPose | null {
  const node = findNode(root, name);
  if (node === undefined) return null;
  root.updateMatrixWorld(true);
  const position = new Vector3();
  const quaternion = new Quaternion();
  node.getWorldPosition(position);
  node.getWorldQuaternion(quaternion);
  const yfov = node instanceof PerspectiveCamera ? (node.fov * Math.PI) / 180 : 0.3996;
  return { position, quaternion, yfov };
}

/**
 * カメラを目印の姿勢にし、画面比に合わせて画角を決める。
 * shift は、絵を左へ寄せる量（NDC）。three.js の filmOffset で、カメラの向きを変えずに寄せる
 */
export function applyPose(
  camera: PerspectiveCamera,
  pose: CameraPose,
  aspect: number,
  shift = 0,
): void {
  camera.position.copy(pose.position);
  camera.quaternion.copy(pose.quaternion);
  const fov = fitVerticalFov(pose.yfov, aspect);
  const filmOffset =
    shift * aspect * Math.tan((fov * Math.PI) / 360) * camera.filmGauge * Math.min(aspect, 1);
  if (
    Math.abs(camera.fov - fov) > 1e-3 ||
    Math.abs(camera.aspect - aspect) > 1e-3 ||
    Math.abs(camera.filmOffset - filmOffset) > 1e-3
  ) {
    camera.fov = fov;
    camera.aspect = aspect;
    camera.filmOffset = filmOffset;
    camera.updateProjectionMatrix();
  }
}

/** 入店のカメラ（外観の cam.entry とアニメーション entry） */
export function useEntryRig(exterior: GLTF) {
  return useMemo(() => {
    const node = findNode(exterior.scene, "cam.entry");
    const clip = clipNamed(exterior, "entry");
    if (node === undefined || clip === undefined) return null;
    const mixer = new AnimationMixer(exterior.scene);
    const action = mixer.clipAction(clip);
    action.setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    const start = clip.tracks[0]?.times[0] ?? 0;
    mixer.setTime(start);
    return { node, mixer, clip, start };
  }, [exterior]);
}
