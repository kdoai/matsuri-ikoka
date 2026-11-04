import type { StaffId } from "@matsuri-ikoka/schema";
import type { ReactNode } from "react";
import { Portrait } from "./Portraits";

// 店の中で、話している人の頭の上に出す吹き出し。白い丸い板に、話している人を指すしっぽを付け、
// 左上に顔の絵つきの名前の札、右下に「つづく」の ▼ を置く。
// 位置は 3D の中から data-bubble を手がかりに transform で書き込むので、出てくる動きは中の板にだけ付ける。
// 動きを減らす設定のときは、▼ の上下の動きも出てくる動きも止める。
// 作業中のスタッフは、右上にいまのようす（調べている など）の札を付ける。

export function SpeechBubble({
  speaker,
  name,
  status,
  chatter,
  children,
}: {
  speaker: StaffId;
  name: string;
  /** いまのようす（調べている・確かめている・まとめている など） */
  status?: string | undefined;
  /** おしゃべりの何番目の文か（通しテストで見分ける） */
  chatter?: number;
  children: ReactNode;
}) {
  return (
    <div
      data-bubble={speaker}
      data-chatter={chatter}
      data-testid="speech-bubble"
      className="absolute top-0 left-0 w-max max-w-[min(20rem,80vw)] pt-4"
    >
      <div className="speech-bubble relative animate-fade rounded-[1.75rem] bg-white px-5 pt-4 pb-5 text-ink shadow-lift motion-reduce:animate-none">
        <p className="-top-4 absolute left-3 flex items-center gap-1.5 rounded-full border-2 border-white bg-ai-800 py-0.5 pr-3 pl-0.5 font-bold text-base text-kinari-50 shadow-soft">
          <Portrait speaker={speaker} className="size-7" />
          {name}
        </p>
        {status === undefined ? null : (
          <span
            data-testid="staff-status"
            className="-top-3.5 absolute right-3 rounded-full border-2 border-white bg-yamabuki-400 px-2.5 py-0.5 font-bold text-ink text-xs shadow-soft"
          >
            {status}
          </span>
        )}
        <p className="font-bold text-base leading-relaxed">{children}</p>
        <span
          aria-hidden="true"
          className="absolute right-4 bottom-1.5 animate-bounce text-sm text-yamabuki-400 leading-none motion-reduce:animate-none"
        >
          ▼
        </span>
      </div>
    </div>
  );
}

/**
 * 吹き出しを出していないスタッフの頭の上の札。いまのようす（調べている・まとめている など）だけを出す。
 * 位置は吹き出しと同じく、3D の中から data-bubble を手がかりに書き込む
 */
export function StatusChip({
  speaker,
  activity,
  children,
}: {
  speaker: StaffId;
  activity?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div
      data-bubble={speaker}
      data-testid="staff-status"
      data-activity={activity}
      className="absolute top-0 left-0 w-max pb-1"
    >
      <span className="block animate-fade rounded-full border-2 border-white bg-yamabuki-400 px-3 py-0.5 font-bold text-ink text-sm shadow-soft motion-reduce:animate-none">
        {children}
      </span>
    </div>
  );
}
