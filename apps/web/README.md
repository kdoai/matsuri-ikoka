# 画面（apps/web）

店内と会話、旅程・地図・出典のパネル、旅のしおりの画面です。Vite + React + Tailwind CSS で作り、状態は Zustand のストアだけが持ちます。

```text
src/state/      ストア。SSE のイベントをストアの更新に変える（events.ts）
src/transport/  接客サーバーとの通信（POST で送りながら SSE で受け取る）
src/mock/       画面だけのモック（記録した相談をブラウザの中で再生する）
src/ui/         2D の部品としおり
src/i18n/       日本語と英語の辞書
src/scenes/     3D の店内（別に作る。下の「3D の店内を差し込む」）
e2e/            Playwright の通しテスト
```

## 動かす

```bash
pnpm dev
```

開発のときは、**画面だけのモック**が既定です。`data/samples/conversations/` の記録した相談を、記録した間隔のとおりに再生するので、接客サーバーや API キーがなくても、相談から旅のしおりまでを画面で見られます。何を送っても、記録の次の発言への返答が流れます。入力欄の下の「記録の発言を入れる」で、記録の発言を入れられます。

| URL の引数          | 意味                                                |
| ------------------- | --------------------------------------------------- |
| `?transport=server` | 接客サーバー（`/api/*`）につなぐ                    |
| `?sample=<id>`      | 再生する記録（`data/samples/conversations` の名前） |
| `?speed=<倍率>`     | モックの再生の速さ（例：`?speed=4`）                |

| 環境変数                | 意味                                       |
| ----------------------- | ------------------------------------------ |
| `VITE_TRANSPORT=server` | 開発のときも、既定で接客サーバーにつなぐ   |
| `VITE_ENABLE_MOCK=true` | 本番のビルドにも、画面だけのモックを含める |

本番のビルドには、モックも記録した相談も含めません。

### 接客サーバーにつなぐとき

- `?sample=<id>` は、接客サーバーが記録の再生（`MATSURI_AGENT_MODE=mock`）で動いているときも、`POST /api/session` の本文 `{ "sample": "<id>" }` で渡します
- 合言葉（`ACCESS_PASSCODE`）を設定したサーバーでは、`/api` のすべての呼び出しに `x-access-passcode` ヘッダーを付けます。断られたら入口（相談の途中なら小さな窓）で聞き直します。合言葉はメモリにだけ持ち、URL にも保存にも入れません
- SSE を始める前に断られたら、サーバーが本文で送る一文（`code`・`message`・`retryable`）を会話欄に出します。「相談が見つからない」（404）のときは、新しい相談を自動で始めます
- しおりを開けるようになったら、共有の URL（`/shiori/<旅程の ID>`）を出します

## 確かめる

```bash
pnpm test                                        # ストアとイベントの変換（Vitest）
pnpm --filter @matsuri-ikoka/web exec playwright install chromium
pnpm --filter @matsuri-ikoka/web test:e2e        # 画面の通しテスト（Playwright）
```

- 手元の Chrome で走らせるときは `PLAYWRIGHT_CHANNEL=chrome` を付けます
- 通しテストは、地図のタイルを取りに行きません。取りに行くときは `E2E_ALLOW_TILES=1` を付けます
- 見直し用のスクリーンショットは `test-results/screens/` に保存します（Git の対象外）

## 状態の決まり

- 正しい状態はストアだけが持ちます。SSE のイベントは `src/state/events.ts` の純粋な関数でストアの更新に変え、部品はイベントを直接受けません
- 届いたイベントは `src/state/store.ts` の1か所でスキーマで検証し、形が違えば捨てて会話欄に知らせます
- `done` の前に接続が閉じたら、会話欄に「もう一度送る」を出します。自動では再接続しません
- データとモデルの文章は文字列として表示し、HTML として埋め込みません（地図のピンも `textContent` で入れます）

## 3D の店内を差し込む

3D の店内は `src/scenes/ShopScene.tsx` に置き、`ShopSceneProps`（`src/state/scene.ts`）を props で受け取る部品を既定のエクスポートにします。

```tsx
import type { ShopSceneProps } from "../state/scene";

export default function ShopScene({ staff, stage, quests, celebrating }: ShopSceneProps) {
  // staff.researcher.phase：idle 待機 / walking 持ち場へ移動 / working 作業 / returning 戻る
  // staff.researcher.motion：idle・walk・flip・point・look_up・nod・talk・stamp・carry
  // staff.researcher.seq が変わったら、うなずき・はんこのような1回きりの動きを出し直す
}
```

- 画面は `import.meta.glob` でこのファイルを探し、あれば読み込みます。なければ、2D の見取り図を出します
- 読み込みに失敗したとき、動きを減らす設定（`prefers-reduced-motion`）のときも、2D の見取り図に切り替えます
- 3D の下には、スタッフの状態と吹き出しを文字で並べた一覧をいつも出します
- クエストの掲示板・小話・クイズは、3D の上に重ねて出します
