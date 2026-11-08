import { Volume2, VolumeX } from "lucide-react";
import { Component, type ReactNode, Suspense, useCallback, useEffect, useState } from "react";
import { prefetchModels, SET_MODELS } from "../scenes/modelFiles";
import { useActions, useApp, useT } from "../state/react";
import { buttonPrimary } from "./common";
import { No3dNotice } from "./No3d";
import { PasscodeForm } from "./Passcode";
import { SavedTrips } from "./SavedTrips";
import { SceneLoading } from "./SceneLoading";
import { LanguageButton } from "./Shop";
import { preloadShopScene, StorefrontScene, useScene3d } from "./scene3d";
import { playSound } from "./sound";

// 店の外観：タイトルと「入店する」ボタン。すぐに相談を始められる入り口。
// 通りから見上げた店の外観（3D）を背景に出す。描けないときは、その知らせを出す（2D の飾りには切り替えない）。

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

/**
 * 入店の前に、音を鳴らすかを選ぶ。ブラウザは操作のない自動の再生を止めるので、ここで押してもらう。
 * 店に入ってからは、設定の音のボタンで変えられる
 */
function SoundChoice() {
  const t = useT();
  const actions = useActions();
  const soundOn = useApp((state) => state.ui.soundOn);
  const options = [
    { on: true, label: t.app.soundChoiceOn },
    { on: false, label: t.app.soundChoiceOff },
  ];
  return (
    <fieldset className="mx-auto mt-5 flex flex-col items-center gap-1">
      <legend className="sr-only">{t.app.soundChoice}</legend>
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="flex items-center gap-1 font-bold text-ink text-sm">
          {soundOn ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
          {t.app.soundChoice}
        </span>
        <div className="flex overflow-hidden rounded-xl border-2 border-ai-200">
          {options.map((option) => (
            <button
              key={option.label}
              type="button"
              aria-pressed={soundOn === option.on}
              title={t.app.soundHint}
              className={`min-h-10 min-w-16 px-4 font-bold text-sm ${
                soundOn === option.on ? "bg-ai-700 text-kinari-50" : "bg-white text-ai-800"
              }`}
              onClick={() => {
                if (soundOn === option.on) return;
                actions.setSound(option.on);
                if (option.on) playSound("hyoshigi");
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <p className="text-ink/70 text-xs">{t.app.soundChoiceNote}</p>
    </fieldset>
  );
}

export function Storefront() {
  const t = useT();
  const actions = useActions();
  const passcodeNeeded = useApp((state) => state.auth.needed);
  const use3d = useScene3d() && StorefrontScene !== null;
  const [backdrop, setBackdrop] = useState<"loading" | "ready" | "failed">("loading");
  const onReady = useCallback(() => setBackdrop("ready"), []);
  const onError = useCallback(() => setBackdrop("failed"), []);

  // 入店の前に合言葉が要るかを確かめる。要るなら、店を開かずにここで聞く
  useEffect(() => {
    void actions.checkAccess();
  }, [actions]);
  // 3D のコードを待たずに、店内と外観のモデルを取り始める（コードとモデルを同時に取る）
  useEffect(() => {
    if (use3d) prefetchModels(SET_MODELS).catch(() => undefined);
  }, [use3d]);
  // 外観が描けたら、入店に備えて店内のコードも取っておく
  useEffect(() => {
    if (backdrop === "ready") preloadShopScene();
  }, [backdrop]);

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-end overflow-hidden bg-wood-800 px-4 py-10 text-center">
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
      {/* 3D を描けないときは、その知らせを出す */}
      {use3d && backdrop !== "failed" ? null : (
        <div className="-translate-x-1/2 absolute top-1/4 left-1/2 w-[min(28rem,calc(100vw-2rem))]">
          <No3dNotice className="mx-auto" />
        </div>
      )}
      <div className="relative w-full max-w-xl rounded-2xl border-4 border-wood-900 bg-kinari-50/95 px-6 py-8 shadow-2xl">
        <p className="font-bold text-shu-700 tracking-[0.3em]">{t.app.tagline}</p>
        <h1 className="mt-2 font-bold text-4xl text-ink tracking-wider sm:text-5xl">
          {t.app.name}
        </h1>
        <p className="mx-auto mt-4 max-w-md whitespace-pre-line text-ink leading-relaxed">
          {t.app.lead}
        </p>
        <SoundChoice />
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
        <SavedTrips />
      </div>
    </main>
  );
}
