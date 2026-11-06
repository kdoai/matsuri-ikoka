# サンプルの相談

モックモード（`MATSURI_AGENT_MODE=mock`）で再生する、記録した相談です。API キーがなくても、相談から旅のしおりまでを画面で確かめられます。

**ここにある祭り・町・店・駅・出典は、すべて架空です。** 出典の URL は例示用のドメイン（`example.com`）にしてあります。実在の祭りのデータは `data/festivals/` に置きます。

| パス                   | 中身                                              | スキーマ                   |
| ---------------------- | ------------------------------------------------- | -------------------------- |
| `festivals/*.json`     | サンプルの相談に出てくる架空の祭り                | `FestivalSchema`           |
| `conversations/*.json` | 発言と、それへの返答として流れた SSE イベントの列 | `SampleConversationSchema` |
| `guide/*.json`         | しおりのあとのガイドの相談と、見回りの1回         | `SampleGuideSchema`        |

## 相談のファイルの形

```jsonc
{
  "id": "suzunari-day-trip",
  "title": "…",
  "description": "…",
  "today": "2026-08-03", // 相談した日（日程のルールでいう「今日」）
  "turns": [
    {
      "request": {
        "message": "…",
        "preferences": { "party": "adults", "spot": "auto", "food": "stalls", "move": "train" }
      },
      "events": [
        { "atMs": 0, "event": { "type": "staff.start", "data": { "…": "…" } } },
        { "atMs": 4300, "event": { "type": "done", "data": { "…": "…" } } }
      ]
    }
  ]
}
```

- `atMs` は、その発言を送ってからの経過時間（ミリ秒）です。再生するときは、この間隔でイベントを送ります
- 各発言への返答は、必ず `done` で終わります
- 候補の窓の次の手（ボタン）から送った発言は、`request.search` に変えて探し直す条件を持ちます（例：`suzunari-no-match.json` の2つ目の発言）
- イベントの形は [SSE イベントの仕様](../../docs/spec/api.md#sse-イベント) を見てください

## ガイドのファイルの形

`conversation` の相談で作った旅を元にします。形は [旅のガイドの仕様](../../docs/spec/guide.md) にあります。

```jsonc
{
  "id": "suzunari-guide",
  "title": "…",
  "description": "…",
  "today": "2026-08-10", // ガイドと話した日（旅の時期を決める「今日」）
  "conversation": "suzunari-day-trip", // 元にする相談
  "watch": { "…": "…" }, // 見回りの依頼
  "patrol": {
    "request": { "…": "…" }, // 見回り係への依頼（利用者の情報を持たない）
    "report": { "…": "…" }, // 見回り係の報告
    "changes": [] // 検問を通った変化
  },
  "notices": [], // 旅に届いた通知
  "proposals": [], // 組み直しの提案（承認を待っている）
  "turns": [
    {
      "request": { "message": "…" }, // 現在地は記録しない
      "events": [{ "atMs": 0, "event": { "type": "guide.done", "data": { "…": "…" } } }]
    }
  ]
}
```

- 各発言への返答は、必ず `guide.done` で終わります
- `patrol.request` の変わった行には、ページの中の指示に見える文を入れてあります。報告・変化・通知・提案・返答に残らないことを、テストで確かめます

ファイルは `pnpm test` でスキーマと照らし合わせ、祭りや周辺の場所への参照が切れていないかも確かめます。
