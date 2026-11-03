import { useEffect, useRef } from "react";
import { useT } from "../state/react";
import { ChatLog } from "./ChatPanel";
import { buttonQuiet } from "./common";
import { StaffList } from "./StaffPanel";

// 会話の記録。これまでのやりとり・作業の記録と、店内のスタッフ全員のようすを文字で読む。

export function Backlog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-ink/50 p-3" data-testid="backlog">
      <section
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="backlog-title"
        className="flex max-h-[90dvh] w-full max-w-3xl flex-col rounded-[1.75rem] border-4 border-wood-700 bg-kinari-50 p-4 shadow-2xl"
      >
        <div className="flex items-center justify-between gap-2">
          <h2
            id="backlog-title"
            ref={headingRef}
            tabIndex={-1}
            className="font-bold text-ink text-lg"
          >
            {t.dialogue.log}
          </h2>
          <button type="button" className={`${buttonQuiet} bg-white`} onClick={onClose}>
            {t.dialogue.closeLog}
          </button>
        </div>
        <div className="mt-2 flex min-h-0 flex-1 flex-col">
          <ChatLog />
        </div>
        <div className="mt-3 border-wood-300 border-t pt-3">
          <StaffList showBubbles />
        </div>
      </section>
    </div>
  );
}
