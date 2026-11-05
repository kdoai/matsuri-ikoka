# 旅のしおりの素材

旅のしおり（`apps/server/src/shiori/`）が使う素材です。使い方は [旅のしおりの仕様](../../docs/spec/shiori.md) にあります。

| 場所      | 中身                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `svg/`    | 表紙の絵（`motif-<祭りの種類>`）、季節の飾り（`season-<季節>`）、町の風景（`scene-town`）、見出しの小さな絵（`spot-*`：提灯・鳥居・巾着・団子）、アイコン（`icon-*`）、枠や飾り（`deco-*`：提灯の房・青海波の角・麻の葉・うちわ・雲など）。すべてこのリポジトリのために手で書いた SVG |
| `staff/`  | スタッフ（ひよこ・フクロウ・にわとり・スズメ）と旅人のペンギンの静止画（透過の WebP）                                                   |
| `fonts/`  | Zen Maru Gothic の Medium と Black（WOFF2）と、そのライセンス（`OFL.txt`）                                                                  |

## SVG の決まり

- 色は `currentColor`（線と文字）と CSS 変数で付ける。祭りの絵は `--c1`〜`--c3`、季節の飾りは `--s1`〜`--s3`（しおりの色は季節ごとに決まる）
- `<script>`・`<style>`・`<image>`・`<foreignObject>`・`href`・`url()`・イベントの属性は使わない（読み込むときに断る）
- `viewBox` を必ず書く。アイコンは `0 0 24 24`、祭りの絵・季節の飾り・見出しの小さな絵は `0 0 200 200`、町の風景は `0 0 400 120`
- 写真や、ほかの作品をなぞった絵は使わない。形はコードと手で書き起こす

## スタッフの静止画

`assets/3d` の Blender のスクリプトで書き出します。全員を同じ正射影のカメラで描くので、ページの上で大きさがそろいます。

```bash
blender -b --factory-startup --python-exit-code 1 -P assets/3d/scripts/build.py -- --target stills
```

ポーズ・表情・持たせる小物は `assets/3d/scripts/ikoka3d/stills.py` の `STILLS` で決めています。

`face_<種類>.webp`（ひよこ・フクロウ・にわとり・スズメ・ペンギン）は、顔に寄せた正面の正方形の静止画です。
しおりの吹き出しと、画面の会話の窓の顔の絵（`apps/web/src/ui/Portraits.tsx`）が同じ絵を使います。
顔だけを作り直すときは `--target faces` にします。表情は `stills.py` の `FACES` で決めています。

## フォント

- Zen Maru Gothic（Copyright 2021 The Zen Maru Gothic Project Authors）。SIL Open Font License 1.1 で、`OFL.txt` が全文
- 元のファイルは [google/fonts の `ofl/zenmarugothic`](https://github.com/google/fonts/tree/main/ofl/zenmarugothic)。すべての文字を残したまま、ヒンティングを外して WOFF2 にしています（予約されたフォント名はありません）
- しおりの PDF には、使った文字だけが埋め込まれます
