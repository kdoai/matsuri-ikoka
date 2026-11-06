# 店と宿の一覧（OpenStreetMap）

`osm-places.json` は、祭りの会場から半径 10km の中の、名前のある店（`amenity`：restaurant・cafe・fast_food・food_court）と宿（`tourism`：hotel・guest_house・hostel・motel）を、OpenStreetMap から抜き出した一覧です。

- 出典：© OpenStreetMap contributors（<https://www.openstreetmap.org/copyright>）
- ライセンス：このファイルのデータは [Open Database License（ODbL）1.0](https://opendatacommons.org/licenses/odbl/1-0/) で公開します。リポジトリのほかの部分のライセンスとは別です
- 取得元：[Geofabrik の日本の一括データ](https://download.geofabrik.de/asia/japan.html)

## 作り直す

祭りが増えたときや、データが古くなったときに作り直します。

```bash
uv run --python 3.12 --with osmium scripts/build_osm_places.py <japan-latest.osm.pbf>
```

使い方と判断の理由は [ADR 0010](../../docs/adr/0010-place-data-sources.md) にあります。
