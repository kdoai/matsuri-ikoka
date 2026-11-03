import { config } from "zod";

// スキーマの検証（zod）に、Function で速くする道を試させない。
// 画面のページの CSP は eval を許さないので、試すと違反の報告が出てしまう。
// zod はスキーマを作るときに試すので、スキーマのモジュールより先に読み込む（main.tsx の先頭）。
config({ jitless: true });
