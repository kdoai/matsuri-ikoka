// 条件の組を祭りの検索に流し、候補を出せた割合を Markdown の表で出す（docs/evaluation.md に載せる形）。
// スキーマに合わないファイルは数えない（先に pnpm validate:data で直す）。
//
//   pnpm evaluate:conditions                       今日（日本の日付）を基準に集計する
//   pnpm evaluate:conditions --today 2026-11-01    基準の日を指定する
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  createStationPointIndex,
  type StationPoint,
} from "../apps/server/src/domain/travelEstimate";
import { type Festival, FestivalSchema, IsoDateSchema } from "../packages/schema/src";
import { EVALUATION_ORIGINS, evaluateConditions } from "./condition-evaluation";
import { formatRatio } from "./evaluation";

const FESTIVALS_DIR = fileURLToPath(new URL("../data/festivals/", import.meta.url));
const STATIONS_FILE = fileURLToPath(new URL("../data/stations/points.json", import.meta.url));

function todayInJapan(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
}

function readFestivals(dir: string): { festivals: Festival[]; skipped: string[] } {
  const festivals: Festival[] = [];
  const skipped: string[] = [];
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .sort()) {
    const parsed = FestivalSchema.safeParse(JSON.parse(readFileSync(join(dir, name), "utf8")));
    if (parsed.success) festivals.push(parsed.data);
    else skipped.push(name);
  }
  return { festivals, skipped };
}

function main(): number {
  const { values } = parseArgs({ options: { today: { type: "string" } } });
  const today = IsoDateSchema.parse(values.today ?? todayInJapan());
  const { festivals, skipped } = readFestivals(FESTIVALS_DIR);
  const { points } = JSON.parse(readFileSync(STATIONS_FILE, "utf8")) as { points: StationPoint[] };
  const result = evaluateConditions(festivals, {
    today,
    stations: createStationPointIndex(points),
  });

  const lines = [
    `基準日 ${today}、祭り ${festivals.filter((f) => !f.optOut).length} 件（掲載停止を除く）、条件の組 ${result.found.total} 通り`,
    "",
    "| 指標 | 結果 |",
    "| --- | --- |",
    `| 候補を1件以上出せた条件の組 | ${formatRatio(result.found)} |`,
    `| 候補を3件そろえられた条件の組 | ${formatRatio(result.threeOrMore)} |`,
    `| 候補が出ないときに、見つかる次の手を示せた組 | ${formatRatio(result.nextStepWhenNone)} |`,
    `| 条件を破っていた候補 | ${result.violations.length} / ${result.candidates} |`,
    `| 候補のうち、開催を確かめられているもの | ${formatRatio(result.confirmedCandidates)} |`,
    `| 日帰りの候補のうち、片道の上限に収まると分かっているもの | ${formatRatio(result.dayTripWithinLimit)} |`,
    "",
    "| 泊数 | 候補を出せた組 |",
    "| --- | --- |",
    ...Object.entries(result.byNights).map(
      ([nights, ratio]) =>
        `| ${nights === "0" ? "日帰り" : `${nights}泊`} | ${formatRatio(ratio)} |`,
    ),
    "",
    "| 希望の日 | 候補を出せた組 |",
    "| --- | --- |",
    `| その月のどこか | ${formatRatio(result.byShape.month)} |`,
    `| 月の最初の土曜日 | ${formatRatio(result.byShape.saturday)} |`,
    "",
    "| 出発の駅 | 候補を出せた組 |",
    "| --- | --- |",
    ...EVALUATION_ORIGINS.map((o) => {
      const ratio = result.byOrigin[o];
      return `| ${o} | ${ratio === undefined ? "—" : formatRatio(ratio)} |`;
    }),
    "",
    "| 月 | 候補を出せた組 |",
    "| --- | --- |",
    ...Object.entries(result.byMonth).map(
      ([month, ratio]) => `| ${month} | ${formatRatio(ratio)} |`,
    ),
  ];
  console.log(lines.join("\n"));
  if (result.violations.length > 0) {
    console.error(`\n条件を破っていた候補：\n${result.violations.join("\n")}`);
  }
  if (skipped.length > 0) {
    console.error(`\nスキーマに合わず数えなかったファイル：${skipped.join("、")}`);
  }
  return 0;
}

process.exitCode = main();
