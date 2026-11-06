"""祭りの会場の周りの店と宿を、OpenStreetMap の一括データから抜き出す。

使い方（一括データは https://download.geofabrik.de/asia/japan.html から取る）：
    uv run --python 3.12 --with osmium scripts/build_osm_places.py <japan-latest.osm.pbf>

data/festivals の会場から半径 RADIUS_KM の中の、名前のある店と宿だけを
data/places/osm-places.json に書く。出典とライセンスは data/places/README.md。
"""

import json
import math
import sys
from pathlib import Path

import osmium
import osmium.filter

ROOT = Path(__file__).resolve().parent.parent
FESTIVALS = ROOT / "data" / "festivals"
OUTPUT = ROOT / "data" / "places" / "osm-places.json"

# 車で回るときの店の範囲（apps/server/src/domain/nearbySearch.ts の CAR_SPOT_KM）に合わせる
RADIUS_KM = 10
FOOD = {"restaurant", "cafe", "fast_food", "food_court"}
LODGING = {"hotel", "guest_house", "hostel", "motel"}
KEPT_TAGS = (
    "name",
    "name:ja",
    "amenity",
    "tourism",
    "cuisine",
    "opening_hours",
    "website",
    "contact:website",
    "diet:vegetarian",
    "diet:vegan",
    "diet:halal",
)
CELL_DEGREES = 0.1


def cell(lat: float, lng: float) -> tuple[int, int]:
    return (math.floor(lat / CELL_DEGREES), math.floor(lng / CELL_DEGREES))


def distance_km(a_lat: float, a_lng: float, b_lat: float, b_lng: float) -> float:
    dlat = math.radians(b_lat - a_lat)
    dlng = math.radians(b_lng - a_lng)
    h = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(a_lat)) * math.cos(math.radians(b_lat)) * math.sin(dlng / 2) ** 2
    )
    return 6371 * 2 * math.asin(math.sqrt(h))


class Venues:
    """会場の近さをすばやく確かめるため、会場を格子に分けて持つ"""

    def __init__(self, venues: list[tuple[float, float]]) -> None:
        self.cells: dict[tuple[int, int], list[tuple[float, float]]] = {}
        reach = math.ceil(RADIUS_KM / 8 / (CELL_DEGREES * 10)) + 1
        for lat, lng in venues:
            c_lat, c_lng = cell(lat, lng)
            for d_lat in range(-reach, reach + 1):
                for d_lng in range(-reach, reach + 1):
                    self.cells.setdefault((c_lat + d_lat, c_lng + d_lng), []).append((lat, lng))

    def near(self, lat: float, lng: float) -> bool:
        return any(
            distance_km(lat, lng, v_lat, v_lng) <= RADIUS_KM
            for v_lat, v_lng in self.cells.get(cell(lat, lng), [])
        )


def wanted(tags) -> bool:
    if "name" not in tags:
        return False
    return tags.get("amenity") in FOOD or tags.get("tourism") in LODGING


def to_place(kind: str, osm_id: int, lat: float, lng: float, tags) -> dict:
    return {
        "type": kind,
        "id": osm_id,
        "name": tags.get("name:ja") or tags.get("name"),
        "lat": round(lat, 6),
        "lng": round(lng, 6),
        "tags": {key: tags.get(key) for key in KEPT_TAGS if key in tags},
    }


def read_places(path: str, venues: Venues) -> list[dict]:
    """店と宿のタグのある点と建物だけを読む。絞り込みは C++ の側で行うので、全部の点を Python で見ない"""
    places: list[dict] = []
    processor = (
        osmium.FileProcessor(path)
        .with_locations("flex_mem")
        .with_filter(osmium.filter.KeyFilter("amenity", "tourism"))
    )
    for item in processor:
        if not wanted(item.tags):
            continue
        if item.is_node():
            if not item.location.valid():
                continue
            lat, lng = item.location.lat, item.location.lon
            kind = "node"
        elif item.is_way():
            points = [(p.location.lat, p.location.lon) for p in item.nodes if p.location.valid()]
            if not points:
                continue
            lat = sum(p[0] for p in points) / len(points)
            lng = sum(p[1] for p in points) / len(points)
            kind = "way"
        else:
            continue
        if venues.near(lat, lng):
            places.append(to_place(kind, item.id, lat, lng, item.tags))
    return places


def load_venues() -> list[tuple[float, float]]:
    venues = []
    for file in sorted(FESTIVALS.glob("*.json")):
        festival = json.loads(file.read_text(encoding="utf-8"))
        venue = festival.get("venue") or {}
        if festival.get("optOut") is True:
            continue
        if isinstance(venue.get("lat"), (int, float)) and isinstance(venue.get("lng"), (int, float)):
            venues.append((venue["lat"], venue["lng"]))
    return venues


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("使い方：build_osm_places.py <japan-latest.osm.pbf>")
    venues = load_venues()
    places = read_places(sys.argv[1], Venues(venues))
    places.sort(key=lambda p: (p["type"], p["id"]))
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        json.dumps(
            {
                "source": "OpenStreetMap contributors",
                "license": "ODbL-1.0",
                "licenseUrl": "https://www.openstreetmap.org/copyright",
                "extractedFrom": Path(sys.argv[1]).name,
                "places": places,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
        + "\n",
        encoding="utf-8",
    )
    food = sum(1 for p in places if "amenity" in p["tags"])
    print(f"会場 {len(venues)} か所、店 {food} 件、宿 {len(places) - food} 件を書きました")


if __name__ == "__main__":
    main()
