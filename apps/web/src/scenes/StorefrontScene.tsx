import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useState } from "react";
import { AnimationMixer, LoopOnce, type PerspectiveCamera, Raycaster, Vector2 } from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { GIMMICK_CLIPS, gimmickNode } from "./controls";
import { SHOP_MODELS } from "./modelFiles";
import { clipNamed, findNode, preloadModels, useSetModels } from "./models";
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

/** ネコ（gimmick.cat）と、なでる動き。終わったら寝ている姿に戻す。外したときに片付ける */
function useCatPet(interior: GLTF) {
  const pet = useMemo(() => {
    const cat = findNode(interior.scene, gimmickNode("cat"));
    const name = GIMMICK_CLIPS.cat;
    const clip = name === null ? undefined : clipNamed(interior, name);
    if (cat === undefined || clip === undefined) return null;
    const mixer = new AnimationMixer(interior.scene);
    const action = mixer.clipAction(clip);
    action.setLoop(LoopOnce, 1);
    mixer.addEventListener("finished", () => action.stop());
    return { cat, mixer, action };
  }, [interior]);
  useEffect(
    () => () => {
      pet?.mixer.stopAllAction();
      pet?.mixer.uncacheRoot(pet.mixer.getRoot());
    },
    [pet],
  );
  return pet;
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

  // 当たりを見るのはネコのノードだけ（店の全体には付けない）
  useEffect(() => {
    if (pet === null) return;
    const element = gl.domElement;
    const raycaster = new Raycaster();
    const pointer = new Vector2();
    const hitsCat = (event: MouseEvent) => {
      const rect = element.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      return raycaster.intersectObject(pet.cat, true).length > 0;
    };
    const onClick = (event: MouseEvent) => {
      if (!hitsCat(event)) return;
      event.stopPropagation();
      if (pet.action.isRunning()) return;
      pet.action.reset().play();
      invalidate();
    };
    const onMove = (event: PointerEvent) => {
      element.style.cursor = hitsCat(event) ? "pointer" : "";
    };
    const onLeave = () => {
      element.style.cursor = "";
    };
    element.addEventListener("click", onClick);
    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerleave", onLeave);
    return () => {
      element.removeEventListener("click", onClick);
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerleave", onLeave);
      element.style.cursor = "";
    };
  }, [pet, gl, camera, invalidate]);

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
      <primitive object={interior.scene} dispose={null} />
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
