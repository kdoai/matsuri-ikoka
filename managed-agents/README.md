# Managed Agents の定義

祭りの週次の調査と、頼まれた旅の見回りで使う Claude Managed Agents の資源を、1資源1ファイルで管理します。`ant apply` がファイルと API の資源を同じにします。仕組みと判断の理由は、週次の調査は [運用の仕様](../docs/spec/operations.md#祭りのデータの更新) と [ADR 0009](../docs/adr/0009-weekly-research-on-managed-agents.md)、見回りは [運用の仕様](../docs/spec/operations.md#旅の見回り) と [ADR 0012](../docs/adr/0012-trip-patrol.md) にあります。

```text
managed-agents/
  agents/
    research-lead.md        リード（Web を読まず、任せて報告を書く）
    research-reader.md      調査員（Web を読み、書き込まない）
    research-reviewer.md    確認役（found の報告の根拠を開いて確かめる）
    patrol-reader.md        見回り係（依頼にある公開のページだけを読み、書き込まない）
  environments/research.yaml        週次の調査の実行の環境
  environments/patrol.yaml          見回りの実行の環境
  memory_stores/research-queue.yaml 調査リストの置き場（セッションからは読むだけ）
  deployments/weekly-research.yaml  週に1回の定期実行、費用の上限、採点の基準
  claude-lock.json          ant apply が書く、資源の ID の記録（コミットする）
```

エージェントの Markdown は、前書きが設定で、本文がシステムプロンプトです。調査員と確認役には、開発でも使う調査のスキル（[`.claude/skills/festival-research`](../.claude/skills/festival-research)）をパスで渡します。ほかのスキルは渡しません。見回り係にはスキルを渡しません。

見回りには定期実行の定義がありません。対象は頼まれた旅から実行のたびに決まるので、サーバーが内部の API の起動を受けて、エージェントと環境を名前で探してセッションを作ります。名前を変えるときは `apps/server/src/patrol/config.ts` の `PATROL_NAMES` も直します。

## 変えるとき

1. ファイルを直して PR にする。`scripts/managed-agents-config.test.ts` と `scripts/patrol-agents-config.test.ts` が、道具の分け方や費用の上限が崩れていないことを確かめる
2. マージしたら、GitHub の Actions の画面で `update-festivals.yml` を main で起動し、`plan` で差分を確かめる
3. `setup` で適用する。`claude-lock.json` の更新は PR で届くので、次の適用の前にマージする

連携のルールが main の `update-festivals.yml` の手での起動と定期実行だけを受け付けるので、PR の中や手元からは適用できません。

## 費用の抑え方

1回の実行の目安は 20 米ドル以下です。`deployments/weekly-research.yaml` の `budget` が上限です。

| 工夫                                              | ファイル                       |
| ------------------------------------------------- | ------------------------------ |
| 検索は12回、ページは15件まで                      | `research-reader.md`           |
| 確認役は found の報告だけを、根拠のページだけ見る | `research-reviewer.md`         |
| 採点のやり直しは2回まで                           | `weekly-research.yaml`         |
| 調べる祭りを絞る（確定した回は調べない）          | `scripts/research-schedule.ts` |

見回りの費用は、変わらないページでモデルを呼ばないことと、セッションの予算（`PATROL_SESSION_BUDGET_USD`）と、1回の対象の数の上限（`PATROL_MAX_TARGETS`）で抑えます（[見回りの費用](../docs/spec/operations.md#見回りの費用)）。
