// data/festivals/*.json を検証する。エラーがあれば終了コード1で終わる（警告だけなら0）。
//
//   pnpm validate:data                          今日（日本の日付）を基準に検証する
//   pnpm validate:data --today 2026-11-01    基準の日を指定する
//   pnpm validate:data --dir path/to/dir     別のフォルダを検証する
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { IsoDateSchema } from "../packages/schema/src";
import {
  type FestivalFile,
  RESEARCH_LEDGER_FILE,
  validateFestivalFiles,
  validateResearchLedger,
} from "./festival-validation";

const DEFAULT_DIR = fileURLToPath(new URL("../data/festivals/", import.meta.url));
const LEDGER_PATH = fileURLToPath(new URL(`../data/${RESEARCH_LEDGER_FILE}`, import.meta.url));

function todayInJapan(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
}

function readFestivalFiles(dir: string): FestivalFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({ name, content: readFileSync(join(dir, name), "utf8") }));
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

  const files = readFestivalFiles(dir);
  if (files.length === 0) {
    console.log(`祭りのデータがありません（${dir}）`);
    return 0;
  }

  const findings = validateFestivalFiles(files, { today });
  // 調査の台帳は、既定のデータを検証するときだけ見る
  if (values.dir === undefined) {
    const ids = new Set(files.map((file) => file.name.replace(/\.json$/, "")));
    findings.push(...validateResearchLedger(readFileSync(LEDGER_PATH, "utf8"), ids));
  }
  for (const name of [...files.map((file) => file.name), RESEARCH_LEDGER_FILE]) {
    const own = findings.filter((f) => f.file === name);
    if (own.length === 0) continue;
    console.log(`\n${name}`);
    for (const { level, message } of own) {
      console.log(`  ${level === "error" ? "エラー" : "警告"}  ${message}`);
    }
  }
  const errors = findings.filter((f) => f.level === "error").length;
  const warnings = findings.length - errors;
  console.log(
    `\n祭り ${files.length} 件（基準日 ${today}）：エラー ${errors} 件、警告 ${warnings} 件`,
  );
  return errors > 0 ? 1 : 0;
}

process.exitCode = main();
