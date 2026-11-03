## 変更の内容

<!-- 何を、なぜ変えたか。使う人にとって何が変わるか。タイトルは Conventional Commits の形（squash merge でそのまま main のコミットになる） -->

## 関連する Issue

<!-- 閉じるなら Closes #番号、関わるだけなら Refs #番号。なければ「なし」 -->

## 確かめたこと

<!-- 実際に走らせたものだけにチェックを付ける -->

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] 祭りのデータに触れた：`pnpm validate:data`
- [ ] 画面に触れた：`pnpm --filter @matsuri-ikoka/web test:e2e`、またはモックモード（`MATSURI_AGENT_MODE=mock`）で動かして確かめた
- [ ] コンテナやデプロイに触れた：イメージを作り、モックで `scripts/smoke-mock.mjs --pdf --glb` を通した

## チェック

- [ ] スキーマ（`packages/schema`）を変えた場合、仕様（`docs/spec/`）・サンプルの相談・テストも直した
- [ ] 祭りデータを足したり直したりした場合、出典（URL・確認した日・確度）を付けた
- [ ] テストは架空の祭り（`@matsuri-ikoka/schema/testing`、URL は `example.com`）で書いた
- [ ] API キーなどの秘密情報や、個人を特定できる情報を含めていない
- [ ] 外から集めた文字列やモデルの文章を、HTML として埋め込んでいない
- [ ] 開発用のもの（スキル・エージェント・フック）は `.claude/` にだけ置き、アプリから読んでいない
