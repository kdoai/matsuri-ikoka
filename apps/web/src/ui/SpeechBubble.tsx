import type { StaffId } from "@matsuri-ikoka/schema";
import type { ReactNode } from "react";
import { Portrait } from "./Portraits";

// 店の中で、話している人の頭の上に出す吹き出し。白い丸い板に、話している人を指すしっぽを付け、
// 左上に顔の絵つきの名前の札、右下に「つづく」の ▼ を置く。
// 位置は 3D の中から data-bubble を手がかりに transform で書き込むので、出てくる動きは中の板にだけ付ける。
// 動きを減らす設定のときは、▼ の上下の動きも出てくる動きも止める。

export function SpeechBubble({
  speaker,
  name,
  chatter,
  children,
}: {
  speaker: StaffId;
  name: string;
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
