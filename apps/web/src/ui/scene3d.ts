import { type ComponentType, lazy, useMemo } from "react";
import type { ShopSceneProps } from "../state/scene";
import { useReducedMotion } from "./hooks";

// 3D の部品（src/scenes/）は遅れて読み込む。最初の画面は 2D で出し、3D は読み込めたら重ねる。
// WebGL が使えないとき・動きを減らす設定のときは、3D を使わない。

const shopModules = import.meta.glob<{ default: ComponentType<ShopSceneProps> }>(
  "../scenes/ShopScene.tsx",
);
const storefrontModules = import.meta.glob<{ default: ComponentType }>(
  "../scenes/StorefrontScene.tsx",
);

const loadShop = shopModules["../scenes/ShopScene.tsx"];
const loadStorefront = storefrontModules["../scenes/StorefrontScene.tsx"];

export const ShopScene = loadShop === undefined ? null : lazy(loadShop);
export const StorefrontScene = loadStorefront === undefined ? null : lazy(loadStorefront);

let webgl: boolean | null = null;

/** WebGL が使えるか（1回だけ調べる） */
export function webglAvailable(): boolean {
  if (webgl !== null) return webgl;
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    webgl = context !== null;
    context?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    webgl = false;
  }
  return webgl;
}

/** ?scene=2d で、3D を使わない軽い表示にする（性能の低い端末向け） */
export function prefers2d(search: string): boolean {
  return new URLSearchParams(search).get("scene") === "2d";
}

/** 3D の店を出すか */
export function useScene3d(): boolean {
  const reducedMotion = useReducedMotion();
  const supported = useMemo(() => webglAvailable() && !prefers2d(window.location.search), []);
  return supported && !reducedMotion;
}
