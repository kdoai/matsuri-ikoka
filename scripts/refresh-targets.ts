// data/festivals/*.json と調査の台帳から、今週調べる祭りと理由を一覧にする。調査はしない（空実行）。
//
//   pnpm refresh:targets                        今日（日本の日付）を基準に選ぶ
//   pnpm refresh:targets --today 2026-11-01  基準の日を指定する
//   pnpm refresh:targets --json              JSON で出す
//   pnpm refresh:targets --issues issues.json  依頼の Issue を足す
//
// --issues には、gh issue list -R kdoai/matsuri-ikoka --state open --json number,body,labels の出力を渡す
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { FestivalSchema, IsoDateSchema, ResearchLedgerSchema } from "../packages/schema/src";
import { type IssueRequests, type RefreshIssue, requestsFromIssues } from "./festival-refresh";
import { selectRefreshTargets } from "./research-schedule";

const DIR = fileURLToPath(new URL("../data/festivals/", import.meta.url));
const LEDGER_PATH = fileURLToPath(new URL("../data/research-ledger.json", import.meta.url));

const REASON_LABELS = {
  request: "依頼",
  due_soon: "開催が近い",
  checkpoint: "節目が来た",
  retry: "前回は調べ切れなかった",
  fill: "最低の件数を満たす",
} as const;

const UNRESOLVED_LABELS = {
  no_field: "祭りの名前の欄がない",
  not_found: "データにある祭りに当たらない",
  ambiguous: "複数の祭りに当たる",
} as const;

/** gh issue list --json number,body,labels の出力を読む（ラベルは名前だけを使う） */
function readIssues(path: string): RefreshIssue[] {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) throw new Error("--issues には Issue の配列の JSON を渡してください");
  return raw.map((issue) => ({
    number: Number(issue.number),
    body: typeof issue.body === "string" ? issue.body : "",
    labels: Array.isArray(issue.labels)
      ? issue.labels.map((label: { name?: unknown }) => String(label?.name ?? ""))
      : [],
  }));
}

function todayInJapan(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
}

function main(): number {
  const { values } = parseArgs({
    options: {
      today: { type: "string" },
      json: { type: "boolean", default: false },
      issues: { type: "string" },
    },
  });
  const today = IsoDateSchema.parse(values.today ?? todayInJapan());
  const ledger = ResearchLedgerSchema.parse(JSON.parse(readFileSync(LEDGER_PATH, "utf8")));

  // 検証に落ちるファイルは pnpm validate:data で直すので、ここでは読める祭りだけを使う
  const festivals = readdirSync(DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .flatMap((name) => {
      const parsed = FestivalSchema.safeParse(JSON.parse(readFileSync(join(DIR, name), "utf8")));
      return parsed.success ? [parsed.data] : [];
    });
  const { requests, unresolved }: IssueRequests = values.issues
    ? requestsFromIssues(readIssues(values.issues), festivals)
    : { requests: [], unresolved: [] };
  const targets = selectRefreshTargets(festivals, { today, ledger, requests });

  if (values.json) {
    console.log(JSON.stringify(values.issues ? { targets, unresolved } : targets, null, 2));
    return 0;
  }
  for (const target of targets) {
    const reasons = target.reasons.map((reason) => REASON_LABELS[reason]).join("・");
    console.log(`${target.id}（次の開催 ${target.nextDate}）：${reasons}`);
    for (const note of target.notes) console.log(`  ${note}`);
  }
  for (const { number, reason } of unresolved) {
    console.log(`#${number}：祭りの ID を決められない（${UNRESOLVED_LABELS[reason]}）`);
  }
  const filled = targets.filter((target) => target.reasons.includes("fill")).length;
  console.log(
    `\n祭り ${festivals.length} 件のうち、今週調べる祭り ${targets.length} 件（最低の件数を満たすために足した祭り ${filled} 件、基準日 ${today}）`,
  );
  return 0;
}

process.exitCode = main();
