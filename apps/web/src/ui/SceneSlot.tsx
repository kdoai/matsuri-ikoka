import { Component, type ReactNode, Suspense } from "react";
import { useApp } from "../state/react";
import { selectSceneProps } from "../state/scene";
import { useReducedMotion } from "./hooks";
import { StaffFloor, StaffList } from "./StaffPanel";
import { ShopScene, useScene3d } from "./scene3d";

// 3D の店内を差し込む場所。3D の部品（src/scenes/ShopScene.tsx）は ShopSceneProps を props で受け取り、
// ストアの状態だけを読む。読み込むまでは 2D の見取り図を出しておき、3D が描けたら上に重ねる。
// WebGL が使えない・読み込めない・動きを減らす設定のときは、2D の見取り図を主にする。

class SceneBoundary extends Component<{ fallback: ReactNode; children: ReactNode }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    console.warn("[scene] 3D の店内を出せなかったので、2D の見取り図にします", error);
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** overlay は店内の絵の上に重ねる部品（掲示板・待ち時間のカードなど） */
export function SceneSlot({ overlay }: { overlay?: ReactNode }) {
  const reducedMotion = useReducedMotion();
  const props = useApp((state) => selectSceneProps(state, reducedMotion));
  const use3d = useScene3d() && ShopScene !== null;
  return (
    <div className="flex h-full flex-col gap-1.5">
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl ring-1 ring-wood-700/30">
        {use3d && ShopScene !== null ? (
          <SceneBoundary fallback={<StaffFloor />}>
            {/* 3D を読み込む間の見取り図。文字はスタッフの一覧で読めるので、読み上げからは外す */}
            <div className="absolute inset-0" aria-hidden="true">
              <StaffFloor />
            </div>
            <Suspense fallback={null}>
              <div className="absolute inset-0">
                <ShopScene {...props} />
              </div>
            </Suspense>
          </SceneBoundary>
        ) : (
          <StaffFloor />
        )}
        {overlay}
      </div>
      {/* 3D でも 2D でも、スタッフの状態と吹き出しは文字で読めるようにする */}
      <StaffList showBubbles={use3d} />
    </div>
  );
}
