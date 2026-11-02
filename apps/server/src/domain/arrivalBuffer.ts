import type { Festival } from "@matsuri-ikoka/schema";

/** 規模ランクごとの到着の余裕（分）。会場に着いてから見やすい場所に落ち着くまでの時間 */
export const ARRIVAL_BUFFER_BY_SCALE: Readonly<Record<Festival["scaleTier"], number>> = {
  XS: 15,
  S: 15,
  M: 30,
  L: 60,
};

/** 花火大会は場所取りがあるので、余裕を足す（分） */
export const FIREWORKS_EXTRA_MINUTES = 30;

/** 祭りの開始の何分前に会場へ着いておくか */
export function arrivalBufferMinutes(festival: Pick<Festival, "scaleTier" | "category">): number {
  const base = ARRIVAL_BUFFER_BY_SCALE[festival.scaleTier];
  return festival.category === "fireworks" ? base + FIREWORKS_EXTRA_MINUTES : base;
}
