---
name: create-issue
description: このリポジトリに Issue を起票する。テンプレートを選び、type・area・priority・status のラベルを付ける。不具合・機能の提案・作業・祭りのデータの訂正などを Issue にしたいとき、作業の途中で見つけた別の課題を残したいときに使う。
---

# Issue を起票する

## 種類の分け方

このリポジトリは個人のアカウントのものなので、GitHub の Issue Types は使えない（`bash scripts/setup-github.sh check` の最後の行で確かめられる）。種類は `type:*` のラベルで分ける。Issue Types が使えるようになったら、ラベルの代わりに Types を付ける。

| 起票するもの                 | テンプレート                   | 付くラベル（テンプレートが付ける）                          |
| ---------------------------- | ------------------------------ | ----------------------------------------------------------- |
| 期待どおりに動かない         | `bug-report.yml`               | `bug`・`type:bug`・`status:triage`                          |
| 機能の提案                   | `feature-request.yml`          | `type:feature`・`status:triage`                             |
| 開発の作業（設定・整理など） | `task.yml`                     | `type:task`・`status:triage`                                |
| 祭りの情報の誤り             | `festival-correction.yml`      | `data-correction`・`type:data`・`area:data`・`status:triage` |
| 祭りの掲載・情報提供         | `festival-listing-request.yml` | `listing-request`・`type:data`・`area:data`・`status:triage` |
| 掲載停止                     | `festival-opt-out.yml`         | `opt-out`・`type:data`・`area:data`・`priority:high`・`status:triage` |

ラベルの一覧と意味は [`.github/labels.json`](../../../.github/labels.json) にある。

- `area:*`：変える場所。複数付けてよい（`schema`・`server`・`agent-kit`・`web`・`3d`・`shiori`・`data`・`infra`・`docs`）
- `priority:*`：`high`（使う人が困っている・データが誤っている）・`medium`・`low`。分からなければ付けない
- `status:*`：起票のときは `status:triage`。取りかかるときに `status:in-progress`、待ちは `status:blocked` か `status:needs-info`

## 手順

1. **重なりを確かめる**：`gh issue list --state all --search "<キーワード>"`。同じものがあれば、新しく作らずにそちらにコメントする
2. **テンプレートを選ぶ**：上の表から1つ。テンプレートの項目（`.github/ISSUE_TEMPLATE/*.yml` の `body`）を読み、同じ見出しで本文を組み立てる
3. **本文を書く**：
   - 公開されるので、個人の連絡先・秘密の値・相談の生の文は書かない
   - 例に出す祭りは架空のものにする（実在の祭りのデータの訂正は除く）
   - 理由は、使う人にとっての理由で書く
   - 不具合は、再現の手順と期待した動きを書く。作業は、終わりの条件をチェックリストで書く
4. **ユーザーに見せて了承を得る**：タイトル・本文・ラベルを見せる。Issue は公開されるので、了承なしに作らない
5. **作る**：テンプレートのラベルに、`area:*`（と分かれば `priority:*`）を足す

```bash
gh issue create \
  --title "[作業] 〜を〜する" \
  --body-file "$TMPDIR/issue.md" \
  --label "type:task,status:triage,area:infra"
```

6. 作った Issue の URL を報告する

## ラベルがないと言われたとき

`gh issue create` が「ラベルがない」で止まったら、リポジトリにラベルがまだ入っていない。`setup-github-repo` スキルの手順で、ユーザーの了承を得てから `bash scripts/setup-github.sh apply` を実行する。
