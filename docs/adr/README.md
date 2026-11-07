# 設計判断の記録（ADR）

アプリに関わる設計の判断を、「背景・判断・結果」の形で短く残します。判断を変えるときは、元の ADR を書き換えず、新しい ADR を足して古いものの状態を「置き換え」にします。

| 番号                                              | 判断                                                                               | 状態             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------- |
| [0001](0001-claude-agent-sdk.md)                  | 接客エージェントに Claude Agent SDK（TypeScript）を使う                            | 採用             |
| [0002](0002-festival-data-as-json-in-git.md)      | 祭りのデータを1件1ファイルの JSON にし、Git で管理する                             | 採用             |
| [0003](0003-3d-as-a-view-layer.md)                | 3D の店内を、状態の見た目の層にとどめる                                            | 採用             |
| [0004](0004-authentication.md)                    | 場面ごとに Claude への認証を分ける                                                 | 採用             |
| [0005](0005-login-and-storage.md)                 | ログインに Firebase Authentication、保存先に Firestore を使う                      | 採用             |
| [0006](0006-lodging-search.md)                    | 宿の空きと料金を、楽天トラベルの空室検索 API から取る                              | 採用             |
| [0007](0007-festival-refresh-workflow.md)         | 祭りのデータを、GitHub Actions から Managed Agents で確かめ直し、PR で届ける       | 置き換え（0009） |
| [0008](0008-plan-check-and-evaluation-loop.md)    | 旅程にそろうべきものを型とコードで確かめ、評価係の採点が届くまで調べ直して作り直す | 採用             |
| [0009](0009-weekly-research-on-managed-agents.md) | 祭りの週次の調査を Managed Agents の定期実行で進め、API キーなしで回収する         | 採用             |
| [0010](0010-place-data-sources.md)                | 店と宿の一覧は OpenStreetMap で探し、公式のページで確かめる                        | 採用             |
| [0011](0011-owner-isolation.md)                   | 相談と旅を利用者ごとに分け、経路ごとの決まりで既定で断る                           | 採用             |
| [0012](0012-trip-patrol.md)                       | 頼まれた旅の見回りは、変化があるときだけ Managed Agents に読ませる                 | 採用             |
| [0013](0013-guide-conversation.md)                | 旅のガイドの会話は組み込みの道具なしで動かし、変更は直しの提案にする               | 採用             |
