# ADR 0007：祭りのデータを、GitHub Actions から Managed Agents で確かめ直し、PR で届ける

- 状態：採用

## 背景

祭りの開催日や作法は年ごとに変わり、今年の発表がまだ見つからず「見込み」のままの祭りもある。古い情報のまま案内すると、利用者は着いてから日付の違いや作法の変化に気づく。データの正は Git の `data/festivals` にあり（[ADR 0002](0002-festival-data-as-json-in-git.md)）、変更は PR の検査と人の確認を通して入れる。確かめ直しは Web を調べる重い仕事で、費用がかかり、調べたページの中の文字は信用できない。

## 判断

- 確かめ直しは GitHub Actions のワークフロー（`.github/workflows/update-festivals.yml`）から週に1回と手で起動する。祭りごとに Claude Managed Agents のセッションを1つ起動し（`scripts/run-managed-agent.ts`）、返ってきた結果をスキーマ・データの検証・出典を実際に開いたかで確かめてから取り込む
- ワークフローは、調査のジョブと PR のジョブに分ける。調査のジョブは API キーを読むが、GitHub への書き込みの権限を持たない。PR のジョブは書き込めるが、API キーを読まない。調査の結果は、取り込めると確かめた祭りのファイルと PR の本文だけを、成果物として受け渡す
- Managed Agents の側には GitHub の権限を渡さない。ファイルの書き込み・ブランチ・PR は、すべて GitHub Actions が行う
- API キーは接客のものと分けた確かめ直し専用のものにし、Secret Manager に置く。GitHub Actions からは Workload Identity 連携で、確かめ直し専用のサービスアカウント（そのシークレットの `roles/secretmanager.secretAccessor` だけ）として読む。鍵のファイルは作らない。キーは調査のステップの中だけで読み、ほかのステップやファイルに残さない
- 変数 `MATSURI_REFRESH_ENABLED` が `true` でないあいだは、対象を一覧にする空実行だけを行う。費用の上限と1回目の対象の件数を人が確かめてから、`true` にする
- 費用は、調べる祭りの数の上限（既定は5件）と、セッションごとの費用の上限（既定は2米ドル）で抑える
- 取り込める結果があれば、`chore/refresh-festivals-<実行の番号>` のブランチに祭りのファイルだけをコミットして PR を開く。データは直接 main に入れない。掲載停止の変更は調査の結果としては取り込まず、人が確かめる
- `GITHUB_TOKEN` で開いた PR では CI が自動では始まらないので、PR のジョブがそのブランチで `ci.yml` を手で起動する（`workflow_dispatch`）。main の保護の必須の検査は、同じコミットの検査の結果で満たされる

## 結果

- 良い点：見込みのままの祭りや開催が近い祭りが、人の手を待たずに確かめ直され、変わったところと出典が PR の本文にまとまって届く。調査が乗っ取られても、GitHub とクラウドの側でできることがない
- 引き受けること：
  - 人が行う用意がある。確かめ直し専用の API キーとサービスアカウント、Secret Manager のシークレット、Workload Identity 連携でそのアカウントを使う許可、Managed Agents のエージェント（Web の取得・検索を有効にする）と環境、GitHub Actions の変数、リポジトリの設定「GitHub Actions に PR の作成を許す」
  - PR のマージは、当面すべて人が確かめて行う。変更の種類による自動のマージ（[運用の仕様](../spec/operations.md#マージのルール)）は、実際の PR をいくつか見てから入れる
  - 費用は Anthropic のコンソールの利用額の上限でも抑える。止めるときは `MATSURI_REFRESH_ENABLED` を `true` 以外にする
