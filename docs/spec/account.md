# ログインと保存の仕様

旅程・しおりの共有・相談の途中の状態を Firestore に残し、ログインした利用者が自分の旅を残して、あとで開き、消せるようにします。判断の理由は [ADR 0005](../adr/0005-login-and-storage.md) にあります。

## ログイン

| 項目           | 決まり                                                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 方法           | Firebase Authentication の Google でのログイン（ポップアップ）                                                                                                         |
| いつ要るか     | 旅を残す・あとで開く・一覧する・共有する・消すとき。相談はログインなしで始められる                                                                                     |
| 利用者の決め方 | 画面が `Authorization: Bearer <ID トークン>` で送る Firebase の ID トークンを、サーバーが Admin SDK で確かめる。画面が送る利用者の ID は使わない                       |
| 画面の設定     | `GET /api/auth/config` が Firebase の公開の設定（`apiKey`・`authDomain`・`projectId`）を返す。用意していなければ `{ "enabled": false }` で、ログインのボタンを出さない |
| 部品の読み込み | Firebase の部品は、ログインを用意しているときだけ読み込む。画面だけのモックでは出さない                                                                                |

## 残すもの

読み書きは接客サーバーだけが行います。ブラウザから Firestore への読み書きは、セキュリティルール（[`firestore.rules`](../../firestore.rules)）ですべて断ります。

| 文書                                    | 中身                                                                                      | 消える時刻（`expiresAt`）                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `itineraries/{旅程の ID}`               | 一覧の見出し（名前・初日）、持ち主の利用者の ID、最新の版、作った時刻、最後に保存した時刻 | 持ち主がなければ最後の保存から30日。あれば消さない |
| `itineraries/{旅程の ID}/versions/{版}` | 旅程の JSON（版ごと、新しいものから20版まで）                                             | 旅程と同じ                                         |
| `shares/{共有の ID}`                    | 共有したときの版の旅程の JSON、旅程の ID、持ち主                                          | 作ってから30日                                     |
| `sessions/{相談の ID}`                  | 相談の途中の状態（条件・こだわり・候補・選んだ祭り・旅程の ID・段階、記録の再生の位置）   | 最後に使ってから6時間                              |

- 旅程は形が変わっても保存の側を直さずに済むよう、丸ごと JSON の文字列で持つ。読むときに `ItinerarySchema` を通し、読めない古い版は「見つからない」として扱う
- 会話の文章と、Agent SDK の会話の記録は残さない
- TTL ポリシーで消えるまでには時間がかかる（多くは1日以内）ので、読むときにも期限を確かめる
- ID はどれも推測できない乱数（旅程は `trip-…`、共有は `sh-…`、相談は `s-…`）

### 相談の続き

1. 相談を作ったとき、返事を作り終えたとき、こだわりを変えたときに、途中の状態を書く。旅程の書き込みが終わってから書くので、続きを受けたインスタンスは必ず旅程を読める
2. 発言が、相談を持っていないインスタンスに届いたら、途中の状態と旅程を Firestore から戻してから返事を作る
3. Agent SDK の会話の記録はインスタンスの `/tmp` にあるので、戻した相談では新しい会話を始め、相談の状態の要約から続ける
4. Firestore に書けなくても相談は止めず、そのインスタンスのメモリで続ける（ログに `storage_failed` を残す）

### 旅程の版

ツールが旅程を保存するたびに、その版を書きます。同じ旅程の書き込みは順に並べ、版が戻らないようにします。持ち主のある旅程の新しい版は、持ち主の旅に入ります。

### しおりの共有

| URL                   | 読めるもの           | 読める期間         |
| --------------------- | -------------------- | ------------------ |
| `/shiori/{旅程の ID}` | その旅程の最新の版   | 最後の保存から30日 |
| `/shiori/{共有の ID}` | 共有を作ったときの版 | 作ってから30日     |

残した旅を、最後の保存から30日を過ぎて開くときは、一覧の「しおりを開く」で新しい共有を作ります。

## API

ログインが要る API は、ID トークンがない・確かめられないと 401（`unauthorized`）、ログインを用意していないと 404 で断ります。応答には `Cache-Control: private, no-store` を付けます。型は `packages/schema` の `account.ts` にあります。

| メソッド | パス                               | 本文                                       | 返すもの                                                                |
| -------- | ---------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------- |
| GET      | `/api/auth/config`                 | —                                          | `AuthConfigSchema`（ログインは要らない）                                |
| GET      | `/api/trips`                       | —                                          | `TripListResponseSchema`（新しく保存した順）                            |
| POST     | `/api/trips`                       | `SaveTripRequestSchema`（`{ sessionId }`） | 201 `TripSummarySchema`。旅程がなければ 409、ほかの人が残していれば 403 |
| GET      | `/api/trips/:id`                   | —                                          | `TripResponseSchema`（最新の版と、残っている版の一覧）                  |
| GET      | `/api/trips/:id/versions/:version` | —                                          | `TripResponseSchema`（その版）                                          |
| POST     | `/api/trips/:id/share`             | —                                          | 201 `ShareResponseSchema`（しおりのパスと期限）                         |
| DELETE   | `/api/trips/:id`                   | —                                          | 204。すべての版と共有もいっしょに消す                                   |
| DELETE   | `/api/me/trips`                    | —                                          | `{ "deleted": 件数 }`。自分の旅と共有をすべて消す                       |

- 旅を残すときは、旅程の ID ではなく相談の ID で指す。しおりの URL を受け取っただけの人が、他人の旅程を自分のものにできないようにするため
- 自分の旅でなければ、あるかどうかも見せず 404 にする

## 消す手段

| 消すもの                       | 方法                                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 旅を1つ                        | 自分の旅の一覧の「消す」（`DELETE /api/trips/:id`）。版と共有もいっしょに消える                                             |
| 旅とログインの記録をすべて     | 一覧の「旅とログインの記録をすべて消す」。`DELETE /api/me/trips` のあと、画面が Firebase のアカウントを消してログアウトする |
| ログインせずに作った旅程と相談 | 何もしなくても、旅程は最後の保存から30日、相談の途中の状態は6時間で消える                                                   |

## 手元で動かす

Firestore と Auth のエミュレーター（Firebase CLI と Java が要る）で動かせます。設定は [`firebase.json`](../../firebase.json) にあります。プロジェクト ID を `demo-` で始めると、エミュレーターの外には出ません。

```bash
firebase emulators:start --only firestore,auth --project demo-matsuri-ikoka
```

接客サーバーには、次の環境変数を渡します（`.env` に書いてもよい）。

```bash
MATSURI_STORAGE=firestore
FIREBASE_PROJECT_ID=demo-matsuri-ikoka
FIREBASE_WEB_API_KEY=demo-api-key
FIREBASE_AUTH_DOMAIN=demo-matsuri-ikoka.firebaseapp.com
FIRESTORE_EMULATOR_HOST=127.0.0.1:8085
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
```

- 何も渡さなければ、保存先はメモリで、ログインは出ない（いままでどおり）
- `FIRESTORE_EMULATOR_HOST` を付けて `pnpm test` を走らせると、Firestore の実装でも保存の口のテスト（`apps/server/src/storage/contract.ts`）を回す

## Google Cloud の設定

[`scripts/setup-firestore.sh`](../../scripts/setup-firestore.sh) で入れて確かめます（`check` で確かめ、`apply` で入れる）。値は環境変数で渡し、リポジトリには書きません。

| 項目               | 内容                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| API                | Firestore、Identity Toolkit、Security Token、Firebase、Firebase Rules                                                             |
| データベース       | Firestore の `(default)`。ネイティブモード、`asia-northeast1`、削除の保護つき                                                     |
| TTL ポリシー       | コレクショングループ `itineraries`・`versions`・`shares`・`sessions` の `expiresAt`                                               |
| セキュリティルール | [`firestore.rules`](../../firestore.rules)（ブラウザからはすべて断る）を `firebase deploy --only firestore:rules` で入れる        |
| 権限               | Cloud Run の実行用のサービスアカウントに `roles/datastore.user` だけを足す。ID トークンの確認には権限が要らない                   |
| ログイン           | プロジェクトに Firebase を足し、Authentication で Google のログインを有効にする。ログインを許すドメインに Cloud Run の URL を足す |
| Cloud Run          | 環境変数 `MATSURI_STORAGE=firestore`・`FIREBASE_PROJECT_ID`・`FIREBASE_WEB_API_KEY`・`FIREBASE_AUTH_DOMAIN`                       |

`FIREBASE_WEB_API_KEY` と `FIREBASE_AUTH_DOMAIN` は、Firebase のウェブアプリの公開の設定の値です。秘密の値ではありませんが、リポジトリやワークフローには書かず、Cloud Run のサービスの設定に置きます。
