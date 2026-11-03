import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useRef } from "react";
import { useApp, useT } from "../state/react";
import { type MapPoint, mapPoints } from "../state/selectors";

// 地図：Leaflet と OpenStreetMap のタイル。帰属の表示は必ず出す。
// ピンの名前などの文字は textContent で入れ、HTML として埋め込まない。

const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';

function pinIcon(point: MapPoint): L.DivIcon {
  const size = point.kind === "venue" ? 34 : point.kind === "spot" ? 22 : 28;
  const element = document.createElement("div");
  element.className = `map-pin map-pin--${point.kind}`;
  element.style.width = `${size}px`;
  element.style.height = `${size}px`;
  element.textContent = point.order === null ? "" : String(point.order);
  return L.divIcon({ html: element, className: "", iconSize: [size, size] });
}

function tooltip(text: string): HTMLElement {
  const element = document.createElement("span");
  element.textContent = text;
  return element;
}

interface MapViewProps {
  /** しおりの紙面や小さな地図では、地図を動かせないようにする */
  interactive?: boolean;
  heightClass?: string;
  /** 地点の文字の一覧を出すか（小さな地図では、旅程のパネルで読めるので出さない） */
  showPlaces?: boolean;
  /** 地図の枠の飾り（小さな地図では外側の余白と枠を付けない） */
  framed?: boolean;
}

export default function MapView({
  interactive = true,
  heightClass = "h-80",
  showPlaces = true,
  framed = true,
}: MapViewProps) {
  const t = useT();
  const itinerary = useApp((state) => state.itinerary.current);
  const spots = useApp((state) => state.spots);
  const points = useMemo(() => mapPoints(itinerary, spots), [itinerary, spots]);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    const map = L.map(container, {
      zoomControl: interactive,
      dragging: interactive,
      scrollWheelZoom: false,
      doubleClickZoom: interactive,
      touchZoom: interactive,
      boxZoom: interactive,
      keyboard: interactive,
      attributionControl: true,
    });
    map.attributionControl.setPrefix(false);
    L.tileLayer(TILE_URL, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, [interactive]);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (map === null || layer === null) {
      return;
    }
    layer.clearLayers();
    if (points.length === 0) {
      map.setView([35.68, 139.76], 5);
      return;
    }
    const route = points.filter((point) => point.order !== null);
    if (route.length > 1) {
      L.polyline(
        route.map((point): L.LatLngTuple => [point.lat, point.lng]),
        { color: "#213c63", weight: 3, opacity: 0.7, dashArray: "6 6" },
      ).addTo(layer);
    }
    for (const point of points) {
      const label = point.order === null ? point.name : `${point.order}. ${point.name}`;
      L.marker([point.lat, point.lng], {
        icon: pinIcon(point),
        title: label,
        alt: label,
        keyboard: interactive,
        zIndexOffset: point.kind === "venue" ? 1000 : point.kind === "spot" ? -100 : 0,
      })
        .bindTooltip(tooltip(label), { direction: "top", offset: [0, -14] })
        .addTo(layer);
    }
    map.fitBounds(L.latLngBounds(points.map((point): L.LatLngTuple => [point.lat, point.lng])), {
      padding: [28, 28],
      maxZoom: 16,
    });
  }, [points, interactive]);

  // 動かせる地図はマーカーやズームを操作できるので、画像（img）としては扱わない
  const mapRole = interactive
    ? ({ role: "region", "aria-label": t.map.label } as const)
    : ({ role: "img", "aria-label": t.map.label } as const);
  const ordered = points.filter((point) => point.order !== null);
  const extra = points.filter((point) => point.order === null);

  return (
    <div className={framed ? "space-y-2 p-3 print:space-y-1 print:p-0" : ""} data-testid="map-view">
      <div
        ref={containerRef}
        className={`${heightClass} w-full overflow-hidden ${framed ? "rounded-xl ring-1 ring-wood-300" : ""}`}
        {...mapRole}
      />
      {/* 地図の内容は、文字でも読めるようにする */}
      {!showPlaces ? null : points.length === 0 ? (
        <p className="text-ink-soft">{t.map.noLocations}</p>
      ) : (
        <section aria-label={t.map.places}>
          <h3 className="font-bold text-ai-700 text-sm">{t.map.places}</h3>
          <ol
            className="mt-1 space-y-0.5 text-sm print:columns-2 print:gap-x-3"
            data-testid="map-places"
          >
            {ordered.map((point) => (
              <li key={point.key} className="flex gap-2">
                <span
                  aria-hidden="true"
                  className={`grid size-5 shrink-0 place-items-center rounded-full font-bold text-[11px] text-white ${
                    point.kind === "venue" ? "bg-shu-600" : "bg-ai-700"
                  }`}
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
            <p className="mt-1 text-ink-soft text-sm">
              {t.map.spot}：{extra.map((point) => point.name).join("、")}
            </p>
          ) : null}
        </section>
      )}
    </div>
  );
}
