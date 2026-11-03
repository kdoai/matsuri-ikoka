import type { RouteShape, ShioriTrip } from "./trip";

// 旅のかたちの図。泊まる地域の並びと、出発・終わりの場所から、自作の図の点と線を決める（外の地図は使わない）。
// 座標は 200 x 100 の枠で持ち、画面では横:縦 = 2:1 の箱に重ねる。

export type StopKind = "start" | "end" | "start_end" | "area";

export interface RouteStop {
  kind: StopKind;
  /** 地域の番号（巡る順、1から）。出発と終わりは null */
  number: number | null;
  label: string;
  sub: string;
  /** この地域にいる間に祭りの日がある */
  festival: boolean;
  x: number;
  y: number;
}

export interface RouteView {
  shape: RouteShape;
  shapeLabel: string;
  stops: RouteStop[];
  /** 道の線（SVG の path の d） */
  path: string;
}

export const ROUTE_SHAPE_LABELS: Record<RouteShape, string> = {
  stay: "ずっと一か所に泊まる旅",
  loop: "地域を巡る旅",
  via: "目的地へ向かう途中で祭りに寄る旅",
};

interface AreaGroup {
  area: string;
  nights: number;
  festival: boolean;
}

/** 続けて同じ地域に泊まる夜をまとめる */
export function stayGroups(trip: Pick<ShioriTrip, "days">): AreaGroup[] {
  const groups: AreaGroup[] = [];
  const groupOfNight: number[] = [];
  trip.days.forEach((day) => {
    if (day.stay === null) return;
    const last = groups[groups.length - 1];
    if (last && last.area === day.stay.area) last.nights += 1;
    else groups.push({ area: day.stay.area, nights: 1, festival: false });
    groupOfNight.push(groups.length - 1);
  });
  trip.days.forEach((day, i) => {
    if (!day.items.some((item) => item.type === "festival")) return;
    // その日の夜に泊まる地域。最後の日（帰る日）は前の夜の地域
    const night = day.stay !== null ? i : i - 1;
    const index = groupOfNight[Math.max(0, Math.min(night, groupOfNight.length - 1))];
    const group = index === undefined ? undefined : groups[index];
    if (group) group.festival = true;
  });
  return groups;
}

export function routeShapeOf(trip: ShioriTrip, groups: readonly AreaGroup[]): RouteShape {
  if (trip.style.shape) return trip.style.shape;
  if (new Set(groups.map((g) => g.area)).size <= 1) return "stay";
  return trip.returnTo === trip.origin ? "loop" : "via";
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** 点を通るなめらかな線（Catmull-Rom を3次ベジェにする） */
export function smoothPath(points: readonly { x: number; y: number }[], closed: boolean): string {
  const n = points.length;
  if (n === 0) return "";
  const at = (i: number) =>
    points[closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i))] as { x: number; y: number };
  const first = at(0);
  let d = `M${r1(first.x)} ${r1(first.y)}`;
  const segments = closed ? n : n - 1;
  for (let i = 0; i < segments; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += `C${r1(c1.x)} ${r1(c1.y)} ${r1(c2.x)} ${r1(c2.y)} ${r1(p2.x)} ${r1(p2.y)}`;
  }
  return closed ? `${d}Z` : d;
}

/** 旅のかたちの図。日帰りでは出さない（null） */
export function routeOf(trip: ShioriTrip): RouteView | null {
  if (trip.days.length < 2) return null;
  const groups = stayGroups(trip);
  const shape = routeShapeOf(trip, groups);
  const areas = groups.map(
    (g, i): Omit<RouteStop, "x" | "y"> => ({
      kind: "area",
      number: i + 1,
      label: g.area,
      sub: `${g.nights}泊`,
      festival: g.festival,
    }),
  );
  let stops: Omit<RouteStop, "x" | "y">[];
  let positions: { x: number; y: number }[];
  if (shape === "loop") {
    stops = [
      { kind: "start_end", number: null, label: trip.origin, sub: "出発・帰着", festival: false },
      ...areas,
    ];
    // 楕円の上に、下の真ん中から時計回りに並べる
    positions = stops.map((_, i) => {
      const angle = Math.PI / 2 + (2 * Math.PI * i) / stops.length;
      return { x: 100 + 72 * Math.cos(angle), y: 50 + 30 * Math.sin(angle) };
    });
  } else {
    stops = [
      { kind: "start", number: null, label: trip.origin, sub: "出発", festival: false },
      ...areas,
      { kind: "end", number: null, label: trip.returnTo, sub: "旅の終わり", festival: false },
    ];
    // 左から右へ、ゆるい波の上に並べる
    positions = stops.map((_, i) => ({
      x: 16 + (168 * i) / Math.max(1, stops.length - 1),
      y: 50 + (i % 2 === 0 ? -14 : 14) * (i === 0 || i === stops.length - 1 ? 0.4 : 1),
    }));
  }
  return {
    shape,
    shapeLabel: ROUTE_SHAPE_LABELS[shape],
    stops: stops.map((s, i) => ({ ...s, ...(positions[i] as { x: number; y: number }) })),
    path: smoothPath(positions, shape === "loop"),
  };
}
