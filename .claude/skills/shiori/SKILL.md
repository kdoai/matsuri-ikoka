---
name: shiori
description: 旅のしおり（apps/server/src/shiori の HTML と A4 の PDF）を作り直す・直すときの決まりと確かめ方。見た目・ページの並び・動き（CSS のアニメーション）・PDF の改ページを変えるとき、スタッフの静止画や顔の絵を作り直すとき、手元で HTML と PDF を書き出して目で確かめたいときに使う。
---

# 旅のしおり

確定した旅程を、店「たびや」でもらう冊子のような旅のしおりにする。画面で開く HTML（`GET /shiori/:id`）と PDF（`GET /shiori/:id.pdf`）は、同じテンプレートから作る。
仕様は [docs/spec/shiori.md](../../../docs/spec/shiori.md)、素材の決まりは [assets/shiori/README.md](../../../assets/shiori/README.md) にある。

## どこに何があるか

| ファイル                           | 中身                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `apps/server/src/shiori/trip.ts`      | 旅程を、しおりの読む形（日ごとの予定と泊まる地域）にする                               |
| `apps/server/src/shiori/viewModel.ts` | 表示する文字をすべて決める（分からない項目は「分からない」）                           |
| `apps/server/src/shiori/design.ts`    | 色・表紙の絵・ページの並び・ページごとのスタッフを、決まった規則で選ぶ               |
| `apps/server/src/shiori/render.ts`    | HTML。旅程や祭りの文字はすべて `html``…`` の差し込みでエスケープする                   |
| `apps/server/src/shiori/style.ts`     | CSS。`BASE`（止まった姿）と `MOTION`（画面での動き）に分けてある                       |
| `apps/server/src/shiori/pdf.ts`       | Playwright の Chromium で A4 の PDF にする（外へのリクエストなし・スクリプトなし）     |
| `apps/server/src/shiori/preview.ts`   | 手元で、架空の旅の HTML・PDF・画像を書き出す                                           |
| `assets/shiori/`                      | SVG（`<symbol>` にして埋め込む）・フォント・スタッフの静止画と顔の絵                   |

## 作るときの決まり

- 文字はすべて view-model で決め、テンプレートは並べるだけにする。モデルに HTML や CSS を書かせない
- 旅程・祭りのデータ・モデルの文章は信用しない入力。`raw()` は自前の CSS と SVG だけに使う
- 外のものを読み込まない。素材は `assets/…` の相対パスで、SVG は `#s-<名前>` の `<use>` で使う
- スクリプトは使わない（ページの CSP でも止めている）。動きは CSS だけで付ける
- 本文は 10.5pt 以上、白い紙の上で読める濃さにする。情報は文字で伝え、絵や動きだけに頼らない
- 店の世界観：和紙の色の紙に紺の二重の枠と青海波の四隅、表紙に「たびや 旅のしおり」の札と町の風景、各ページの見出しは丸い絵の印つきの紺の帯の札、スタッフのひとことは顔の絵（`face_*.webp`）つきの吹き出し、スタンプ帳に店のスタンプ、最後に裏表紙を置く
- 絵は自分で書いた SVG とスタッフの静止画だけ。写真や権利の分からない絵は使わない
- テストとサンプルは架空の旅（`testTrips.ts`）で書く。URL は `example.com`

## 動きと静止画の両立

しおりは画面で見ると動き、印刷と PDF では動かない1枚の絵として読める。そのための決まり：

1. `BASE` には「動きが終わったあとの姿」だけを書く。`animation` は書かない
2. 動きは `MOTION` にだけ書く。`MOTION` は `@media screen and (prefers-reduced-motion: no-preference)` の中にあるので、印刷・PDF・動きを減らす設定では、最初から最後の状態で描かれる
3. 一度だけの動き（ページをめくる・スタンプを押す・道のりを描く・吹き出しが出る）は `animation-fill-mode: both` で、最後のキーフレームを `BASE` の姿とそろえる（例：`BASE` が `rotate(-8deg)` なら `to { transform: rotate(-8deg) }`）
4. くり返す動き（提灯が揺れる・ひよこが手を振る）は、0% と 100% を `BASE` の姿（`transform: none`）にする。どこで止まっても崩れない
5. 順番に出す動きは、要素に `style="--i:<番号>"` を付けて `calc(... + var(--i) * ...)` で遅らせる
6. ページをめくる動きは、使えるブラウザでは見開きを横に送るのに合わせる（`@supports (animation-timeline: view())` の `view(inline)`）。使えないブラウザでは読み込んだときに動く
7. 動きで文字を隠したままにしない。動きの途中でも、終わったあとは必ず読める

`render.test.ts` の「しおりの動き」が、1 と 2 と、スクリプトがないことを確かめる。

## 紙の大きさと改ページ

- どのページも A4 縦の同じ大きさの紙（`.page`：210mm × 297mm、紙の余白 6mm）。その中に紺の二重の枠の `<section class="sheet">` を置く。表紙も裏表紙も同じ大きさで、`@page` は `size: A4; margin: 0` の1つだけ（名前つきのページは作らない）
- 中身は `.sheet` の中の `.flow` に置く。1ページに入るかは `fit.ts` で見積もり、`render.ts` の `flowSheets` がかたまり（`Piece`：HTML と見積もりの高さ mm）をページに詰める。入りきらないかたまりは、見出しに「（つづき）」を付けた次のページに送る。すごろくの道や表のように1つの入れ物に入るものは `group` を付ける（ページごとに入れ物を開き直す）
- 見出し・箱・文字の大きさを変えたら、見積もり（`headMm`・`boxMm`・各ページの `mm`）も合わせて直す。見積もりは実際より少し大きくする。小さいと文字が紙の外で切れ、大きすぎるといらない「つづき」のページが出る
- ページの数は4の倍数（表紙で始めて裏表紙で終え、足りない分は旅の思い出のページ）。「つづき」で増えたあとに `buildSheets` がそろえ直す。半日のお出かけは4ページ、1泊は12ページ、6泊7日は20ページ（架空の旅）
- `fit.test.ts` が、架空の旅（予定の多い日帰り `fictionalCrowdedDay` を含む）で、どのページも中身がはみ出さないこと、PDF のページ数が紙の数と同じで、すべて同じ大きさであることを Chromium で確かめる
- `position: fixed` の枠は印刷で各ページに繰り返されないので使わない

## 画面の見開き

- 表紙は1ページ、そのあとは2ページずつ、最後のページは1ページの見開き（`spreadsOf`）。見開きは横に並べ、`scroll-snap` で1つずつ止める
- めくるのは左右の矢印のリンク（`#s<番号>`）。スクリプトは使わない
- 紙の縮尺は `style.ts` の `screenScaleRules`（見開きの置き場 `.book` の大きさごとのコンテナクエリで `zoom` を決める）。縦長の画面では1ページの幅に合わせる
- 店内の画面は `?embed=1` で埋め込む（上の「PDF で保存」の帯を出さない）

## 手元で HTML と PDF を出して確かめる

1. 素材を変えたら作り直す（Blender 5.2）
   ```bash
   blender -b --factory-startup --python-exit-code 1 -P assets/3d/scripts/build.py -- --target stills
   ```
   顔の絵だけなら `--target faces`
2. 架空の旅（outing・weekend・week）を書き出す（Chromium が要る：`pnpm --filter @matsuri-ikoka/web exec playwright install chromium`）
   ```bash
   pnpm --filter @matsuri-ikoka/server exec tsx src/shiori/preview.ts <出力先のフォルダ>
   ```
   `<旅>.html`（ブラウザでそのまま開ける）、`<旅>.pdf`、`<旅>-screen.png`（表紙・動きが終わった姿）、`<旅>-spread.png`（2つ目の見開き）、`<旅>-moving.png`（動きの途中）、`<旅>-reduced.png`（動きを減らす設定）、`<旅>-mobile.png`（スマートフォンの幅）ができる。旅は outing・weekend・week と、予定の多い crowded。出力先はリポジトリの外にする
3. 画像を目で見る
   - `-screen` と `-reduced` が同じ姿か（動きが最後の状態で止まっているか）
   - `-moving` で、提灯・手を振る・ページをめくる・スタンプが動いているか
   - `-spread` で、2ページが同じ大きさで横に並び、左右に矢印があるか
   - `-mobile` で、1ページの幅に収まり、下に矢印があるか
4. PDF をページごとに見る。PDF を画像にする道具（poppler の `pdftoppm`、PyMuPDF など）でページを並べ、次を確かめる
   - どのページも同じ大きさで、ページ数が上の数と同じか（いらない「つづき」のページが出ていないか）
   - 文字が箱や紙の端で切れていないか、表紙の店の札からスタッフまでが紙の中に収まっているか
   - フォントが Zen Maru Gothic で埋め込まれているか（PyMuPDF なら `page.get_fonts()`）
   - 動きの途中の姿（傾いた提灯・薄いスタンプ）が残っていないか
5. テストを通す
   ```bash
   pnpm --filter @matsuri-ikoka/server exec vitest run src/shiori
   ```
   Chromium がない環境では PDF のテストは飛ばされる。手元では Chromium を入れて、飛ばさずに通す
