import type { ModelName } from "../scenes/modelFiles";
import { useT } from "../state/react";
import { useModelProgress } from "./scene3d";

// 3D の店を読み込んでいる間の表示。提灯の明かりがともっていくように、取ったモデルの割合を出す。
// 取り終えたあと（形とテクスチャを GPU に送る間）は「整えています」にする。

export function SceneLoading({
  models,
  className = "",
}: {
  models: readonly ModelName[];
  className?: string;
}) {
  const t = useT();
  const progress = useModelProgress(models);
  const percent = Math.min(100, Math.floor(progress * 100));
  const preparing = progress >= 1;
  return (
    <div
      role="status"
      data-testid="scene-loading"
      className={`flex items-center gap-3 rounded-full border-2 border-wood-700 bg-kinari-50/95 px-4 py-2 text-ink shadow-lg ${className}`}
    >
      {/* 提灯の明かり */}
      <span
        aria-hidden="true"
        className="h-6 w-5 shrink-0 rounded-[45%] bg-shu-500 shadow-[0_0_14px_4px_rgb(233_181_40/0.5)] ring-2 ring-wood-900 motion-safe:animate-pulse"
      />
      <div className="min-w-44 text-left">
        <p className="font-bold text-sm">
          {preparing ? t.app.preparingScene : t.app.loadingScene(percent)}
        </p>
        <div
          role="progressbar"
          aria-label={t.app.loadingScene(percent)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="mt-1 h-1.5 overflow-hidden rounded-full bg-wood-200"
        >
          <div
            className="h-full rounded-full bg-yamabuki-400 motion-safe:transition-[width] motion-safe:duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
    </div>
  );
}
