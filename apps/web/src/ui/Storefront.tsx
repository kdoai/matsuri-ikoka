import { Component, type ReactNode, Suspense, useCallback, useEffect, useState } from "react";
import { prefetchModels, SET_MODELS } from "../scenes/modelFiles";
import { useActions, useApp, useT } from "../state/react";
import { buttonPrimary } from "./common";
import { PasscodeForm } from "./Passcode";
import { SceneLoading } from "./SceneLoading";
import { LanguageButton } from "./Shop";
import { preloadShopScene, StorefrontScene, useScene3d } from "./scene3d";

// 店の外観：タイトルと「入店する」ボタン。すぐに相談を始められる入り口。
// 3D が使えるときは、通りから見上げた店の外観を背景に出す（読み込めなければ 2D の飾りのまま）。

class BackdropBoundary extends Component<{ children: ReactNode; onError: () => void }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch() {
    this.props.onError();
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function Storefront() {
  const t = useT();
  const actions = useActions();
  const passcodeNeeded = useApp((state) => state.auth.needed);
  const use3d = useScene3d() && StorefrontScene !== null;
  const [backdrop, setBackdrop] = useState<"loading" | "ready" | "failed">("loading");
  const onReady = useCallback(() => setBackdrop("ready"), []);
  const onError = useCallback(() => setBackdrop("failed"), []);

  // 3D のコードを待たずに、店内と外観のモデルを取り始める（コードとモデルを同時に取る）
  useEffect(() => {
    if (use3d) prefetchModels(SET_MODELS).catch(() => undefined);
  }, [use3d]);
  // 外観が描けたら、入店に備えて店内のコードも取っておく
  useEffect(() => {
    if (backdrop === "ready") preloadShopScene();
  }, [backdrop]);

  return (
    <main
      className={`relative flex min-h-dvh flex-col items-center overflow-hidden bg-wood-800 px-4 py-10 text-center ${
        use3d ? "justify-end" : "justify-center"
      }`}
    >
      {use3d && StorefrontScene !== null ? (
        <BackdropBoundary onError={onError}>
          <Suspense fallback={null}>
            <StorefrontScene onReady={onReady} />
          </Suspense>
        </BackdropBoundary>
      ) : null}
      {use3d && backdrop === "loading" ? (
        <SceneLoading models={SET_MODELS} className="-translate-x-1/2 absolute top-1/3 left-1/2" />
      ) : null}
      <div className="absolute top-3 right-3 z-10">
        <LanguageButton className="min-h-10 rounded-lg border border-kinari-300/60 px-3 py-1 font-semibold text-kinari-50 text-sm hover:bg-wood-700" />
      </div>
      {/* のれん（藍の布に3つの切れ目）。3D の外観を出すときは出さない */}
      <div aria-hidden="true" className={`flex w-full max-w-xl gap-1 ${use3d ? "hidden" : ""}`}>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-28 flex-1 rounded-b-md bg-ai-700 shadow-[inset_0_-10px_0_rgb(0_0_0/0.15)]"
          />
        ))}
      </div>
      <div
        className={`relative w-full max-w-xl rounded-2xl border-4 border-wood-900 px-6 py-8 shadow-2xl ${
          use3d ? "bg-kinari-50/95" : "-mt-20 bg-kinari-50"
        }`}
      >
        <p className="font-bold text-shu-700 tracking-[0.3em]">{t.app.tagline}</p>
        <h1 className="mt-2 font-bold text-4xl text-ink tracking-wider sm:text-5xl">
          {t.app.name}
        </h1>
        <p className="mx-auto mt-4 max-w-md text-ink leading-relaxed">{t.app.lead}</p>
        {passcodeNeeded ? (
          <div className="mx-auto mt-6 max-w-sm">
            <PasscodeForm retry={false} />
          </div>
        ) : (
          <button
            type="button"
            className={`${buttonPrimary} mt-6 px-10 py-3 text-lg`}
            onClick={() => void actions.enterShop()}
          >
            {t.app.enter}
          </button>
        )}
      </div>
      {/* 提灯の明かり */}
      <div aria-hidden="true" className={`mt-8 flex gap-10 ${use3d ? "hidden" : ""}`}>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-12 w-9 rounded-[45%] bg-shu-500 shadow-[0_0_24px_6px_rgb(233_181_40/0.45)] ring-2 ring-wood-900"
          />
        ))}
      </div>
    </main>
  );
}
