import { STAFF_IDS, type StaffId } from "@matsuri-ikoka/schema";
import { useEffect, useRef, useState } from "react";

// 待ち時間の時計。店内のようすと豆知識の窓の両方で、経過時間を同じ数え方で出す。

/** 秒を「1:05」の形にする */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** 返答を待っている間だけ、1秒ごとに描き直すための今の時刻 */
export function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

/** 返答を待ち始めた時刻と、スタッフごとに動き始めた時刻 */
export function useWaitClock(streaming: boolean, busy: readonly StaffId[]) {
  const started = useRef<number | null>(null);
  const staffStarted = useRef<Partial<Record<StaffId, number>>>({});
  if (streaming && started.current === null) started.current = Date.now();
  if (!streaming) started.current = null;
  for (const id of STAFF_IDS) {
    if (busy.includes(id)) staffStarted.current[id] ??= Date.now();
    else delete staffStarted.current[id];
  }
  return { started: started.current, staffStarted: staffStarted.current };
}
