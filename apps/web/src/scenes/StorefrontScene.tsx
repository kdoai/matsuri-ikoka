import { Canvas, type ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useState } from "react";
import { AnimationMixer, LoopOnce, type Object3D, type PerspectiveCamera } from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { GIMMICK_CLIPS, gimmickNode } from "./controls";
import { SHOP_MODELS } from "./modelFiles";
import { clipNamed, originalName, preloadModels, useSetModels } from "./models";
import {
  applyPose,
  cameraPose,
  Lights,
  prepareSet,
  setOpacity,
  useEntryRig,
  useRenderer,
} from "./stage";

// 店の外観。入店する前の画面の背景に、入店のカメラの最初の姿勢で、通りから店を見上げる。
// 動かない絵なので、描くのは読み込んだときと画面の大きさが変わったときだけにする。
// のれんの外で寝ているネコだけは、クリックするとなでられる（なでている間だけ描き続ける）。

/** 当たったものが、のれんの外のネコ（gimmick.cat の下）か */
function isCat(object: Object3D | null): boolean {
  for (let node = object; node !== null; node = node.parent) {
    if (originalName(node) === gimmickNode("cat")) return true;
  }
  return false;
}

/** ネコをなでる動き。終わったら寝ている姿に戻す */
function useCatPet(interior: GLTF) {
  return useMemo(() => {
    const name = GIMMICK_CLIPS.cat;
    const clip = name === null ? undefined : clipNamed(interior, name);
    if (clip === undefined) return null;
    const mixer = new AnimationMixer(interior.scene);
    const action = mixer.clipAction(clip);
    action.setLoop(LoopOnce, 1);
    mixer.addEventListener("finished", () => action.stop());
    return { mixer, action };
  }, [interior]);
}

function Street({ onReady }: { onReady: () => void }) {
  useRenderer();
  const models = useSetModels();
  // 店内の画面と同じ物体を2つの描画の場に置くと取り合いになり、店内が映らないことがある。
  // 外観の画面では複製を使う（形とマテリアルは共有する）
  const { interior, exterior } = useMemo(
    () => ({
      interior: { ...models.interior, scene: models.interior.scene.clone(true) },
      exterior: { ...models.exterior, scene: models.exterior.scene.clone(true) },
    }),
    [models],
  );
  const entry = useEntryRig(exterior);
  const pet = useCatPet(interior);
  const { camera, size, invalidate, gl } = useThree();

  useFrame((_, delta) => {
    if (pet === null || !pet.action.isRunning()) return;
    pet.mixer.update(delta);
    invalidate();
  });

  const onClick = (event: ThreeEvent<MouseEvent>) => {
    if (pet === null || !isCat(event.object)) return;
    event.stopPropagation();
    if (pet.action.isRunning()) return;
    pet.action.reset().play();
    invalidate();
  };
  const onPointerMove = (event: ThreeEvent<PointerEvent>) => {
    gl.domElement.style.cursor = isCat(event.object) ? "pointer" : "";
  };

  useEffect(() => {
    preloadModels(SHOP_MODELS);
  }, []);

  useEffect(() => {
    prepareSet(interior.scene);
    prepareSet(exterior.scene);
    setOpacity(exterior.scene, 1);
    entry?.mixer.setTime(entry.start);
    const pose = cameraPose(exterior.scene, "cam.entry");
    if (pose !== null) {
      applyPose(camera as PerspectiveCamera, pose, size.width, size.height);
    }
    invalidate();
    onReady();
  }, [interior, exterior, entry, camera, size, invalidate, onReady]);

  return (
    <>
      <Lights />
      {/* biome-ignore lint/a11y/noStaticElementInteractions: three.js の物体で、DOM の要素ではない（キャンバスは読み上げない飾り） */}
      <primitive
        object={interior.scene}
        dispose={null}
        onClick={onClick}
        onPointerMove={onPointerMove}
        onPointerOut={() => {
          gl.domElement.style.cursor = "";
        }}
      />
      <primitive object={exterior.scene} dispose={null} />
    </>
  );
}

export interface StorefrontSceneProps {
  testId?: string;
  /** 外観を描けたとき（読み込み中の表示を消す） */
  onReady?: () => void;
}

export default function StorefrontScene({
  testId = "storefront-scene",
  onReady,
}: StorefrontSceneProps) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready) onReady?.();
  }, [ready, onReady]);
  return (
    <div className="absolute inset-0" data-testid={testId} data-ready={ready}>
      <Canvas
        aria-hidden="true"
        frameloop="demand"
        dpr={[1, 1.5]}
        gl={{ antialias: true }}
        camera={{ near: 0.1, far: 200 }}
        style={{ opacity: ready ? 1 : 0, transition: "opacity 0.6s" }}
      >
        <Suspense fallback={null}>
          <Street onReady={() => setReady(true)} />
        </Suspense>
      </Canvas>
    </div>
  );
}
