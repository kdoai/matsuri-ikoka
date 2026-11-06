import type { ReactNode } from "react";

// 店の画面の右に重ねる窓の枠。木の縁に生成りの紙を張り、頭の中ほどに見出しの札を下げる。
// 店内のようすと、コンシェルジュの豆知識（クイズ）の窓で同じ枠を使う。

/**
 * 窓の高さが足りないとき、中でスクロールする部分に付ける。
 * 枠は縦に並べて縮められるようにしてあるので、見出しの札は切らずに、中身だけを動かせる
 */
export const windowScroll =
  "-mx-1 min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain px-1 py-0.5";

/** 札を吊る金具（飾りなので読み上げない） */
function Hook({ side }: { side: "left" | "right" }) {
  return (
    <span
      aria-hidden="true"
      className={`absolute -top-2 size-3.5 rounded-full border-2 border-wood-700 bg-yamabuki-400 ${
        side === "left" ? "left-7" : "right-7"
      }`}
    />
  );
}

export function GameWindow({
  title,
  titleId,
  tone = "ai",
  children,
  className = "",
  testId,
  ariaLabel,
  onMouseEnter,
  onMouseLeave,
}: {
  /** 見出しの札の中身（絵と文字） */
  title: ReactNode;
  /** 見出しを窓の名前にするときの id（ariaLabel を渡したときは使わない） */
  titleId?: string;
  tone?: "ai" | "shu";
  children: ReactNode;
  className?: string;
  testId?: string;
  ariaLabel?: string;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  return (
    <section
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel === undefined ? titleId : undefined}
      className={`relative flex min-h-0 w-full flex-col rounded-[1.4rem] border-4 border-wood-300 bg-kinari-50/95 px-3 pt-6 pb-3 text-sm shadow-xl ring-2 ring-wood-700/40 backdrop-blur-sm ${className}`}
      data-testid={testId}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <Hook side="left" />
      <Hook side="right" />
      <h2
        id={titleId}
        className={`absolute -top-4 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full border-2 border-kinari-50 px-4 py-0.5 font-bold text-base text-kinari-50 shadow-md ${
          tone === "ai" ? "bg-ai-800" : "bg-shu-600"
        }`}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}
