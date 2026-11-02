import { Component, type ComponentType, lazy, type ReactNode, Suspense } from "react";
import { useApp } from "../state/react";
import { type ShopSceneProps, selectSceneProps } from "../state/scene";
import { useReducedMotion } from "./hooks";
import { StaffFloor, StaffList } from "./StaffPanel";

// 3D の店内を差し込む場所。3D の部品は src/scenes/ShopScene.tsx に置き、
// ShopSceneProps を props で受け取る既定のエクスポートにする（ストアの状態だけを受ける）。
// 部品がない・読み込めない・動きを減らす設定のときは、2D の見取り図を出す。

const sceneModules = import.meta.glob<{ default: ComponentType<ShopSceneProps> }>(
  "../scenes/ShopScene.tsx",
);
const loadScene = sceneModules["../scenes/ShopScene.tsx"];
const ShopScene = loadScene === undefined ? null : lazy(loadScene);

class SceneBoundary extends Component<{ fallback: ReactNode; children: ReactNode }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** overlay は店内の絵の上に重ねる部品（掲示板・待ち時間のカードなど） */
export function SceneSlot({ overlay }: { overlay?: ReactNode }) {
  const reducedMotion = useReducedMotion();
  const props = useApp((state) => selectSceneProps(state, reducedMotion));
  const use3d = ShopScene !== null && !reducedMotion;
  return (
    <div className="flex h-full flex-col gap-1.5">
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl ring-1 ring-wood-700/30">
        {use3d && ShopScene !== null ? (
          <SceneBoundary fallback={<StaffFloor />}>
            <Suspense fallback={<StaffFloor />}>
              <ShopScene {...props} />
            </Suspense>
          </SceneBoundary>
        ) : (
          <StaffFloor />
        )}
        {overlay}
      </div>
      {/* 3D でも 2D でも、スタッフの状態は文字で読めるようにする */}
      <StaffList showBubbles={use3d} />
    </div>
  );
}
