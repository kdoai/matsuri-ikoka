import { useId } from "react";
import type { ModelName } from "../scenes/modelFiles";
import { useT } from "../state/react";
import { useModelProgress } from "./scene3d";

// 3D の店を読み込んでいる間の表示。提灯の明かりがともっていくように、取ったモデルの割合を出す。
// 取り終えたあと（形とテクスチャを GPU に送る間）は「整えています」にする。
// 進みは文字（○%）と進みの棒でも分かる。提灯の絵は飾りなので読み上げない。

/** 提灯の灯の明るさ（0〜1）。読み込みの初めから少しだけともり、取り終えると満ちる */
export function lanternLight(progress: number): number {
  const p = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  return 0.15 + 0.85 * p;
}

/** 赤い紙張りの提灯。中の灯が読み込みの進みに合わせて明るくなる。動きを減らす設定では揺らがない */
function Lantern({ light }: { light: number }) {
  const clip = useId();
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 32 44"
      className="h-11 w-8 shrink-0"
      style={{ filter: `drop-shadow(0 0 ${2 + 8 * light}px rgb(233 181 40 / ${0.7 * light}))` }}
    >
      <defs>
        <clipPath id={clip}>
          <rect x="3" y="8" width="26" height="28" rx="12" />
        </clipPath>
      </defs>
      {/* 吊るす紐 */}
      <path d="M16 0v4" className="stroke-wood-900" strokeWidth="1.5" />
      {/* 紙の胴と、中からの灯 */}
      <rect x="3" y="8" width="26" height="28" rx="12" className="fill-shu-500" />
      <g clipPath={`url(#${clip})`}>
        <ellipse
          cx="16"
          cy="22"
          rx="11"
          ry="12"
          className="fill-yamabuki-200 motion-safe:animate-pulse"
          style={{ opacity: light }}
        />
        {/* 竹の骨 */}
        {[12, 16, 20, 24, 28, 32].map((y) => (
          <path
            key={y}
            d={`M2 ${y}h28`}
            className="stroke-shu-700"
            strokeWidth="1"
            opacity="0.55"
          />
        ))}
      </g>
      <rect
        x="3"
        y="8"
        width="26"
        height="28"
        rx="12"
        fill="none"
        className="stroke-wood-900"
        strokeWidth="1.5"
      />
      {/* 上と下の枠 */}
      <rect x="8.5" y="4" width="15" height="5" rx="1.2" className="fill-wood-900" />
      <rect x="8.5" y="35" width="15" height="5" rx="1.2" className="fill-wood-900" />
      {/* 房 */}
      <path d="M16 40v4" className="stroke-yamabuki-400" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

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
      <Lantern light={lanternLight(progress)} />
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
