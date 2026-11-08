import { type ComponentType, lazy, useMemo, useSyncExternalStore } from "react";
import {
  type ModelName,
  modelProgress,
  modelProgressVersion,
  subscribeModelProgress,
} from "../scenes/modelFiles";
import type { ShopSceneProps, StreetSceneProps } from "../state/scene";

// 3D の部品（src/scenes/）は遅れて読み込む。画面は 3D の店と通りが主で、2D に切り替えない。
// 動きを減らす設定でも 3D を出し、カメラの動きだけを抑える。WebGL が使えないときは、その知らせを出す。

const shopModules = import.meta.glob<{ default: ComponentType<ShopSceneProps> }>(
  "../scenes/ShopScene.tsx",
);
const storefrontModules = import.meta.glob<{
  default: ComponentType<{ testId?: string; onReady?: () => void }>;
}>("../scenes/StorefrontScene.tsx");

const streetModules = import.meta.glob<{ default: ComponentType<StreetSceneProps> }>(
  "../scenes/StreetScene.tsx",
);

const loadShop = shopModules["../scenes/ShopScene.tsx"];
const loadStreet = streetModules["../scenes/StreetScene.tsx"];
const loadStorefront = storefrontModules["../scenes/StorefrontScene.tsx"];

export const ShopScene = loadShop === undefined ? null : lazy(loadShop);
export const StorefrontScene = loadStorefront === undefined ? null : lazy(loadStorefront);
export const StreetScene = loadStreet === undefined ? null : lazy(loadStreet);

/** 店内の 3D のコードを先に取っておく（店の外観が描けたあと、入店を押す前に） */
export function preloadShopScene(): void {
  void loadShop?.().catch(() => undefined);
}

/** モデルの取り込みの進み具合（0〜1）。取ったバイト数が変わるたびに描き直す */
export function useModelProgress(names: readonly ModelName[]): number {
  useSyncExternalStore(subscribeModelProgress, modelProgressVersion, modelProgressVersion);
  return modelProgress(names);
}

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

/** 3D を描けるか（WebGL が使えるか） */
export function useScene3d(): boolean {
  return useMemo(() => webglAvailable(), []);
}
