# 3D アセット（店内・店の外観・縁日の通り・スタッフ・プレイヤー・モーション）

MATSURI IKOKA の画面に出る 3D の店「たびや」と店の外の縁日の通り、そこで働く4体のスタッフ、利用者が動かす旅人のペンギンをつくるスクリプト一式です。
形、テクスチャ、照明、モーション、店内の仕掛けはすべて Blender の Python（bpy）スクリプトで一から生成します。
外部のモデルや画像は読み込みません。看板・のれん・ポスター・地図・時刻表・本の背表紙・顔の表情も、図形と文字からスクリプトで描いています。

## 作り直す

必要なもの：Blender 5.2、Node.js 22（`npx` で `@gltf-transform/cli@4.5.1` を取得します）。

```bash
blender -b --factory-startup --python-exit-code 1 -P assets/3d/scripts/build.py -- --target all
```

`--target` で一部だけ作り直せます（`--target interior,optimize` のようにカンマ区切りで複数指定も可）。このときの `optimize` は `models/` のモデルを消しません。今はもう作らないモデルを `models/` から消すのは、`--target all` のときだけです。
`--python-exit-code 1` を付けると、途中で失敗したときに終了コードが 0 以外になります。

| target | 内容 | 出力 |
| --- | --- | --- |
| `textures` | 描いたテクスチャを確認用に書き出す | `out/textures/*.png`（`_sheet.png` は一覧） |
| `characters` | スタッフ4体とプレイヤー。並び立ちと表情のプレビュー、GLB | `out/preview/characters.png`, `face_*.png`, `out/glb/staff_*.glb`, `player_penguin.glb` |
| `motions` | モーション。コマ割りのプレビュー、1モーション1ファイルの GLB | `out/preview/motions.png`, `out/glb/motion_*.glb` |
| `interior` | 店内と仕掛け。固定カメラのプレビュー、Cycles で焼き込み、GLB | `out/preview/interior.png`, `interior_baked.png`, `out/glb/interior.glb` |
| `exterior` | 店の外観と入店カメラ。プレビュー、焼き込み、GLB | `out/preview/exterior*.png`, `out/glb/exterior.glb` |
| `ennichi` | 縁日の通りと6つの屋台。プレビュー（全景の消灯と点灯、屋台ごとの消灯と点灯、形だけの影）、焼き込み、GLB | `out/preview/ennichi_*.png`, `out/glb/ennichi.glb` |
| `optimize` | meshopt 圧縮と WebP（1辺1024px以下）、サイズと三角形数の一覧 | `models/*.glb`, `models/manifest.json` |
| `guide` | 帽子と旗のガイドのプレビューと、全モーションで帽子と旗が外れないことと、旗を出して使うモーションで竿が頭・体・はっぴに重ならないことの確認（どちらかが崩れたら失敗で止まる）。`all` には含まない | `out/preview/guide.png`, `guide_motions.png`, `guide_attachment.json` |
| `stills` | しおり用のスタッフと旅人の静止画と、顔の静止画（透過の WebP）。`all` には含まない | `../shiori/staff/*.webp` |
| `faces` | 顔の静止画だけ（正面に寄せた正方形。会話の窓と、しおりの吹き出しの顔の絵）。`all` には含まない | `../shiori/staff/face_*.webp` |

よく使うオプション：

- `--no-export`：焼き込みと GLB を省き、プレビューだけ作る（形や配置を直すとき）
- `--no-render`：プレビューを省く
- `--bake-samples 16 --bake-res 512`：焼き込みを軽くして試す（本番は 64 / 1024）
- `--save-blend`：作業用の `.blend` を `out/blend/` に保存する
- `--res 1280x720 --samples 32`：プレビューの解像度とサンプル数
- `--only ennichi,staff_hiyoko`：`optimize` で指定したモデルだけを `models/` に入れ直す。ほかのモデルは消さず、そのまま残す

`out/` は Git の対象外です（プレビュー、焼き込み途中の画像、未圧縮の GLB、`.blend`）。
アプリが読むのは `models/` の GLB だけです（Git で管理します）。

所要時間の目安（Ryzen 7 5800U、CPU のみ）：`all` で約 1 時間。大半は焼き込みです。

## スクリプトの構成

`scripts/build.py` が入口で、`scripts/ikoka3d/` に処理を分けています。

| ファイル | 役割 |
| --- | --- |
| `cli.py` | 引数の解析と各 target の実行 |
| `layout.py` | 店の間取り（壁、持ち場、待機位置、カウンター、客と従業員の区域、仕掛けの位置）。店内・外観・カメラが共有する |
| `util.py` | シーンの初期化、メッシュの基本形（箱、円柱、球、回転体、板）、結合 |
| `palette.py` | 色（藍の法被、木、漆喰、提灯など） |
| `materials.py` | 共通マテリアル（木目、床板、漆喰、石畳、フェルト、発光する和紙、テクスチャ） |
| `canvas.py` | テクスチャを描く小さな 2D 描画（図形、アンチエイリアス、Noto Sans CJK の文字） |
| `textures.py` | 描いたテクスチャ（紋、のれん、看板、ポスター、地図、時刻表、本、法被、顔の表情、猫、だるま、おみくじ、ガチャなど） |
| `props.py` | 小物（棚、机、椅子、ベンチ、格子の柵、提灯、植木、本の列、巻物、土産の箱、小さなぬいぐるみ、つる草、旗飾り、瓦の庇など） |
| `gimmicks.py` | 動く仕掛けと隠れた見つけもの（下記） |
| `navigation.py` | 客と従業員が歩ける床のメッシュ |
| `interior.py` | 店内の組み立てと、焼き込みのグループ分け |
| `exterior.py` | 外観（店の正面、二階、屋根、看板、隣家、広場、街灯、遠景）と入店カメラの経路 |
| `stalls.py` | 縁日の6つの屋台（形と看板で役割が分かる）と、提灯の消灯と点灯 |
| `ennichi.py` | 縁日の通りの組み立て（地面、電球の列、のぼり、木、休憩所、歩ける床、目印、カメラ、焼き込みのグループ分け） |
| `characters.py` | スタッフ4体（ひよこ、フクロウ、にわとり、スズメ）、プレイヤーのペンギン、役割の小物 |
| `guide.py` | ガイドの帽子と旗のプレビューと、モーションの間に外れないことの確認 |
| `rig.py` | 全員共通のリグ |
| `motions.py` | ループするモーション |
| `stage.py` | カメラ、プレビュー用の照明、EEVEE の描画 |
| `bake.py` | Cycles での焼き込み（下記） |
| `export.py` | GLB の書き出し、gltf-transform、`manifest.json` |

## 座標とファイルの中身

Blender は Z が上、glTF は Y が上です。書き出しで Blender の `(x, y, z)` は glTF の `(x, z, -y)` になります。
1 単位は 1 m。キャラクターは身長およそ 1 m で、正面は glTF の **+Z** を向きます（Blender の -Y）。

店は 8 m × 6 m。glTF で見ると、手前（カメラ側、開いている面）が +Z、奥の壁が -Z、入口ののれんは手前左（-X 側）です。

### `interior.glb`（店内）

- 床、壁、棚、机、カウンター、掲示板、小物を焼き込み単位ごとに結合したメッシュ（`baked.<group>`）。
  照明・影・柔らかな反射を Cycles で焼き込んだ **unlit** マテリアル（`KHR_materials_unlit`）です。
- 店内は祭りの飾りで埋めています：壁の上の紅白の幕と提灯の列、赤い「祭」の提灯、旗飾り、のぼり、うちわ、狐の面、
  太鼓、カウンターの紅白の幕、時刻表の下の紅白の日よけ、赤い毛氈、金魚すくいの桶（どれも焼き込みの家具の一部で、動きません）。
- 提灯、行灯、窓の外の景色は焼き込まず、発光マテリアル（`emissive` + `KHR_materials_emissive_strength`）のまま。
  ガチャのガラス、時計の文字盤、はんこの跡など半透明のものも、元のマテリアルのままです。
- **客と従業員の区域**：低い格子の柵が店を分けます。柵の手前（入口、カウンターの前、ソファ、掲示板と土産の一角）が客の区域、
  柵の奥（カウンターの裏、資料棚、地図の机、時刻表）が従業員の区域です。柵には「従業員専用」の札と、従業員が通る扉（仕掛け `gate`）があります。
  - `nav.customer`：プレイヤーが歩ける床。家具の場所は（キャラクターの半径 0.2 m ぶん広げて）抜いてあります。
    プレイヤーの位置がこのメッシュの三角形の上にあるかで、進めるかを判定してください
  - `nav.staff`：スタッフが歩ける床（同じ作り）
  - どちらも表示しないデータです。読み込んだら `visible = false` にしてください
- **入口の壁**：`baked.entrance_wall`（入口の区画の壁・柱・庇）は、固定カメラから見るとすぐ内側の床を隠します。
  プレイヤーがその陰（入口から約 2 m 以内）にいる間は、この壁と `chochin_door.*` を半透明にしてください。
- 置き場所の目印（空のノード）。目印の向き（Y 軸まわりの回転）が、そこでキャラクターが向く方向です：
  - `anchor.<role>.post`：持ち場。`<role>` はスキーマの StaffId（`concierge` / `researcher` / `scout` / `planner`）
  - `anchor.<role>.home`：待機位置（コンシェルジュは持ち場と同じ。カウンター裏の段の上で、高さ 0.14 m）
  - `anchor.counter.drop`：旅程係が書類を置く位置
  - `anchor.player.start`：プレイヤーが入店して立つ位置、`anchor.player.counter`：カウンターでコンシェルジュと話す位置
  - `seat.customer.*`（ソファ2席、ベンチ2席）、`seat.staff.*`（地図の机の椅子、読書机の椅子、踏み台）：座る位置。
    目印の高さが座面です。キャラクターの一番上のノードをここに置き、モーション `sit` を流します
  - `interact.<name>`：プレイヤーが仕掛けを使うときに立つ位置（`bell`, `stamp`, `omikuji`, `gacha`, `souvenir`, `quest_board`, `cat`）
- カメラ：
  - `cam.main`：固定の斜め見下ろし（焦点距離 50 mm、横の画角 39.6°、16:9 で縦 22.9°）。画面比が違うときは横の画角を保ってください
  - `cam.shiori`：しおりができたときに寄る位置（カウンターに寄る。`cam.main` との間を補間して使う）

### 仕掛けと見つけもの（`interior.glb`）

仕掛けはノード `gimmick.<name>` の下にまとまっていて、動きはアニメーション `gimmick.<name>.<action>` です。
クリックやプレイヤーの `interact` で一度流します（`LoopOnce`、`clampWhenFinished`）。`cat.sleep` だけは常に繰り返します。
従業員の区域の仕掛け（地球儀、秘密の本、扉）は、プレイヤーは近づけないのでクリックで動かします。

| アニメーション | 場所 | 中身 |
| --- | --- | --- |
| `gimmick.bell.ring` | カウンター | 呼び鈴が鳴って弾む（コンシェルジュが振り向く合図に） |
| `gimmick.stamp.press` | 入口の脇の記念スタンプ台 | はんこを持ち上げて紙に押す。押した跡（店の紋）が残る |
| `gimmick.omikuji.shake` | 土産の一角 | おみくじの箱を振り、棒が出てくる（運勢の文字は画面側で） |
| `gimmick.gacha.turn` | 土産の一角 | ハンドルが回り、カプセルが転がり出る（中身は画面側で、スタッフの小さなぬいぐるみなど） |
| `gimmick.daruma.wobble` | 土産の棚の上 | だるまが揺れて起き上がる |
| `gimmick.cat.sleep` | のれんの外（入口の左の座布団の上） | 三毛猫が寝息を立て、しっぽを揺らす（常に繰り返す） |
| `gimmick.cat.pet` | のれんの外 | なでると顔を上げ、耳がぴくっと動き、しっぽを立てる。店内では入口の左の柱のそば（`interact.cat`）から、外観ではクリックでなでる |
| `gimmick.globe.spin` | 読書机 | 地球儀が回る |
| `gimmick.secret.open` | 資料棚 | 赤い本が手前に倒れ、隣の棚の下の引き出しが開いて「金の切符」が出てくる |
| `gimmick.gate.swing` | 柵の扉 | 従業員が通るときに扉が開いて閉まる |
| `gimmick.noren.sway` | 入口 | のれんが揺れる（プレイヤーやスタッフが通るときに） |
| `gimmick.furin.ring` | 入口の内側 | 風鈴が揺れる（入店時に） |

- **時計**：`clock.hand.hour` と `clock.hand.minute` を、壁から手前に向く軸（ノードの local Z）まわりに回すと本物の時刻になります。
  時計回りは負の角度です：`minute.rotation.z = -2π × 分 / 60`、`hour.rotation.z = -2π × (時 % 12 + 分 / 60) / 12`。
- **隠れひよこ**：小さなひよこの置物が3か所に隠れています（`secret.chick.1`〜`3`：時刻表の額の上、窓の下の桟、土産の棚のぬいぐるみの中）。
  クリックで見つけたことにして、3つそろったら何か起こす、といった遊びに使えます。

### `exterior.glb`（店の外観）

- 店の正面（のれんの区画は `interior.glb` 側にあります）、二階、屋根、大看板、隣家2軒、石畳の広場、街灯、遠景。
  店内と同じ座標なので、2つを重ねて表示します。焼き込みと発光の扱いは店内と同じです。
- `cam.entry`：入店時のカメラ。アニメーション `entry`（4.5 秒）。
  通りから看板を見上げ、のれんへ寄り、上へ引いて `cam.main` とまったく同じ位置・向きで止まります。
  カメラが上がり始めたら外観を消してください。目安は経路の 50%〜66%（2.25〜2.97 秒）で `exterior.glb` を不透明度 1 → 0 にします。

### `ennichi.glb`（縁日の通り）

- 店の外の通り。店内・外観と同じ座標で、店の前から glTF の +Z の向きに伸びています（地面の高さは y = -0.22）。
  店から奥を見て右の列（-X）に行き方・宿・作法、左の列（+X）に天気・食べ物と休憩所、突き当たりに本部のテントがあります。
  地面が店の下まで続き、`cam.ennichi` は店の後ろの上空にあるので、店内と外観とは重ねず、これだけを表示します。
- 屋台の `<role>` はスキーマの `GuideStall`（`access` / `lodging` / `etiquette` / `food` / `weather` / `headquarters`）と同じ語です。
  屋台は文字がなくても形で分かります：行き方は線路と屋根の上の電車、宿は瓦屋根と月と布団、作法は大きな鳥居、食べ物は紅白の日よけと大きなどんぶり、天気は大きな番傘と風速計、本部は白いテントと紅白の幕。
- `baked.<group>`（`street`, `road`, `decor`, `trees`, `stall_<role>`, `rest`）：店内と同じ、焼き込みの unlit のメッシュ。`rest` は休憩所（太鼓、ベンチ、金魚の桶）です。
- `street.bulbs`：電球の列（発光）。`backdrop`, `street.far`：遠景の山と花火、遠くの地面（焼き込まない unlit）。
- **提灯**：消えた提灯の紙は `baked.stall_<role>` に焼き込まれていて、いつも見えています。
  `lantern.<role>.on` は、灯った提灯と光のにじみを1つにまとめたノードです。**読み込んだら全部隠し**、灯すときにそのノードを `visible = true` にします。
  マテリアルは屋台の間で共有しているので、色や強さではなく、ノードの表示で切り替えてください。
- `nav.street`：歩ける床。屋台や柱の場所は（キャラクターの半径 0.2 m ぶん広げて）抜いてあります。下の `anchor.*` はすべて、`anchor.player.start` から歩いて着ける場所にあります（着けないと `target ennichi` が失敗で止まります）。表示しないデータです。読み込んだら `visible = false` にしてください。
- 置き場所の目印（空のノード）。目印の向き（Y 軸まわりの回転）が、そこでキャラクターが向く方向です：
  - `anchor.stall.<role>`：旅人が屋台の前に立つ位置（屋台を向く）
  - `anchor.guide.<role>`：ガイドが屋台の脇に立つ位置（旅人の立つ位置を向く）
  - `anchor.shop.door`：店を出たところ。`anchor.player.start`、`anchor.guide.start`：通りに出た旅人とガイドが立つ位置
  - `anchor.guide.home`：通りの入り口でガイドが待つ位置
  - `seat.street.0`、`seat.street.1`：休憩所のベンチ。目印の高さが座面です。キャラクターの一番上のノードをここに置き、モーション `sit` を流します
- カメラ：
  - `cam.ennichi`：通り全体を店の側から奥へ見下ろす（焦点距離 35 mm）
  - `cam.stall.<role>`：屋台の正面に寄る（看板と提灯が入る）

### `staff_<kind>.glb` と `player_penguin.glb`（キャラクター）

| ファイル | キャラクター | 役割 | 小物（`prop.*`） |
| --- | --- | --- | --- |
| `staff_hiyoko.glb` | ひよこ | コンシェルジュ、旅のガイド | `prop.stamp`（はんこ、右手）、`prop.guide_cap`（ガイドの帽子、頭）、`prop.guide_flag`（誘導の旗、右手） |
| `staff_owl.glb` | フクロウ（丸眼鏡） | 祭り調査係 | `prop.book`（左手）、`prop.scroll`（右手） |
| `staff_hen.glb` | にわとり | 周辺係 | `prop.map`（地図、左手） |
| `staff_sparrow.glb` | スズメ（駅員帽） | 旅程係 | `prop.binder`（左手）、`prop.document`（運ぶ書類、右手） |
| `player_penguin.glb` | 旅人のペンギン（麦わら帽、マフラー、リュック） | 利用者が動かすキャラクター | `prop.stampbook`（スタンプ帳、右手） |

- スタッフは藍の法被、ペンギンは旅の装い（法被なし）です。一番上のノードは `staff.<kind>`、プレイヤーは `player.penguin`。
- リグ（ボーン名＝glTF のノード名）：`root`, `body`, `head`, `jaw`（下くちばし）, `wing.L`, `wing.R`, `hand.L`, `hand.R`, `foot.L`, `foot.R`。
  全員同じ骨組みなので、どのモーションも誰にでも使えます。`.L` はキャラクターから見て左です。
- 各部品は骨に固定した硬い部品です（スキンの重みなし）。動かすときは一番上のノードを移動・回転し、骨は動かさないでください。
- **小物は読み込んだら全部隠し**、必要な動作のときだけ表示します（名前が `prop.` で始まるノード）。
- `<kind>.shadow`：足もとの柔らかい影（半透明）。焼き込んだ床には動くキャラクターの影がないので、これで接地させます。
- **表情**：`<kind>.face` のテクスチャは 4 列 × 2 段の表情の並びで、メッシュは左上の1コマを表示しています。
  `face.material.map.offset.set(col * 0.25, row * 0.5)` で切り替えます（three.js の GLTFLoader は `flipY = false` のため、段は下向きに数えます）。

  | 番号 | 表情 | col, row |
  | --- | --- | --- |
  | 0 | normal（ふつう） | 0, 0 |
  | 1 | blink（まばたき） | 1, 0 |
  | 2 | happy（にっこり） | 2, 0 |
  | 3 | surprised（びっくり） | 3, 0 |
  | 4 | wink（ウインク） | 0, 1 |
  | 5 | sleepy（ねむい） | 1, 1 |
  | 6 | sparkle（きらきら） | 2, 1 |
  | 7 | determined（きりっ） | 3, 1 |

  まばたきは画面側で数秒おきに 1 → 0 と一瞬切り替えてください。
- 毛並みは `KHR_materials_sheen` 付きの PBR マテリアルで、画面側のライトで照らします。

### `motion_<name>.glb`（モーション）

骨組みとアニメーション1本だけのファイルです。アニメーション名はファイル名と同じです。
`THREE.AnimationMixer` で、どのキャラクターにも骨の名前で当てはまります。どれも先頭と末尾がつながるループで、その場から動きません（移動は画面側）。

| name | 長さ | 主な担当 | 中身 |
| --- | --- | --- | --- |
| `idle` | 2.4 s | 全員 | 待機。呼吸、ゆらぎ |
| `walk` | 2.0 s | 全員 | 歩く。よちよち 6 歩。移動は 0.4〜0.5 m/s が目安 |
| `flip` | 2.4 s | フクロウ | めくる。左手の本を右手で2回めくる |
| `point` | 2.4 s | にわとり | 指さす。右の翼で上を指し、2回つつく |
| `look_up` | 2.4 s | スズメ | 見上げる。時刻表を左右に読む |
| `nod` | 2.0 s | 全員 | 頷く。2回 |
| `talk` | 2.4 s | ひよこ | 話す。くちばしを開け閉めし、翼で身ぶり |
| `stamp` | 2.0 s | ひよこ | はんこを押す。振り上げて押し、体がつぶれて戻る |
| `carry` | 2.0 s | スズメ | 書類を運ぶ。両手で抱えて歩く |
| `wave` | 2.0 s | ひよこ | 手を振る（入店時のあいさつ用） |
| `sit` | 2.4 s | 全員 | 座る。`seat.*` に置いて流す。足をぶらぶら |
| `reach` | 2.0 s | ペンギン | 手を伸ばして前のものに触れる（呼び鈴、はんこ、ガチャ、猫） |
| `cheer` | 2.0 s | ペンギン | 両手を上げてぴょんと跳ねる（隠れひよこを見つけたとき、大吉のときなど） |
| `lead` | 2.0 s | ガイド | 先導して歩く。旗を高く掲げてよちよち 6 歩、途中で旅人のほうを振り返る。移動は 0.4〜0.5 m/s が目安 |
| `wave_flag` | 2.0 s | ガイド | 旗を振る。その場で頭の上に大きく2往復 |
| `run` | 1.2 s | ガイド | 駆け寄る。前かがみの小走り 6 歩で、旗は後ろへなびかせる。移動は 1.2 m/s 前後が目安 |

ガイドの旗（`prop.guide_flag`）を出している間は、`idle`, `talk`, `nod`, `lead`, `wave_flag`, `run` を使います。
ほかのモーションは竿が頭や体に重なるので、旗を隠して使ってください（`target guide` が、この6つで竿が頭・体・はっぴに重ならないことを確かめます。旗を握る右の翼と袖には、竿がかかります）。

## 画面側での描き方

- 焼き込んだマテリアル（unlit）は、Blender の AgX の見た目をすでに含んだ色です。three.js では **`material.toneMapped = false`** にしてそのまま表示します。
- 発光する提灯・行灯・窓は、ブルーム（しきい値 1.0 前後）で光らせます。
- キャラクターだけを画面側のライトで照らします。夕暮れの店内に合わせ、暖色の主光（#FFC88A）を斜め上から、薄紫の環境光（#9A90E0 / 地面側 #6A4A30）を弱めに当てるとなじみます。
- リアルタイムの影は使いません。足もとの影は `<kind>.shadow` で出ます。
- 動きを控えめにする設定（`prefers-reduced-motion`）のときは、入店カメラを使わず `cam.main` から始め、モーションは `idle` と `nod` 程度に、仕掛けの動きは止めてください（`cat.sleep` の繰り返しも止める）。

## 焼き込みのしくみ（`bake.py`）

焼き込み単位ごとにメッシュを結合し、新しい UV（`bake`）を割り当て、Cycles で3回焼きます。

1. 色（`DIFFUSE` の色だけ、少ないサンプルで文字や模様をくっきり）
2. 光（`DIFFUSE` の直接光と間接光、色なし、多めのサンプルのあと軽くぼかしてノイズを消す）
3. 反射（`GLOSSY` を固定カメラから見た向きで。提灯の映り込み）

`色 × 光 + 反射` を AgX（Medium High Contrast、露出 +0.4）で表示用の色に変換し、PNG に書き出します。
動く仕掛けの部品は結合せず、ノードを残したまま1枚のテクスチャを共有して焼きます（のれんは文字がつぶれないよう別の1枚）。
`optimize` でその PNG を WebP（1辺1024px以下）に変えます。

## 三角形数とファイルサイズ

`models/manifest.json` に `optimize` 実行時の値が入ります。予算は、店内と縁日の通りはそれぞれ 15 万三角形以下、キャラクター1体 1.5 万三角形以下、GLB 合計 15 MB 以下です。
`interior.glb` と `ennichi.glb` の数には `nav.*`（表示しない床のメッシュ）も入っています。

<!-- stats -->

| ファイル | 三角形 | サイズ |
| --- | ---: | ---: |
| `ennichi.glb` | 66,382 | 1,486 KB |
| `exterior.glb` | 93,742 | 997 KB |
| `interior.glb` | 117,796 | 2,435 KB |
| `motion_carry.glb` | 0 | 12 KB |
| `motion_cheer.glb` | 0 | 10 KB |
| `motion_flip.glb` | 0 | 10 KB |
| `motion_idle.glb` | 0 | 10 KB |
| `motion_lead.glb` | 0 | 13 KB |
| `motion_look_up.glb` | 0 | 9 KB |
| `motion_nod.glb` | 0 | 9 KB |
| `motion_point.glb` | 0 | 10 KB |
| `motion_reach.glb` | 0 | 10 KB |
| `motion_run.glb` | 0 | 12 KB |
| `motion_sit.glb` | 0 | 10 KB |
| `motion_stamp.glb` | 0 | 11 KB |
| `motion_talk.glb` | 0 | 11 KB |
| `motion_walk.glb` | 0 | 13 KB |
| `motion_wave.glb` | 0 | 10 KB |
| `motion_wave_flag.glb` | 0 | 10 KB |
| `player_penguin.glb` | 9,294 | 138 KB |
| `staff_hen.glb` | 10,254 | 209 KB |
| `staff_hiyoko.glb` | 10,806 | 188 KB |
| `staff_owl.glb` | 10,342 | 189 KB |
| `staff_sparrow.glb` | 10,362 | 154 KB |
| 合計 | | 5.83 MB |

<!-- /stats -->

## ライセンスと素材

- すべての形とテクスチャは、このディレクトリのスクリプトが生成します。
- 文字には Blender に同梱の Noto Sans CJK（SIL Open Font License 1.1）を使い、図形に変換して描いています。
- 地名・祭りの名前・時刻表の内容は架空です。
