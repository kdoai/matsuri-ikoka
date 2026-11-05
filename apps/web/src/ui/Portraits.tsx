import type { StaffId } from "@matsuri-ikoka/schema";
import { useState } from "react";

// 会話の窓に出す顔の絵。3D のスタッフ（ひよこ・フクロウ・にわとり・スズメ）と旅人のペンギンを、
// 3D のモデルから正面に寄せて描いた静止画（assets/shiori/staff/face_*.webp。旅のしおりと同じ絵）。
// 店で見るスタッフと同じ顔になる。飾りなので読み上げない。

export type Speaker = StaffId | "player";

const urls = import.meta.glob<string>("../../../../assets/shiori/staff/face_*.webp", {
  query: "?url",
  import: "default",
  eager: true,
});

/** 話し手ごとの静止画の名前（assets/3d/scripts/ikoka3d/stills.py の FACES） */
const FACE_FILES: Record<Speaker, string> = {
  concierge: "face_hiyoko",
  researcher: "face_owl",
  scout: "face_hen",
  planner: "face_sparrow",
  player: "face_penguin",
};

export function faceUrl(speaker: Speaker): string | undefined {
  return urls[`../../../../assets/shiori/staff/${FACE_FILES[speaker]}.webp`];
}

/** 丸い枠の顔の絵。絵が読み込めないときは、同じ大きさの空の丸のまま（窓の並びを崩さない） */
export function Portrait({ speaker, className = "" }: { speaker: Speaker; className?: string }) {
  const url = faceUrl(speaker);
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center overflow-hidden rounded-full border-4 border-kinari-50 bg-gradient-to-b from-[#fde9b8] to-[#f3c98b] shadow-[0_4px_14px_rgb(0_0_0/0.28)] ring-2 ring-wood-700/60 ${className}`}
    >
      {url === undefined || failed === url ? null : (
        <img
          src={url}
          alt=""
          draggable={false}
          decoding="async"
          onError={() => setFailed(url)}
          className="size-full select-none object-cover"
        />
      )}
    </span>
  );
}
