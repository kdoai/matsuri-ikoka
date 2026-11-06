// 確かめ直す祭りごとに Claude Managed Agents のセッションを起動し、返ってきた JSON を確かめる。
// 既定は空実行（対象と頼みの文の長さを一覧にするだけで、API は呼ばない）。
//
//   pnpm refresh:run                          空実行
//   pnpm refresh:run --run                    調査する（下の環境変数が要る）
//   pnpm refresh:run --run --limit 3          調べる祭りの数の上限（既定は5。先頭から調べる）
//   pnpm refresh:run --run --max-cost 2.00    1つのセッションの費用の上限（米ドル、既定は2.00）
//   pnpm refresh:run --run --write            取り込める結果を data/festivals/ に書く
//   pnpm refresh:run --run --body body.md     PR の本文を書き出す
//   pnpm refresh:run --issues issues.json     依頼の Issue を足す（refresh:targets と同じ）
//
// 環境変数（--run のとき）：
//   MATSURI_REFRESH_AGENT_ID        調査のエージェントの ID（モデルとWeb の道具はエージェントの側で決める）
//   MATSURI_REFRESH_ENVIRONMENT_ID  セッションを動かす環境の ID
//   API の資格情報は SDK が環境から読む（確かめ直し専用のキーを使う）
//
// エージェントには GitHub の権限を渡さない。ファイルの書き込みと PR は、このスクリプトを呼ぶ側が行う。
// 実行のログには件数・費用・所要時間だけを出し、調べた語やページの中身は出さない。
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import {
  type Festival,
  FestivalSchema,
  IsoDateSchema,
  ResearchLedgerSchema,
} from "../packages/schema/src";
import {
  type IssueRequests,
  type RefreshIssue,
  type RefreshResult,
  type RejectedRefresh,
  refreshPullRequestBody,
  requestsFromIssues,
} from "./festival-refresh";
import {
  checkRefreshOutput,
  type GuideFile,
  refreshPrompt,
  type ToolCall,
} from "./festival-refresh-agent";
import { type RefreshTarget, selectRefreshTargets } from "./research-schedule";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIR = join(ROOT, "data/festivals");
const LEDGER_PATH = join(ROOT, "data/research-ledger.json");

/** 調査の決まりとして渡す文書。.claude/ のほかのスキル・エージェント・フックや CLAUDE.md は渡さない */
const GUIDE_PATHS = [
  ".claude/skills/festival-research/SKILL.md",
  ".claude/skills/festival-research/fields.md",
  "packages/schema/src/common.ts",
  "packages/schema/src/festival.ts",
];

const DEFAULT_LIMIT = 5;
const DEFAULT_MAX_COST_USD = "2.00";
/** 1つのセッションを待つ上限。費用の上限とは別に、止まらないセッションを打ち切る */
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

interface SessionOutcome {
  text: string;
  toolCalls: ToolCall[];
  stop: string;
}

function todayInJapan(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
}

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

/** 米ドルの金額（"2.00"）を、セント単位の整数の文字列にする */
function centsOf(usd: string): string | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(usd);
  if (match === null) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return cents > 0 ? String(cents) : null;
}

/**
 * セッションに頼みの文を送り、止まるまでの返答と道具の記録を集める。
 * 人の判断を待つ道具の呼び出しは、見ている人がいないので断る
 */
async function runSession(
  client: Anthropic,
  sessionId: string,
  prompt: string,
): Promise<SessionOutcome> {
  const outcome: SessionOutcome = { text: "", toolCalls: [], stop: "stream_closed" };
  // 先にストリームを開いてから送る（開く前の出来事は届かない）
  const stream = await client.beta.sessions.events.stream(sessionId);
  const timer = setTimeout(() => {
    outcome.stop = "timeout";
    stream.controller.abort();
  }, SESSION_TIMEOUT_MS);
  try {
    await client.beta.sessions.events.send(sessionId, {
      events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }],
    });
    for await (const event of stream) {
      if (event.type === "agent.message") {
        const text = event.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("");
        // JSON は最後の返答で出すよう頼んでいるので、文のある最後の返答だけを使う
        if (text.trim() !== "") outcome.text = text;
      } else if (event.type === "agent.tool_use") {
        outcome.toolCalls.push({ name: event.name, input: event.input });
        if (event.evaluated_permission === "ask") {
          await client.beta.sessions.events.send(sessionId, {
            events: [{ type: "user.tool_confirmation", tool_use_id: event.id, result: "deny" }],
          });
        }
      } else if (event.type === "agent.mcp_tool_use" && event.evaluated_permission === "ask") {
        await client.beta.sessions.events.send(sessionId, {
          events: [{ type: "user.tool_confirmation", tool_use_id: event.id, result: "deny" }],
        });
      } else if (event.type === "session.status_idle") {
        if (event.stop_reason.type !== "requires_action") {
          outcome.stop = event.stop_reason.type;
          break;
        }
      } else if (event.type === "session.status_terminated") {
        outcome.stop = "terminated";
        break;
      }
    }
  } catch (error) {
    if (outcome.stop !== "timeout") throw error;
  } finally {
    clearTimeout(timer);
  }
  return outcome;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      today: { type: "string" },
      issues: { type: "string" },
      limit: { type: "string" },
      "max-cost": { type: "string" },
      run: { type: "boolean", default: false },
      write: { type: "boolean", default: false },
      body: { type: "string" },
    },
  });
  const today = IsoDateSchema.parse(values.today ?? todayInJapan());
  const limit = Number(values.limit ?? DEFAULT_LIMIT);
  const maxCostCents = centsOf(values["max-cost"] ?? DEFAULT_MAX_COST_USD);
  if (!Number.isInteger(limit) || limit < 1) {
    console.error("--limit には1以上の整数を指定してください");
    return 1;
  }
  if (maxCostCents === null) {
    console.error("--max-cost には 2.00 のような米ドルの金額を指定してください");
    return 1;
  }

  const festivals = new Map<string, Festival>();
  for (const name of readdirSync(DIR)
    .filter((n) => n.endsWith(".json"))
    .sort()) {
    const parsed = FestivalSchema.safeParse(JSON.parse(readFileSync(join(DIR, name), "utf8")));
    if (parsed.success) festivals.set(parsed.data.id, parsed.data);
  }
  const { requests }: IssueRequests = values.issues
    ? requestsFromIssues(readIssues(values.issues), [...festivals.values()])
    : { requests: [], unresolved: [] };
  const targets: RefreshTarget[] = selectRefreshTargets([...festivals.values()], {
    today,
    ledger: ResearchLedgerSchema.parse(JSON.parse(readFileSync(LEDGER_PATH, "utf8"))),
    requests,
  }).slice(0, limit);
  const guides: GuideFile[] = GUIDE_PATHS.map((path) => ({
    path,
    content: readFileSync(join(ROOT, path), "utf8"),
  }));

  if (!values.run) {
    for (const target of targets) {
      const festival = festivals.get(target.id);
      if (festival === undefined) continue;
      const prompt = refreshPrompt({ target, festival, today, guides });
      console.log(`${target.id}：${target.reasons.join("・")}（頼みの文 ${prompt.length} 文字）`);
    }
    console.log(`\n空実行：調べる祭り ${targets.length} 件（上限 ${limit} 件、基準日 ${today}）`);
    return 0;
  }

  const agentId = process.env.MATSURI_REFRESH_AGENT_ID;
  const environmentId = process.env.MATSURI_REFRESH_ENVIRONMENT_ID;
  if (!agentId || !environmentId) {
    console.error("MATSURI_REFRESH_AGENT_ID と MATSURI_REFRESH_ENVIRONMENT_ID を設定してください");
    return 1;
  }

  const client = new Anthropic();
  const results: RefreshResult[] = [];
  const rejected: RejectedRefresh[] = [];
  let totalCents = 0;
  const started = Date.now();
  for (const target of targets) {
    const before = festivals.get(target.id);
    if (before === undefined) continue;
    const sessionStarted = Date.now();
    const session = await client.beta.sessions.create({
      agent: agentId,
      environment_id: environmentId,
      title: `refresh ${target.id}`,
      budget: { type: "limit", max_list_cost: { amount: maxCostCents, currency: "USD" } },
    });
    let outcome: SessionOutcome;
    try {
      outcome = await runSession(
        client,
        session.id,
        refreshPrompt({ target, festival: before, today, guides }),
      );
    } catch (error) {
      rejected.push({ id: target.id, reason: `セッションが失敗した（${(error as Error).name}）` });
      continue;
    }
    const usage = (await client.beta.sessions.retrieve(session.id)).usage;
    const cents = Number(usage.list_cost?.amount ?? 0);
    totalCents += cents;
    console.log(
      `${target.id}：止まった理由 ${outcome.stop}、費用 $${(cents / 100).toFixed(2)}、${Math.round((Date.now() - sessionStarted) / 1000)} 秒`,
    );

    if (outcome.stop !== "end_turn") {
      rejected.push({ id: target.id, reason: `調査が最後まで進まなかった（${outcome.stop}）` });
      continue;
    }
    const check = checkRefreshOutput({
      before,
      text: outcome.text,
      toolCalls: outcome.toolCalls,
      today,
    });
    if (!check.ok) {
      rejected.push(check.rejected);
      continue;
    }
    results.push(check.result);
    if (values.write) {
      writeFileSync(
        join(DIR, `${check.result.after.id}.json`),
        `${JSON.stringify(check.result.after, null, 2)}\n`,
      );
    }
  }

  const body = refreshPullRequestBody(results, rejected);
  if (values.body) writeFileSync(values.body, body);
  else console.log(`\n${body}`);
  console.log(
    `調べた祭り ${targets.length} 件（取り込める ${results.length} 件、取り込まない ${rejected.length} 件）、費用 $${(totalCents / 100).toFixed(2)}、${Math.round((Date.now() - started) / 1000)} 秒`,
  );
  return 0;
}

process.exitCode = await main();
