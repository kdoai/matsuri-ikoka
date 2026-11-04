# サンプルの相談

モックモード（`MATSURI_AGENT_MODE=mock`）で再生する、記録した相談です。API キーがなくても、相談から旅のしおりまでを画面で確かめられます。

**ここにある祭り・町・店・駅・出典は、すべて架空です。** 出典の URL は例示用のドメイン（`example.com`）にしてあります。実在の祭りのデータは `data/festivals/` に置きます。

| パス                   | 中身                                              | スキーマ                   |
| ---------------------- | ------------------------------------------------- | -------------------------- |
| `festivals/*.json`     | サンプルの相談に出てくる架空の祭り                | `FestivalSchema`           |
| `conversations/*.json` | 発言と、それへの返答として流れた SSE イベントの列 | `SampleConversationSchema` |

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

ファイルは `pnpm test` でスキーマと照らし合わせ、祭りや周辺の場所への参照が切れていないかも確かめます。
