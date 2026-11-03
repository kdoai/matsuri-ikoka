---
name: setup-github-repo
description: GitHub に公開したこのリポジトリに、秘密情報の検出と push の保護、脆弱性の非公開の報告、main ブランチの保護（必須の検査）、ラベルの体系を入れる・確かめる。リポジトリを GitHub に作って最初に push したあと、CI のジョブやラベルを変えたあと、設定が入っているかを確かめたいときに使う。
---

# GitHub のリポジトリの設定

[`scripts/setup-github.sh`](../../../scripts/setup-github.sh) で、公開したリポジトリに次の設定を入れます。何度実行しても同じ結果になります（ある設定は上書きし、ないものだけを作る）。

| 設定                         | 中身                                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 秘密情報の検出と push の保護 | secret scanning と push protection を有効にする                                                                                              |
| 脆弱性の報告と通知           | 脆弱性を非公開で報告できるようにし（`SECURITY.md` の手順の前提）、依存の脆弱性の通知（Dependabot alerts）を有効にする                        |
| main ブランチの保護          | ルールセット `protect-main`：削除と強制 push を禁じ、PR と CI の通過を必須にする。必須の検査はスクリプトの `REQUIRED_CHECKS`。承認の数は 0 |
| マージの方法                 | squash merge だけを許し、マージしたブランチを消す                                                                                            |
| ラベル                       | [`.github/labels.json`](../../../.github/labels.json) のラベル（`type:*`・`area:*`・`priority:*`・`status:*` と、テンプレートが前から使う4つ）を作り、色と説明を合わせる |

`check` は最後に、GitHub の Issue Types が使えるかも表示します（個人のアカウントのリポジトリでは使えないので、種類は `type:*` のラベルで分けます）。

## 手順

1. **前提を確かめる**
   - `gh auth status`：リポジトリの管理者のアカウントでログインしているか
   - `git remote -v`：GitHub のリポジトリを指しているか。指していなければ、以下のコマンドの最後に `owner/repo` を付ける
   - main が push 済みか。main の保護を入れると、main へ直接 push できなくなる
   - 必須の検査を変えるときは、新しい CI（`.github/workflows/ci.yml`）が main に入っていて、PR で一度は走っているか。走っていない名前を必須にすると、どの PR もマージできなくなる
2. **いまの設定を見る**：`bash scripts/setup-github.sh check`。足りない項目、食い違う項目に `NG` が付く
3. **ユーザーの了承を得る**：入れる設定（`NG` の項目）と、入れたあとは main への変更が PR と必須の検査を通ることを伝え、はっきり了承を得る。GitHub の設定を変える操作なので、了承なしに次へ進まない
4. **入れる**：`bash scripts/setup-github.sh apply`
5. **確かめる**：もう一度 `check` を実行し、すべて `OK` になったことを報告する。`NG` が残れば、出力をそのまま伝える

GitHub が最初から作るラベル（`enhancement`・`question` など）は消しません。使わないものを消すかは、ユーザーに聞いてから `gh label delete` で消します。

## 名前を変えたとき

- CI のジョブの `name` を変えたら、スクリプトの `REQUIRED_CHECKS` も直す。食い違うと `scripts/github-config.test.ts` が落ちる。マージのあとに `apply` し直す
- ラベルは `.github/labels.json` を直して `apply` し直す。Issue テンプレートの `labels` は、この一覧にある名前だけを使う（同じテストで確かめる）
