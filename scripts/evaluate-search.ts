// data/festivals/*.json から、祭りから探すときの種類×季節×地方の件数と、0件の組み合わせを出す。
// スキーマに合わないファイルは数えない（先に pnpm validate:data で直す）。
//
//   pnpm eval:search                          今日（日本の日付）を基準に数える
//   pnpm eval:search --today 2026-11-01    基準の日を指定する
//   pnpm eval:search --dir path/to/dir     別のフォルダを数える
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  FESTIVAL_KINDS,
  type Festival,
  type FestivalKind,
  FestivalSchema,
  IsoDateSchema,
  SEASONS,
  type Season,
} from "../packages/schema/src";
import { COVERAGE_REGIONS, FEW_RESULTS, searchCoverage } from "./search-coverage";

const DEFAULT_DIR = fileURLToPath(new URL("../data/festivals/", import.meta.url));

const KIND_LABELS: Record<FestivalKind, string> = {
  fireworks: "花火",
  community: "地域の祭り",
  traditional: "伝統的な祭り",
  participatory: "参加型の祭り",
  hidden: "マイナー",
  famous: "メジャー",
};
const SEASON_LABELS: Record<Season, string> = {
  spring: "春",
  summer: "夏",
  autumn: "秋",
  winter: "冬",
};

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
  const coverage = searchCoverage(festivals, today);
  const lines = [
    `基準日 ${today}、祭り ${coverage.festivals} 件（掲載停止を除く）、今日以降の開催回があるもの ${coverage.searchable} 件`,
    `種類×季節×地方 ${coverage.cells.length} 通りのうち、0件 ${coverage.empty.length} 通り、1〜${FEW_RESULTS}件 ${coverage.few.length} 通り`,
    "",
    "## 種類ごとの件数（季節と地域を問わない）",
    "",
    "| 種類 | 件数 | 強く合う |",
    "| --- | --- | --- |",
    ...FESTIVAL_KINDS.map((kind) => {
      const total = coverage.kindTotals[kind];
      return `| ${KIND_LABELS[kind]} | ${total.count} | ${total.strong} |`;
    }),
    "",
  ];
  for (const kind of FESTIVAL_KINDS) {
    lines.push(
      `## ${KIND_LABELS[kind]}`,
      "",
      `| 地方 | ${SEASONS.map((s) => SEASON_LABELS[s]).join(" | ")} |`,
      `| --- | ${SEASONS.map(() => "---").join(" | ")} |`,
    );
    for (const region of COVERAGE_REGIONS) {
      const row = SEASONS.map((season) => {
        const cell = coverage.cells.find(
          (c) => c.kind === kind && c.season === season && c.region === region,
        );
        return cell?.count ?? 0;
      });
      lines.push(`| ${region} | ${row.join(" | ")} |`);
    }
    lines.push("");
  }
  lines.push("## 0件の組み合わせ", "");
  for (const kind of FESTIVAL_KINDS) {
    const empty = coverage.empty.filter((c) => c.kind === kind);
    if (empty.length === 0) continue;
    const list = empty.map((c) => `${c.region}の${SEASON_LABELS[c.season]}`).join("、");
    lines.push(`- ${KIND_LABELS[kind]}（${empty.length}通り）：${list}`);
  }
  if (coverage.empty.length === 0) lines.push("なし");
  console.log(lines.join("\n"));
  if (skipped.length > 0) {
    console.error(`\nスキーマに合わず数えなかったファイル：${skipped.join("、")}`);
  }
  return 0;
}

process.exitCode = main();
