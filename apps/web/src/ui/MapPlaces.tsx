import { useMemo } from "react";
import { useApp, useT } from "../state/react";
import { type MapPoint, mapPoints } from "../state/selectors";
import { ReloadButton } from "./ErrorBoundary";

// 地図の地点を文字で読む部品。地図の部品（Leaflet）を読み込めないときにも使うので、Leaflet に頼らない。

/** 地図の内容を、文字でも読めるようにする */
export function MapPlaces({
  points,
  textClass,
}: {
  points: readonly MapPoint[];
  textClass: string;
}) {
  const t = useT();
  if (points.length === 0) return <p className="text-ink-soft">{t.map.noLocations}</p>;
  const ordered = points.filter((point) => point.order !== null);
  const extra = points.filter((point) => point.order === null);
  return (
    <section aria-label={t.map.places}>
      <h3 className={`font-bold text-ai-700 ${textClass}`}>{t.map.places}</h3>
      <ol
        className={`mt-1 space-y-0.5 ${textClass} print:columns-2 print:gap-x-3`}
        data-testid="map-places"
      >
        {ordered.map((point) => (
          <li key={point.key} className="flex gap-2">
            <span
              aria-hidden="true"
              className={`grid shrink-0 place-items-center rounded-full font-bold text-white ${
                textClass === "text-sm" ? "size-5 text-[11px]" : "size-7 text-base"
              } ${point.kind === "venue" ? "bg-shu-600" : "bg-ai-700"}`}
            >
              {point.order}
            </span>
            <span>
              {point.name}
              {point.kind === "venue" ? `（${t.map.venue}）` : null}
            </span>
          </li>
        ))}
      </ol>
      {extra.length > 0 ? (
        <p className={`mt-1 text-ink-soft ${textClass}`}>
          {t.map.spot}：{extra.map((point) => point.name).join("、")}
        </p>
      ) : null}
    </section>
  );
}

/** 地図を出せないときの表示。読み込み直せることを伝え、地点は文字で読めるようにする */
export function MapTrouble() {
  const t = useT();
  const itinerary = useApp((state) => state.itinerary.current);
  const spots = useApp((state) => state.spots);
  const points = useMemo(() => mapPoints(itinerary, spots), [itinerary, spots]);
  return (
    <div className="space-y-2 p-3" data-testid="map-trouble">
      <div className="rounded-xl border-2 border-yamabuki-400 border-dashed bg-white/80 p-3 text-base">
        <p className="font-bold text-ink">{t.map.troubleTitle}</p>
        <p className="mt-1 text-ink-soft">{t.map.troubleBody}</p>
        <ReloadButton className="mt-2" />
      </div>
      <MapPlaces points={points} textClass="text-base" />
    </div>
  );
}
