# 見回りの Managed Agents の定義

頼まれた旅の見回りで使う Claude Managed Agents の資源を、1資源1ファイルで管理します。仕組みと判断の理由は [運用の仕様](../docs/spec/operations.md#旅の見回り) と [ADR 0012](../docs/adr/0012-trip-patrol.md) にあります。

```text
managed-agents-patrol/
  agents/patrol-reader.md    見回り係（依頼にある公開のページだけを読み、書き込まない）
  environments/patrol.yaml   実行の環境
  claude-lock.json           ant apply が書く、資源の ID の記録（適用したらコミットする）
```

エージェントの Markdown は、前書きが設定で、本文がシステムプロンプトです。スキルも定期実行もありません。対象は頼まれた旅から実行のたびに決まるので、サーバーが内部の API の起動を受けて、エージェントと環境を名前で探してセッションを作ります。名前を変えるときは `apps/server/src/patrol/config.ts` の `PATROL_NAMES` も直します。

## 週次の調査と分けている理由

公開のサーバーは、見回り係のセッションを作るために、長く使える API キーを持ちます。この鍵が週次の調査のワークスペースに届かないよう、見回りは専用のワークスペースに置きます。`ant apply` はディレクトリを深さに関わらず歩き、1つの lock は1つのワークスペースにしか対応しないので、[`managed-agents/`](../managed-agents/README.md) の中ではなく、この別のディレクトリと別の `claude-lock.json` にしています。

`update-festivals.yml` の適用（`managed-agents/` だけ）には入りません。

## 変えるとき

1. ファイルを直して PR にする。`scripts/patrol-agents-config.test.ts` が、道具の分け方や費用の上限が崩れていないことを確かめる
2. マージしたら、見回りのワークスペースの資格情報で、このディレクトリから差分を確かめる

```bash
ant apply --lock-file ./claude-lock.json --dry-run agents environments
```

3. 人が内容を確かめてから適用し、`claude-lock.json` の更新を PR にする

```bash
ant apply --lock-file ./claude-lock.json agents environments
```

`ant apply` は、lock の記録と違うワークスペースの資格情報を断ります。

## 費用の抑え方

変わらないページではモデルを呼びません。セッションごとの予算（`PATROL_SESSION_BUDGET_USD`）と、1回の対象の数の上限（`PATROL_MAX_TARGETS`）で抑えます（[見回りの費用](../docs/spec/operations.md#見回りの費用)）。
