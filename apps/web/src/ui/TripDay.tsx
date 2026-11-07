import type { LatLng } from "@matsuri-ikoka/schema";
import { Clock, MapPin, TrainFront } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useActions, useApp, useT } from "../state/react";
import { japanClock, tripDayGlance } from "../state/tripDay";
import { buttonSecondary } from "./common";
import { focusGuideDialogue } from "./GuideDialogue";

// 旅の当日に最初に見せる札：次の予定・出発の時刻・帰りの最終。
// 旅程は手元にあるものだけを使うので、電波がなくても読める。
// 現在地は、利用者が「いる場所から相談する」を押したときだけ、その場で1回読む。保存しない。

/** 現在地を1回だけ読む。断られた・読めない・時間切れなら null（推測で埋めない） */
function readLocationOnce(): Promise<LatLng | null> {
  const geolocation = typeof navigator === "undefined" ? undefined : navigator.geolocation;
  if (geolocation === undefined) return Promise.resolve(null);
  return new Promise((resolve) => {
    geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
      () => resolve(null),
      // 細かさは要らない（丸めて送る）。古い位置は使わない
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 0 },
    );
  });
}

/** 分ごとに今の時刻を読み直す */
function useJapanClock(): { date: string; time: string } {
  const [clock, setClock] = useState(() => japanClock());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(japanClock()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return clock;
}

export function TripDayCard() {
  const t = useT();
  const actions = useActions();
  const itinerary = useApp((state) => state.itinerary.current);
  const phase = useApp((state) => state.guide.phase);
  const availability = useApp((state) => state.guide.availability);
  const streaming = useApp((state) => state.guide.streaming);
  const clock = useJapanClock();
  const [note, setNote] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const glance = useMemo(
    () => (itinerary === null ? null : tripDayGlance(itinerary, clock)),
    [itinerary, clock],
  );
  if (phase !== "during" || glance === null) return null;
  const m = t.street.tripDay;
  const canTalk = availability === "ready" && !streaming && !locating;

  const talk = (message: string, location?: LatLng) => {
    actions.setGuideDialogue(true);
    window.requestAnimationFrame(focusGuideDialogue);
    void actions.sendGuide(message, location === undefined ? undefined : { location });
  };

  const askFromHere = async () => {
    setLocating(true);
    setNote(null);
    // 位置の許可は、ブラウザがその都度たずねる。許可しなくても、駅の名前で相談を続ける
    const location = await readLocationOnce();
    setLocating(false);
    if (location === null) {
      setNote(m.whereDenied);
      talk(m.whereDeniedMessage);
    } else {
      talk(m.whereMessage, location);
    }
  };

  const { next, departure, lastReturn } = glance;
  return (
    <section
      className="mb-3 rounded-2xl border-2 border-shu-600 bg-white/95 p-3 text-ink shadow-soft"
      aria-labelledby="trip-day-title"
      data-testid="trip-day"
    >
      <h3 id="trip-day-title" className="font-bold text-base">
        {m.title}
      </h3>
      <dl className="mt-2 grid gap-2 text-sm">
        <div className="flex gap-2" data-testid="trip-day-next">
          <Clock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-shu-700" />
          <div className="min-w-0">
            <dt className="font-bold">{next?.now ? m.nowDoing : m.next}</dt>
            <dd>{next === null ? m.noNext : `${next.start}–${next.end} ${next.name}`}</dd>
          </div>
        </div>
        <div className="flex gap-2" data-testid="trip-day-departure">
          <TrainFront aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-shu-700" />
          <div className="min-w-0">
            <dt className="font-bold">{m.departure}</dt>
            <dd>
              {departure === null
                ? m.noDeparture
                : [
                    departure.at,
                    departure.from !== null && departure.to !== null
                      ? m.fromTo(departure.from, departure.to)
                      : null,
                    departure.line,
                  ]
                    .filter((part) => part !== null)
                    .join(" ")}
            </dd>
          </div>
        </div>
        {lastReturn.status === "none" ? null : (
          <div className="flex gap-2" data-testid="trip-day-last-return">
            <TrainFront aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-shu-700" />
            <div className="min-w-0">
              <dt className="font-bold">{m.lastReturn}</dt>
              <dd>
                {lastReturn.status === "known"
                  ? m.lastReturnAt(lastReturn.station, lastReturn.departBy)
                  : m.lastReturnUnknown}
              </dd>
            </div>
          </div>
        )}
      </dl>
      <p className="mt-2 text-ink-soft text-xs">{m.offline}</p>
      {availability === "ready" ? (
        <div className="mt-3 grid gap-2">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonSecondary}
              disabled={!canTalk}
              onClick={() => void askFromHere()}
              data-testid="trip-day-where"
            >
              <MapPin aria-hidden="true" className="mr-1 inline size-4" />
              {m.where}
            </button>
            <button
              type="button"
              className={buttonSecondary}
              disabled={!canTalk}
              onClick={() => talk(m.lateMessage)}
              data-testid="trip-day-late"
            >
              {m.late}
            </button>
          </div>
          <p className="text-ink-soft text-xs">{m.whereNote}</p>
          {note === null ? null : (
            <p className="text-sm" role="status">
              {note}
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
