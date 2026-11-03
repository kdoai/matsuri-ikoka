import { Component, type ReactNode, Suspense } from "react";
import { useApp } from "../state/react";
import { type FrameInsets, selectSceneProps } from "../state/scene";
import { TalkButton } from "./Hud";
import { useReducedMotion } from "./hooks";
import { PlayPrompt } from "./Play";
import { StaffFloor } from "./StaffPanel";
import { ShopScene, useScene3d } from "./scene3d";
import { HostBubble } from "./Waiting";

// ゲームの画面の背景になる店。3D の部品（src/scenes/ShopScene.tsx）は ShopSceneProps を受け取り、
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

/** 2D の見取り図は、会話の窓やパネルに隠れない場所に置く */
function FloorBox({
  frame,
  hidden = false,
  onTalk,
}: {
  frame: FrameInsets;
  hidden?: boolean;
  onTalk?: () => void;
}) {
  return (
    <div
      className="absolute overflow-hidden rounded-3xl shadow-2xl ring-4 ring-wood-700/60"
      style={{
        top: frame.top + 8,
        right: frame.right + 12,
        bottom: frame.bottom + 16,
        left: frame.left + 12,
      }}
      aria-hidden={hidden}
    >
      <StaffFloor />
      {hidden || onTalk === undefined ? null : (
        <div className="-translate-x-1/2 absolute bottom-3 left-1/2">
          <TalkButton onTalk={onTalk} />
        </div>
      )}
    </div>
  );
}

export function GameStage({
  frame,
  onTalk,
  onPad,
}: {
  frame: FrameInsets;
  onTalk: () => void;
  onPad: (command: "details" | "map" | "menu") => void;
}) {
  const reducedMotion = useReducedMotion();
  const props = useApp((state) => selectSceneProps(state, reducedMotion, frame));
  const use3d = useScene3d() && ShopScene !== null;
  return (
    <div className="absolute inset-0" data-testid="game-stage">
      {use3d && ShopScene !== null ? (
        <SceneBoundary fallback={<FloorBox frame={frame} onTalk={onTalk} />}>
          {/* 3D を読み込む間の見取り図。文字は「店内のようす」で読めるので、読み上げからは外す */}
          <FloorBox frame={frame} hidden />
          <Suspense fallback={null}>
            <div className="absolute inset-0">
              <ShopScene {...props} onTalk={onTalk} onPad={onPad} />
            </div>
            <HostBubble />
            <PlayPrompt />
          </Suspense>
        </SceneBoundary>
      ) : (
        <FloorBox frame={frame} onTalk={onTalk} />
      )}
    </div>
  );
}
