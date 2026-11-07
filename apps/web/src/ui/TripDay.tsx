import type { LatLng } from "@matsuri-ikoka/schema";
import { Clock, MapPin, TrainFront } from "lucide-react";
import { useState } from "react";
import { useTripDayGlance } from "../state/clock";
import { readLocationOnce } from "../state/location";
import { useActions, useApp, useT } from "../state/react";
import { buttonSecondary } from "./common";
import { focusGuideDialogue } from "./GuideDialogue";

// 旅の当日に最初に見せる札：次の予定・出発の時刻・帰りの最終。
// 旅程は手元にあるものだけを使うので、電波がなくても読める。
// 現在地は、利用者が「いる場所から相談する」を押したときだけ、その場で1回読む。保存しない。

/** 旅の日の札。旅の日かどうかは、サーバーの返事を待たず、手元の旅程と時計だけで決める */
export function TripDayCard() {
  const t = useT();
  const actions = useActions();
  const availability = useApp((state) => state.guide.availability);
  const streaming = useApp((state) => state.guide.streaming);
  const glance = useTripDayGlance();
  const [note, setNote] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  if (glance === null) return null;
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
                  : lastReturn.status === "passed"
                    ? m.lastReturnPassed(lastReturn.station, lastReturn.departBy)
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
