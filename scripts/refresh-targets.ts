// data/festivals/*.json から、確かめ直す祭りと理由を一覧にする。調査はしない（空実行）。
//
//   pnpm refresh:targets                        今日（日本の日付）を基準に選ぶ
//   pnpm refresh:targets --today 2026-11-01  基準の日を指定する
//   pnpm refresh:targets --within 14         開催が近いとみなす日数（既定は30）
//   pnpm refresh:targets --json              JSON で出す
//   pnpm refresh:targets --issues issues.json  依頼の Issue を足す
//
// --issues には、gh issue list -R kdoai/matsuri-ikoka --state open --json number,body,labels の出力を渡す
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { FestivalSchema, IsoDateSchema } from "../packages/schema/src";
import {
  DEFAULT_UPCOMING_WITHIN_DAYS,
  type IssueRequests,
  type RefreshIssue,
  requestsFromIssues,
  selectRefreshTargets,
} from "./festival-refresh";

const DIR = fileURLToPath(new URL("../data/festivals/", import.meta.url));

const REASON_LABELS = {
  request: "依頼",
  expected: "見込みのまま",
  upcoming: "開催が近い",
  stale: "確認日が古い",
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
      within: { type: "string" },
      json: { type: "boolean", default: false },
      issues: { type: "string" },
    },
  });
  const today = IsoDateSchema.parse(values.today ?? todayInJapan());
  const upcomingWithinDays = Number(values.within ?? DEFAULT_UPCOMING_WITHIN_DAYS);
  if (!Number.isInteger(upcomingWithinDays) || upcomingWithinDays < 0) {
    console.error("--within には0以上の整数を指定してください");
    return 1;
  }

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
  const targets = selectRefreshTargets(festivals, { today, upcomingWithinDays, requests });

  if (values.json) {
    console.log(JSON.stringify(values.issues ? { targets, unresolved } : targets, null, 2));
    return 0;
  }
  for (const target of targets) {
    const reasons = target.reasons.map((reason) => REASON_LABELS[reason]).join("・");
    console.log(`${target.id}（次の開催 ${target.nextDate ?? "未定"}）：${reasons}`);
    for (const note of target.notes) console.log(`  ${note}`);
  }
  for (const { number, reason } of unresolved) {
    console.log(`#${number}：祭りの ID を決められない（${UNRESOLVED_LABELS[reason]}）`);
  }
  console.log(
    `\n祭り ${festivals.length} 件のうち、確かめ直す対象 ${targets.length} 件（基準日 ${today}）`,
  );
  return 0;
}

process.exitCode = main();
