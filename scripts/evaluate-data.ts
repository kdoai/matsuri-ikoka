// data/festivals/*.json から評価の数字を集計し、Markdown の表で出す（docs/evaluation.md に載せる形）。
// スキーマに合わないファイルは数えない（先に pnpm validate:data で直す）。
//
//   pnpm evaluate:data                          今日（日本の日付）を基準に集計する
//   pnpm evaluate:data --today 2026-11-01    基準の日を指定する
//   pnpm evaluate:data --dir path/to/dir     別のフォルダを集計する
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  ETIQUETTE_ITEMS,
  type Festival,
  FestivalSchema,
  IsoDateSchema,
} from "../packages/schema/src";
import { evaluateFestivals, formatRatio } from "./evaluation";

const DEFAULT_DIR = fileURLToPath(new URL("../data/festivals/", import.meta.url));

function todayInJapan(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
}

function readFestivals(dir: string): { festivals: Festival[]; skipped: string[] } {
  const festivals: Festival[] = [];
  const skipped: string[] = [];
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .sort()) {
    try {
      const parsed = FestivalSchema.safeParse(JSON.parse(readFileSync(join(dir, name), "utf8")));
      if (parsed.success) festivals.push(parsed.data);
      else skipped.push(name);
    } catch {
      skipped.push(name);
    }
  }
  return { festivals, skipped };
}

function main(): number {
  const { values } = parseArgs({
    options: { today: { type: "string" }, dir: { type: "string" } },
  });
  const today = IsoDateSchema.parse(values.today ?? todayInJapan());
  // pnpm から呼ぶと作業フォルダがリポジトリのルートになるので、--dir は呼んだ場所（INIT_CWD）から読む
  const dir =
    values.dir === undefined
      ? DEFAULT_DIR
      : resolve(process.env.INIT_CWD ?? process.cwd(), values.dir);

  const { festivals, skipped } = readFestivals(dir);
  const result = evaluateFestivals(festivals, { today });
  const lines = [
    `基準日 ${today}、祭り ${result.festivals} 件（掲載停止を除く）`,
    "",
    "| 指標 | 結果 |",
    "| --- | --- |",
    `| 穴場（知名度 local）の割合 | ${formatRatio(result.local)} |`,
    `| 次の開催を公式か複数の情報源で確認できた割合 | ${formatRatio(result.confirmed)} |`,
    `| 参加の仕方と決まりの項目が分かっている割合 | ${formatRatio(result.etiquetteKnown)} |`,
    `| 1件あたりの gaps の数 | ${result.gapsPerFestival.toFixed(1)} |`,
    "",
    "| 次の開催回の出典の確度 | 祭り |",
    "| --- | --- |",
    ...Object.entries(result.occurrenceConfidence).map(([level, n]) => `| ${level} | ${n} |`),
    "",
    "| 参加の仕方と決まりの項目 | 分かっている祭り |",
    "| --- | --- |",
    ...ETIQUETTE_ITEMS.map(
      (item) => `| ${item} | ${formatRatio(result.etiquetteKnownByItem[item])} |`,
    ),
  ];
  console.log(lines.join("\n"));
  if (skipped.length > 0) {
    console.error(`\nスキーマに合わず数えなかったファイル：${skipped.join("、")}`);
    return 1;
  }
  return 0;
}

process.exitCode = main();
