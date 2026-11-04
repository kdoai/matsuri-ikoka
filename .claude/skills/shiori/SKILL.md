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
6. ページをめくる動きは、使えるブラウザではスクロールに合わせる（`@supports (animation-timeline: view())`）。使えないブラウザでは読み込んだときに動く
7. 動きで文字を隠したままにしない。動きの途中でも、終わったあとは必ず読める

`render.test.ts` の「しおりの動き」が、1 と 2 と、スクリプトがないことを確かめる。

## 改ページ

- 1ページは `<section class="sheet">`。ページの頭で改ページする（`break-before: page`）
- 途中で切りたくない箱には `keep`（`break-inside: avoid`）を付ける
- 表紙は `@page cover`（余白 7mm、ページ番号なし）で、高さ 283mm に収める（はみ出しは隠れる）
- 冊子にできるよう、ページの数は4の倍数（表紙で始めて裏表紙で終え、足りない分は旅の思い出のページ）。半日のお出かけは4ページ、1泊は12ページ、6泊7日は20ページ。`pdf.test.ts` が半日のお出かけのページ数を数える。見出しや吹き出しを高くすると、持ち物のページの最後の行が次のページに押し出されることがあるので、必ず PDF で数を確かめる
- 印刷では、表紙と裏表紙のほかのページは1ページの高さ（283mm）の枠になる。`position: fixed` の枠は印刷で各ページに繰り返されないので使わない

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
   `<旅>.html`（ブラウザでそのまま開ける）、`<旅>.pdf`、`<旅>-screen.png`（動きが終わった姿）、`<旅>-moving.png`（動きの途中）、`<旅>-reduced.png`（動きを減らす設定）、`<旅>-mobile.png`（スマートフォンの幅）ができる。出力先はリポジトリの外にする
3. 画像を目で見る
   - `-screen` と `-reduced` が同じ姿か（動きが最後の状態で止まっているか）
   - `-moving` で、提灯・手を振る・ページをめくる・スタンプが動いているか
   - `-mobile` で、横にはみ出していないか、文字が縦に1文字ずつ折れていないか
4. PDF をページごとに見る。PDF を画像にする道具（poppler の `pdftoppm`、PyMuPDF など）でページを並べ、次を確かめる
   - ページ数が上の数と同じか（最後の1〜2行だけが次のページに出ていないか）
   - 文字が箱や紙の端で切れていないか、表紙の中身が 283mm に収まっているか
   - フォントが Zen Maru Gothic で埋め込まれているか（PyMuPDF なら `page.get_fonts()`）
   - 動きの途中の姿（傾いた提灯・薄いスタンプ）が残っていないか
5. テストを通す
   ```bash
   pnpm --filter @matsuri-ikoka/server exec vitest run src/shiori
   ```
   Chromium がない環境では PDF のテストは飛ばされる。手元では Chromium を入れて、飛ばさずに通す
