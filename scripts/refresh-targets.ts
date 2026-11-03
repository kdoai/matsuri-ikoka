// data/festivals/*.json から、確かめ直す祭りと理由を一覧にする。調査はしない（空実行）。
//
//   pnpm refresh:targets                        今日（日本の日付）を基準に選ぶ
//   pnpm refresh:targets --today 2026-11-01  基準の日を指定する
//   pnpm refresh:targets --within 14         開催が近いとみなす日数（既定は30）
//   pnpm refresh:targets --json              JSON で出す
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { FestivalSchema, IsoDateSchema } from "../packages/schema/src";
import { DEFAULT_UPCOMING_WITHIN_DAYS, selectRefreshTargets } from "./festival-refresh";

const DIR = fileURLToPath(new URL("../data/festivals/", import.meta.url));

const REASON_LABELS = {
  request: "依頼",
  expected: "見込みのまま",
  upcoming: "開催が近い",
  stale: "確認日が古い",
} as const;

function todayInJapan(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
}

function main(): number {
  const { values } = parseArgs({
    options: {
      today: { type: "string" },
      within: { type: "string" },
      json: { type: "boolean", default: false },
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
  const targets = selectRefreshTargets(festivals, { today, upcomingWithinDays });

  if (values.json) {
    console.log(JSON.stringify(targets, null, 2));
    return 0;
  }
  for (const target of targets) {
    const reasons = target.reasons.map((reason) => REASON_LABELS[reason]).join("・");
    console.log(`${target.id}（次の開催 ${target.nextDate ?? "未定"}）：${reasons}`);
    for (const note of target.notes) console.log(`  ${note}`);
  }
  console.log(
    `\n祭り ${festivals.length} 件のうち、確かめ直す対象 ${targets.length} 件（基準日 ${today}）`,
  );
  return 0;
}

process.exitCode = main();
