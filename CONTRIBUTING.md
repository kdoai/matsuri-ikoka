# MATSURI IKOKA への参加

変更は Issue → ブランチ → コミット → PR → CI → マージ → デプロイ の順に進みます。全体の流れ、CI のジョブ、ラベル、Claude Code のスキルは [開発の流れ](docs/development.md) にあります。

## 開発を始める

必要なもの：

- Node.js 22.12 以上（[`.node-version`](.node-version) は 24。CI も 24 で動かします）
- pnpm 10（[`package.json`](package.json) の `packageManager` に合わせます。Corepack を使う場合は `corepack enable`）

```bash
pnpm install
pnpm dev
```

画面は http://localhost:5173 、接客サーバーは http://localhost:8787 で開きます。API キーは要りません。Claude と実際に話して試すときは、[`.env.example`](.env.example) を `.env` にコピーして値を入れます。`.env` は Git の対象外です。

## コマンド

| コマンド                                    | 中身                                                          |
| ------------------------------------------- | ------------------------------------------------------------- |
| `pnpm dev`                                  | 画面と接客サーバーを開発モードで起動する                      |
| `pnpm lint`                                 | Biome で lint と format を確かめる                            |
| `pnpm format`                               | Biome で直せるものを直す                                      |
| `pnpm typecheck`                            | すべてのパッケージの型を確かめる                              |
| `pnpm test`                                 | Vitest ですべてのテストを走らせる（`pnpm test:watch` で監視） |
| `pnpm build`                                | 画面と接客サーバーをビルドする                                |
| `pnpm validate:data`                        | 祭りのデータを検証する                                        |
| `pnpm --filter @matsuri-ikoka/web test:e2e` | 画面の通しテスト（Playwright）                                |

PR を出す前に、`pnpm lint`・`pnpm typecheck`・`pnpm test`・`pnpm build` がすべて通ることを確かめてください。CI では、これらと e2e・コンテナの確かめ・秘密情報の検査が別々のジョブで走ります（[CI のジョブ](docs/development.md#5-ci)）。

## ディレクトリ

| パス              | 中身                                                      |
| ----------------- | --------------------------------------------------------- |
| `apps/server`     | 接客サーバー（Hono、Claude Agent SDK）                    |
| `apps/web`        | 画面（Vite、React、Tailwind CSS）                         |
| `packages/schema` | データ・旅程・SSE イベントの Zod のスキーマ（唯一の定義） |
| `data/festivals`  | 祭りのデータ（1件1ファイル）                              |
| `data/samples`    | モックで再生するサンプルの相談（架空）                    |
| `docs`            | 課題、アーキテクチャ、仕様、設計判断の記録                |

## 書き方

- TypeScript は strict。lint と format は Biome に任せます
- 型はスキーマ（`packages/schema`）から取り、ほかの場所で同じ型を書きません。スキーマを変えたら [仕様](docs/spec/README.md) も直します
- 日程や所要時間などの決まった計算は、Agent SDK に依存しない関数にして、テストを付けます
- テストは架空の祭りで書きます（`@matsuri-ikoka/schema/testing`）

## コミット

[Conventional Commits](https://www.conventionalcommits.org/ja/v1.0.0/) で書きます。本文は日本語でかまいません。

```text
feat(schema): 祭りのデータモデルを定義
fix(server): 日帰りの移動の上限を超える祭りを除く
docs: 旅程の仕様に差分の形を書き足す
```

| 種類       | 使いどころ             |
| ---------- | ---------------------- |
| `feat`     | 機能を足す             |
| `fix`      | 誤りを直す             |
| `docs`     | 文書だけを変える       |
| `test`     | テストだけを変える     |
| `refactor` | 動きを変えずに書き直す |
| `chore`    | 設定や依存の更新       |
| `ci`       | CI/CD の変更           |

スコープは変えた場所で、Issue の `area:*` のラベルと同じ名前です：`schema`・`server`・`agent-kit`・`web`・`3d`・`shiori`・`data`・`infra`・`docs`。

- 1つのコミットには1つの目的だけを入れます
- ファイルはパスを指定して足します（`git add -A`・`git add .` は使いません）
- 作者の設定は変えず、GitHub の noreply のアドレスを使います

## Issue

テンプレート（不具合の報告・機能の提案・作業・祭り情報の訂正・掲載の依頼・掲載停止の依頼）から起票します。種類・場所・優先度・状態はラベル（`type:*`・`area:*`・`priority:*`・`status:*`）で表します。

## PR

- main には PR を通して入れます。CI のすべてのジョブが通ることが必要で、マージは squash merge です
- PR のタイトルは、そのまま main のコミットになるので、Conventional Commits の形にします
- PR のテンプレート（変更の内容・関連する Issue・確かめたこと・チェック）を埋めてください

## 祭りの情報を寄せる・直す

- 載せてほしい祭りや、来る人に知ってほしいことは、Issue の「祭りの掲載・情報提供の依頼」から知らせてください。いただいた情報は手がかりにし、公式の情報と照らし合わせてから載せます
- 誤りを見つけたら、Issue の「祭り情報の訂正」から知らせてください
- データを直接直す PR も歓迎します。直した値には、確かめられる出典（URL・確認した日・確度）を付けてください
- 掲載停止の依頼は、Issue の「掲載停止の依頼」から受け付けます

## 脆弱性

公開の Issue には書かず、[SECURITY.md](SECURITY.md) の手順で知らせてください。
