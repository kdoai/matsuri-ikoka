import { Canvas, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useState } from "react";
import type { PerspectiveCamera } from "three";
import { useSetModels } from "./models";
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

function Street({ onReady }: { onReady: () => void }) {
  useRenderer();
  const { interior, exterior } = useSetModels();
  const entry = useEntryRig(exterior);
  const { camera, size, invalidate } = useThree();

  useEffect(() => {
    prepareSet(interior.scene);
    prepareSet(exterior.scene);
    setOpacity(exterior.scene, 1);
    entry?.mixer.setTime(entry.start);
    const pose = cameraPose(exterior.scene, "cam.entry");
    if (pose !== null) {
      applyPose(camera as PerspectiveCamera, pose, size.width / Math.max(size.height, 1));
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

export default function StorefrontScene() {
  const [ready, setReady] = useState(false);
  return (
    <div className="absolute inset-0" data-testid="storefront-scene" data-ready={ready}>
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
