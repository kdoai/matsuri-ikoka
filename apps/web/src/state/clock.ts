import { useEffect, useMemo } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { useApp } from "./react";
import { japanClock, type TripDayGlance, tripDayGlance } from "./tripDay";

// 日本の今の時刻（分まで）。旅の当日の札と、通りを 2D にするかの判断が、同じ時計を読む。
// 分の頭にそろえて進め、画面に戻ったとき（visibilitychange）にも読み直す。
// サーバーの返事を待たず、手元の旅程とこの時計だけで、旅の日かどうかを決める。

export type JapanClock = { date: string; time: string };

const clockStore = createStore<JapanClock>(() => japanClock());

const sameClock = (a: JapanClock, b: JapanClock) => a.date === b.date && a.time === b.time;

function tick(): void {
  const next = japanClock();
  if (!sameClock(clockStore.getState(), next)) clockStore.setState(next, true);
}

let users = 0;
let stop: (() => void) | null = null;

/** 時計を動かす。使う部品がなくなったら止める */
function startClock(): () => void {
  users += 1;
  if (users === 1) {
    tick();
    let interval: number | undefined;
    // 分の頭にそろえる
    const first = window.setTimeout(
      () => {
        tick();
        interval = window.setInterval(tick, 60_000);
      },
      60_000 - (Date.now() % 60_000) + 50,
    );
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    stop = () => {
      window.clearTimeout(first);
      if (interval !== undefined) window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }
  return () => {
    users -= 1;
    if (users === 0) {
      stop?.();
      stop = null;
    }
  };
}

/** 日本の今の時刻。分ごとに変わる */
export function useJapanClock(): JapanClock {
  useEffect(startClock, []);
  return useStore(clockStore);
}

/** 旅の当日の札。旅の日でなければ null（手元の旅程と時計だけで決める） */
export function useTripDayGlance(): TripDayGlance | null {
  const itinerary = useApp((state) => state.itinerary.current);
  const clock = useJapanClock();
  return useMemo(
    () => (itinerary === null ? null : tripDayGlance(itinerary, clock)),
    [itinerary, clock],
  );
}
