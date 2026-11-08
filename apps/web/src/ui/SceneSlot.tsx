import { Component, type ReactNode, Suspense, useEffect, useState } from "react";
import { prefetchModels, SHOP_SCENE_MODELS, STREET_SCENE_MODELS } from "../scenes/modelFiles";
import { playStore } from "../state/play";
import { useApp, useT } from "../state/react";
import { type FrameInsets, selectSceneProps } from "../state/scene";
import { shioriReady } from "../state/selectors";
import { TalkButton } from "./Hud";
import { useReducedMotion } from "./hooks";
import { No3dNotice } from "./No3d";
import { GreetingBubble, PlayPrompt } from "./Play";
import { SceneLoading } from "./SceneLoading";
import { ShopScene, StorefrontScene, useModelProgress, useScene3d } from "./scene3d";

// ゲームの画面の背景になる店。3D の部品（src/scenes/ShopScene.tsx）は ShopSceneProps を受け取り、
// ストアの状態だけを読む。読み込む間は店の外観を出したまま待つ。2D の見取り図には切り替えない。
// WebGL が使えない・読み込めないときは、その知らせと「話しかける」を出す（相談はそのまま続けられる）。

class SceneBoundary extends Component<{ fallback: ReactNode; children: ReactNode }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    // 3D を描けなかったら、入店の途中の扱いをやめる（案内と「話しかける」を出す）
    playStore.getState().setEntering(false);
    console.warn("[scene] 3D の店内を出せませんでした", error);
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** 3D を描けないとき：知らせと「話しかける」を、会話の窓やパネルに隠れない場所に置く */
function SceneUnavailable({ frame, onTalk }: { frame: FrameInsets; onTalk: () => void }) {
  return (
    <div
      className="absolute flex flex-col items-center justify-center gap-4 bg-wood-900"
      style={{
        top: frame.top + 8,
        right: frame.right + 12,
        bottom: frame.bottom + 16,
        left: frame.left + 12,
      }}
    >
      <No3dNotice />
      <TalkButton onTalk={onTalk} />
    </div>
  );
}

/** 店内を読み込む間の表示：店の外観と「店に入っています」 */
function Entering() {
  const t = useT();
  const shopLoaded = useModelProgress(SHOP_SCENE_MODELS) >= 1;
  return (
    <div className="absolute inset-0 bg-wood-900" data-testid="shop-entering">
      {StorefrontScene === null ? null : (
        <Suspense fallback={null}>
          <StorefrontScene testId="entering-scene" />
        </Suspense>
      )}
      <div className="-translate-x-1/2 absolute top-1/3 left-1/2 flex flex-col items-center gap-2">
        <p
          role="status"
          className="rounded-full bg-ink/70 px-5 py-2 font-bold text-kinari-50 shadow-lg backdrop-blur-sm motion-safe:animate-pulse"
        >
          {t.app.entering}
        </p>
        {/* 店内のモデルがまだ取れていなければ、進み具合も出す */}
        {shopLoaded ? null : <SceneLoading models={SHOP_SCENE_MODELS} />}
      </div>
    </div>
  );
}

export function GameStage({
  frame,
  onTalk,
  onPad,
  onExit,
}: {
  frame: FrameInsets;
  onTalk: () => void;
  onPad: (command: "details" | "map" | "menu") => void;
  onExit: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const props = useApp((state) => selectSceneProps(state, reducedMotion, frame));
  const use3d = useScene3d() && ShopScene !== null;
  const [ready, setReady] = useState(false);
  // 3D の店を出すときは、店内が描けて入店のカメラが終わるまで、案内や「話しかける」を出さない
  useEffect(() => {
    if (use3d) playStore.getState().setEntering(true);
  }, [use3d]);
  // しおりができたら、店の外の通りに備えてモデルを取っておく
  const shioriDone = useApp(shioriReady);
  useEffect(() => {
    if (use3d && shioriDone) prefetchModels(STREET_SCENE_MODELS).catch(() => undefined);
  }, [use3d, shioriDone]);
  return (
    <div className="absolute inset-0" data-testid="game-stage">
      {use3d && ShopScene !== null ? (
        <SceneBoundary fallback={<SceneUnavailable frame={frame} onTalk={onTalk} />}>
          {/* 店内を描けるまでは、店の外観を出したまま待つ */}
          {ready ? null : <Entering />}
          <Suspense fallback={null}>
            <div className="absolute inset-0">
              <ShopScene
                {...props}
                onTalk={onTalk}
                onPad={onPad}
                onExit={onExit}
                onReady={() => {
                  // 店内の絵が浮かび上がる（0.4 秒）まで、外観を下に残しておく
                  window.setTimeout(() => setReady(true), 500);
                }}
              />
            </div>
            <GreetingBubble />
            <PlayPrompt />
          </Suspense>
        </SceneBoundary>
      ) : (
        <SceneUnavailable frame={frame} onTalk={onTalk} />
      )}
    </div>
  );
}
