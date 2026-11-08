---
name: create-pr
description: このリポジトリの PR テンプレートに沿って PR を作る。変更・確かめたこと・関連する Issue を書き、push してから gh pr create する。ブランチの作業が終わって PR にしたいときに使う。
---

# PR を作る

## 前提

- main には直接 push しない。作業はブランチで行う（ブランチ名は中身を表す短い英語。例：`fix/day-trip-limit`）
- コミットは `commit` スキルの決まりで積んである
- マージは squash merge。PR のタイトルがそのまま main のコミットの要約になるので、タイトルも Conventional Commits の形にする

## 手順

1. **差分を読む**：`git fetch origin` のあと、`git log --oneline origin/main..HEAD` と `git diff origin/main...HEAD` で、PR に入るものをすべて読む。関係のない変更が混ざっていたら、別のブランチに分ける
2. **確かめる**：`pnpm lint`・`pnpm typecheck`・`pnpm test`・`pnpm build`。画面に触れたら e2e（`pnpm --filter @matsuri-ikoka/web test:e2e`）、祭りのデータに触れたら `pnpm validate:data`。通らなければ直してから進む
3. **公開してよい中身かを確かめる**：差分・コミットの文・ブランチ名に、秘密の値、個人の情報、実在の祭りでの相談の例がないこと。文は変更の中身と使う人にとっての理由だけにする
4. **本文を書く**：[`.github/pull_request_template.md`](../../../.github/pull_request_template.md) の見出しをそのまま使う
   - **変更の内容**：何を、なぜ変えたか。使う人にとって何が変わるか
   - **関連する Issue**：閉じる Issue は `Closes #12`、関わるだけなら `Refs #12`。なければ「なし」
   - **確かめたこと**：実際に走らせたコマンドだけにチェックを付ける。走らせていないものは外すか、理由を書く
   - **チェック**：当てはまる項目を確かめる
   - 最後に、会話の中で指示された署名の行を付ける
5. **push して作る**：

```bash
git push -u origin HEAD
gh pr create --base main --title "fix(server): 日帰りの移動の上限を超える祭りを除く" --body-file "$TMPDIR/pr.md"
```

6. **ラベル**：関連する Issue と同じ `type:*`・`area:*` を PR にも付ける（`gh pr edit <番号> --add-label "type:bug,area:server"`）
7. PR の URL を報告する。CI の結果を待つ・直す・マージするかは、頼まれた範囲で行う。マージは頼まれたときだけ

## CI が落ちたとき

`gh pr checks <番号>` で落ちたジョブを見て、`gh run view <run-id> --log-failed` で理由を読む。ジョブの中身は [開発の流れ](../../../docs/development.md#5-ci) にある。
