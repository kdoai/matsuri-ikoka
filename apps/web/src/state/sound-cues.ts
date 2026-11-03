import { STAFF_IDS } from "@matsuri-ikoka/schema";
import type { AppData } from "./types";

/** 効果音は3種類だけ：太鼓・拍子木・はんこ */
export const SOUND_KINDS = ["taiko", "hyoshigi", "hanko"] as const;
export type SoundKind = (typeof SOUND_KINDS)[number];

/**
 * 状態の変化から、鳴らす効果音を決める。
 * スタッフが動き出したら拍子木、候補が届いたら太鼓、旅程ができたとき・再確認・しおりの完成ではんこ。
 */
export function soundCues(previous: AppData, next: AppData): SoundKind[] {
  const cues = new Set<SoundKind>();
  if (
    STAFF_IDS.some(
      (id) => next.staff[id].phase === "walking" && previous.staff[id].phase !== "walking",
    )
  ) {
    cues.add("hyoshigi");
  }
  if (next.candidates !== previous.candidates && next.candidates.length > 0) {
    cues.add("taiko");
  }
  if (
    next.itinerary.current !== previous.itinerary.current ||
    (next.verify.result !== null && previous.verify.result === null) ||
    (next.ui.celebrating && !previous.ui.celebrating)
  ) {
    cues.add("hanko");
  }
  return [...cues];
}
