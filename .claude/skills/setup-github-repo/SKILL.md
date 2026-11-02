---
name: setup-github-repo
description: GitHub に公開したこのリポジトリに、秘密情報の検出と push の保護、脆弱性の非公開の報告、main ブランチの保護、Issue テンプレートのラベルを入れる・確かめる。リポジトリを GitHub に作って最初に push したあと、または設定が入っているかを確かめたいときに使う。
---

# GitHub のリポジトリの設定

[`scripts/setup-github.sh`](../../../scripts/setup-github.sh) で、公開したリポジトリに次の設定を入れます。何度実行しても同じ結果になります。

| 設定                         | 中身                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 秘密情報の検出と push の保護 | secret scanning と push protection を有効にする                                                                       |
| 脆弱性の報告と通知           | 脆弱性を非公開で報告できるようにし（`SECURITY.md` の手順の前提）、依存の脆弱性の通知（Dependabot alerts）を有効にする |
| main ブランチの保護          | ルールセット `protect-main`：削除と強制 push を禁じ、PR と CI（`検査とビルド`）の通過を必須にする。承認の数は 0       |
| マージの方法                 | squash merge だけを許し、マージしたブランチを消す                                                                     |
| ラベル                       | Issue テンプレートが付けるラベル（`.github/ISSUE_TEMPLATE/*.yml` の `labels`）を作る                                  |

## 手順

1. **前提を確かめる**
   - `gh auth status`：リポジトリの管理者のアカウントでログインしているか
   - `git remote -v`：GitHub のリポジトリを指しているか。指していなければ、以下のコマンドの最後に `owner/repo` を付ける
   - main が push 済みか。main の保護を入れると、main へ直接 push できなくなる
2. **いまの設定を見る**：`bash scripts/setup-github.sh check`。足りない項目に `NG` が付く
3. **ユーザーの了承を得る**：入れる設定と、入れたあとは main への変更が PR を通すことになる点を伝え、はっきり了承を得る。GitHub の設定を変える操作なので、了承なしに次へ進まない
4. **入れる**：`bash scripts/setup-github.sh apply`
5. **確かめる**：もう一度 `check` を実行し、すべて `OK` になったことを報告する。`NG` が残れば、出力をそのまま伝える

## 名前を変えたとき

- CI のジョブ名（`.github/workflows/ci.yml` の `検査とビルド`）を変えたら、スクリプトの `REQUIRED_CHECK` も直して `apply` し直す
- ラベルは Issue テンプレートから読むので、テンプレートの `labels` を変えたら `apply` し直すだけでよい。色を決めたいときは、スクリプトの `label_color` に足す
