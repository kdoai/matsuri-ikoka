import { Canvas, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useState } from "react";
import type { PerspectiveCamera } from "three";
import { SCENE_MOTIONS } from "./choreography";
import { type ModelName, preloadModels, useSetModels } from "./models";
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

/** 店内で使うモデル（スタッフ・旅人・モーション）。外観を見ている間に読んでおく */
const SHOP_MODELS: ModelName[] = [
  "staff_hiyoko",
  "staff_owl",
  "staff_hen",
  "staff_sparrow",
  "player_penguin",
  ...SCENE_MOTIONS.map((name) => `motion_${name}` as ModelName),
];

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
  const { camera, size, invalidate } = useThree();

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

export default function StorefrontScene({ testId = "storefront-scene" }: { testId?: string }) {
  const [ready, setReady] = useState(false);
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
