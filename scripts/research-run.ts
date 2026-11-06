// 週次の調査を GitHub Actions から動かす。モデルは呼ばず、Managed Agents の準備と結果の回収だけを行う。
//
//   pnpm research setup                    エージェント・環境・Store・定期実行を作る、更新する
//   pnpm research prepare [--limit 3]      今週の調査リストを Store に置く
//       --issues issues.json               依頼の Issue（gh issue list --json number,body,labels）
//       --under-review ids.txt             確認待ちの PR にある祭りの ID（1行に1つ）
//   pnpm research trigger                  定期実行を待たずに1回起動する
//   pnpm research collect --out dir        終わったセッションの報告を確かめ、変える祭りと PR の本文を dir に書く
//
// 環境変数：
//   ANTHROPIC_FEDERATION_RULE_ID ほか      Workload Identity Federation の設定（SDK が読む）
//   MODEL_RESEARCH_LEAD・MODEL_RESEARCH_WORKER  setup で使うモデル
//   MATSURI_RESEARCH_BUDGET_USD            setup で付ける1回の実行の費用の上限（既定は 30.00）
//   MATSURI_REFRESH_ENABLED                setup で true なら定期実行を動かし、それ以外は止める
//
// ログには件数・費用・ID だけを出し、調べた語やページの中身は出さない。
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import {
  checkPublicWebUrl,
  createWebActivityLog,
  parseJsonWithSchema,
} from "../packages/agent-kit/src";
import {
  type Festival,
  FestivalSchema,
  IsoDateSchema,
  type ResearchLedger,
  ResearchLedgerSchema,
  type ResearchQueue,
  ResearchQueueSchema,
  type ResearchReport,
  ResearchReportSchema,
} from "../packages/schema/src";
import {
  type RefreshIssue,
  type RefreshResult,
  type RejectedRefresh,
  refreshPullRequestBody,
  requestsFromIssues,
} from "./festival-refresh";
import { applyResearchReport, checkQuote } from "./research-report";
import {
  recordResearchResult,
  retireEndedOccurrences,
  selectRefreshTargets,
  serializeResearchLedger,
} from "./research-schedule";
import {
  centsOf,
  leadAgent,
  RESEARCH_ENVIRONMENT,
  RESEARCH_NAMES,
  readerAgent,
  researchBrief,
  researchDeployment,
  reviewerAgent,
} from "./research-team";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FESTIVALS_DIR = join(ROOT, "data/festivals");
const LEDGER_PATH = join(ROOT, "data/research-ledger.json");
const SKILL_DIR = join(ROOT, ".claude/skills/festival-research");
const QUEUE_PATH = "/queue.json";
const TARGETS_PREFIX = "/targets/";
const FILE_BETA = "managed-agents-2026-04-01";
const QUOTE_FETCH_TIMEOUT_MS = 20_000;
const MAX_REPORT_BYTES = 200_000;

function todayInJapan(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
}

function readFestivals(): Festival[] {
  return readdirSync(FESTIVALS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .flatMap((name) => {
      const raw = JSON.parse(readFileSync(join(FESTIVALS_DIR, name), "utf8"));
      const parsed = FestivalSchema.safeParse(raw);
      return parsed.success ? [parsed.data] : [];
    });
}

function readLedger(): ResearchLedger {
  return ResearchLedgerSchema.parse(JSON.parse(readFileSync(LEDGER_PATH, "utf8")));
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`環境変数 ${name} を設定してください`);
  return value;
}

/** 名前で探す。作り直さず更新して、ID を変えないため */
async function findByName<T extends { name: string; archived_at?: string | null }>(
  items: AsyncIterable<T>,
  name: string,
): Promise<T | null> {
  for await (const item of items) {
    if (item.name === name && !item.archived_at) return item;
  }
  return null;
}

// ---------------------------------------------------------------------------
// setup

async function uploadSkill(client: Anthropic): Promise<string> {
  const files = await Promise.all(
    ["SKILL.md", "fields.md"].map((name) =>
      toFile(readFileSync(join(SKILL_DIR, name)), `${RESEARCH_NAMES.skill}/${name}`),
    ),
  );
  for await (const skill of client.beta.skills.list()) {
    if (skill.display_name === RESEARCH_NAMES.skill) {
      await client.beta.skills.versions.create(skill.id, { files });
      return skill.id;
    }
  }
  const skill = await client.beta.skills.create({ display_name: RESEARCH_NAMES.skill, files });
  return skill.id;
}

async function upsertAgent<P extends { name: string }>(client: Anthropic, params: P) {
  const existing = await findByName(client.beta.agents.list(), params.name);
  // 型は SDK が確かめる。定義は as const で持っているので、ここでだけ広げる
  const body = params as unknown as Anthropic.Beta.AgentCreateParams;
  if (existing === null) return client.beta.agents.create(body);
  return client.beta.agents.update(existing.id, { ...body, version: existing.version });
}

async function setup(client: Anthropic): Promise<number> {
  const models = {
    lead: requireEnv("MODEL_RESEARCH_LEAD"),
    worker: requireEnv("MODEL_RESEARCH_WORKER"),
  };
  const budgetCents = centsOf(process.env.MATSURI_RESEARCH_BUDGET_USD || "30.00");
  if (budgetCents === null)
    throw new Error("MATSURI_RESEARCH_BUDGET_USD は 30.00 のように書きます");

  const skillId = await uploadSkill(client);
  const reader = await upsertAgent(client, readerAgent(models.worker, skillId));
  const reviewer = await upsertAgent(client, reviewerAgent(models.worker, skillId));
  const lead = await upsertAgent(client, leadAgent(models.lead, reader.id, reviewer.id));

  const environment =
    (await findByName(client.beta.environments.list(), RESEARCH_ENVIRONMENT.name)) ??
    (await client.beta.environments.create(RESEARCH_ENVIRONMENT));

  const store =
    (await findByName(client.beta.memoryStores.list(), RESEARCH_NAMES.queueStore)) ??
    (await client.beta.memoryStores.create({
      name: RESEARCH_NAMES.queueStore,
      description: "今週の祭りの調査リスト。コードだけが書き、セッションは読むだけ",
    }));

  const params = researchDeployment({
    leadId: lead.id,
    environmentId: environment.id,
    storeId: store.id,
    budgetCents,
  }) as unknown as Anthropic.Beta.DeploymentCreateParams;
  const existing = await findByName(client.beta.deployments.list(), RESEARCH_NAMES.deployment);
  const deployment =
    existing === null
      ? await client.beta.deployments.create(params)
      : await client.beta.deployments.update(existing.id, params);

  // 定期実行は MATSURI_REFRESH_ENABLED が true のときだけ動かす。手での起動は止めていても使える
  const enabled = process.env.MATSURI_REFRESH_ENABLED === "true";
  if (enabled && deployment.status !== "active")
    await client.beta.deployments.unpause(deployment.id);
  if (!enabled && deployment.status === "active")
    await client.beta.deployments.pause(deployment.id);

  console.log(
    JSON.stringify(
      {
        skill: skillId,
        reader: reader.id,
        reviewer: reviewer.id,
        lead: lead.id,
        environment: environment.id,
        store: store.id,
        deployment: deployment.id,
        scheduled: enabled,
        upcomingRunsAt: deployment.schedule?.upcoming_runs_at ?? [],
      },
      null,
      2,
    ),
  );
  return 0;
}

// ---------------------------------------------------------------------------
// prepare

async function requireStore(client: Anthropic) {
  const store = await findByName(client.beta.memoryStores.list(), RESEARCH_NAMES.queueStore);
  if (store === null) throw new Error("Store がありません。先に setup を実行してください");
  return store;
}

async function storeMemories(client: Anthropic, storeId: string) {
  const memories = new Map<string, string>();
  for await (const item of client.beta.memoryStores.memories.list(storeId, { depth: 10 })) {
    if (item.type === "memory") memories.set(item.path, item.id);
  }
  return memories;
}

async function writeQueue(
  client: Anthropic,
  storeId: string,
  queue: ResearchQueue,
  briefs: ReadonlyMap<string, unknown>,
) {
  const memories = await storeMemories(client, storeId);
  const memory = (path: string, content: string) => {
    const id = memories.get(path);
    memories.delete(path);
    return id === undefined
      ? client.beta.memoryStores.memories.create(storeId, { path, content })
      : client.beta.memoryStores.memories.update(id, { memory_store_id: storeId, content });
  };
  for (const [id, brief] of briefs) {
    await memory(`${TARGETS_PREFIX}${id}.json`, JSON.stringify(brief, null, 2));
  }
  // 調査リストは最後に書く。途中で止まっても、前の週のリストの続きにならない
  await memory(QUEUE_PATH, JSON.stringify(queue, null, 2));
  for (const id of memories.values()) {
    await client.beta.memoryStores.memories.delete(id, { memory_store_id: storeId });
  }
}

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

async function prepare(
  client: Anthropic,
  options: { limit?: string; issues?: string; underReview?: string },
): Promise<number> {
  const today = IsoDateSchema.parse(todayInJapan());
  const festivals = readFestivals();
  const { requests } = options.issues
    ? requestsFromIssues(readIssues(options.issues), festivals)
    : { requests: [] };
  const underReview = options.underReview
    ? readFileSync(options.underReview, "utf8").split(/\s+/).filter(Boolean)
    : [];
  const selected = selectRefreshTargets(festivals, {
    today,
    ledger: readLedger(),
    requests,
    underReview,
  });
  const limit = options.limit === undefined ? selected.length : Number(options.limit);
  if (!Number.isInteger(limit) || limit < 0) throw new Error("--limit は0以上の整数です");
  const targets = selected.slice(0, limit);

  const byId = new Map(festivals.map((festival) => [festival.id, festival]));
  const briefs = new Map<string, unknown>();
  for (const target of targets) {
    const festival = byId.get(target.id);
    if (festival !== undefined) briefs.set(target.id, researchBrief(festival, target, today));
  }
  const store = await requireStore(client);
  await writeQueue(
    client,
    store.id,
    {
      preparedOn: today,
      preparedAt: new Date().toISOString(),
      targets: targets.map((target) => ({ id: target.id, occurrenceDate: target.nextDate })),
    },
    briefs,
  );
  console.log(
    `今週の調査リスト：${targets.length} 件（選んだ ${selected.length} 件、基準日 ${today}）`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// trigger

async function requireDeployment(client: Anthropic) {
  const deployment = await findByName(client.beta.deployments.list(), RESEARCH_NAMES.deployment);
  if (deployment === null) throw new Error("定期実行がありません。先に setup を実行してください");
  return deployment;
}

async function trigger(client: Anthropic): Promise<number> {
  const deployment = await requireDeployment(client);
  const run = await client.beta.deployments.run(deployment.id);
  console.log(`起動しました：実行 ${run.id}、セッション ${run.session_id ?? "なし"}`);
  return run.session_id === null ? 1 : 0;
}

// ---------------------------------------------------------------------------
// collect

/** Web の取得の道具で開いた URL を、すべてのスレッドから集める */
async function fetchedUrlsOf(client: Anthropic, sessionId: string): Promise<readonly string[]> {
  const log = createWebActivityLog();
  for await (const thread of client.beta.sessions.threads.list(sessionId)) {
    for await (const event of client.beta.sessions.threads.events.list(thread.id, {
      session_id: sessionId,
    })) {
      if (event.type === "agent.tool_use" && event.name === "web_fetch") {
        log.record("WebFetch", event.input);
      }
    }
  }
  return log.fetchedUrls;
}

/** 報告のファイルを、祭りの ID ごとに読む。形の合わないものは入れない */
async function readReports(client: Anthropic, sessionId: string) {
  const reports = new Map<string, ResearchReport>();
  for await (const file of client.beta.files.list({ scope_id: sessionId, betas: [FILE_BETA] })) {
    const name = /([a-z0-9-]+)\.json$/.exec(file.filename)?.[1];
    if (name === undefined || file.size_bytes > MAX_REPORT_BYTES) continue;
    const response = await client.beta.files.download(file.id, { betas: [FILE_BETA] });
    const parsed = parseJsonWithSchema(await response.text(), ResearchReportSchema, "object");
    if (parsed.ok && parsed.value.festivalId === name) reports.set(name, parsed.value);
  }
  return reports;
}

/** 根拠のページを取り直して、引用が本文にあるかを確かめる。比べられないときは unverifiable */
async function verifyQuotes(report: ResearchReport): Promise<"found" | "missing" | "unverifiable"> {
  let unverifiable = false;
  for (const evidence of report.evidence) {
    const url = checkPublicWebUrl(evidence.url);
    if (!url.ok) return "missing";
    try {
      const response = await fetch(url.url, {
        headers: { "user-agent": "matsuri-ikoka-research" },
        signal: AbortSignal.timeout(QUOTE_FETCH_TIMEOUT_MS),
      });
      const type = response.headers.get("content-type") ?? "";
      if (!response.ok || !/text|html/i.test(type)) {
        unverifiable = true;
        continue;
      }
      const result = checkQuote(await response.text(), evidence.quote);
      if (result === "missing") return "missing";
      if (result === "unverifiable") unverifiable = true;
    } catch {
      unverifiable = true;
    }
  }
  return unverifiable ? "unverifiable" : "found";
}

/** 今の調査リストより後に起動した実行のセッションを探す */
async function latestRunSince(client: Anthropic, deploymentId: string, preparedAt: string) {
  type Run = Anthropic.Beta.BetaManagedAgentsDeploymentRun;
  let latest: Run | null = null;
  for await (const run of client.beta.deploymentRuns.list({ deployment_id: deploymentId })) {
    if (run.created_at < preparedAt) continue;
    if (latest === null || run.created_at > latest.created_at) latest = run;
  }
  return latest;
}

function setOutput(name: string, value: string) {
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, { flag: "a" });
  }
  console.log(`${name}=${value}`);
}

async function collect(client: Anthropic, out: string): Promise<number> {
  setOutput("changed", "false");
  const today = IsoDateSchema.parse(todayInJapan());
  const store = await requireStore(client);
  const memories = await storeMemories(client, store.id);
  const queueId = memories.get(QUEUE_PATH);
  if (queueId === undefined) {
    console.log("調査リストがありません");
    return 0;
  }
  const memory = await client.beta.memoryStores.memories.retrieve(queueId, {
    memory_store_id: store.id,
  });
  const queue = ResearchQueueSchema.parse(JSON.parse(memory.content ?? ""));
  if (queue.targets.length === 0) {
    console.log("回収するものはありません");
    return 0;
  }

  const deployment = await requireDeployment(client);
  const run = await latestRunSince(client, deployment.id, queue.preparedAt);
  if (run === null) {
    console.log("調査はまだ起動していません");
    return 0;
  }
  if (run.session_id === null) {
    console.log(`起動に失敗しました：${run.error?.type ?? "不明"}`);
    return 1;
  }
  const session = await client.beta.sessions.retrieve(run.session_id);
  if (session.status === "running" || session.status === "rescheduling") {
    console.log("調査はまだ動いています。次の回収で確かめます");
    return 0;
  }

  const festivals = new Map(readFestivals().map((festival) => [festival.id, festival]));
  const reports = await readReports(client, session.id);
  const fetchedUrls = await fetchedUrlsOf(client, session.id);

  let ledger = retireEndedOccurrences([...festivals.values()], readLedger(), today);
  const results: RefreshResult[] = [];
  const rejected: RejectedRefresh[] = [];
  const unverified: string[] = [];
  const counts = { found: 0, not_found: 0, failed: 0 };
  mkdirSync(join(out, "festivals"), { recursive: true });

  for (const target of queue.targets) {
    const before = festivals.get(target.id);
    if (before === undefined) continue;
    const report = reports.get(target.id);
    let result: "found" | "not_found" | "failed" = "failed";
    if (report === undefined) {
      rejected.push({ id: target.id, reason: "報告がなかった" });
    } else if (report.occurrenceDate !== target.occurrenceDate) {
      rejected.push({ id: target.id, reason: "別の開催回の報告" });
    } else if (report.outcome === "not_found") {
      result = "not_found";
    } else {
      const check = applyResearchReport({
        before,
        report,
        occurrenceDate: target.occurrenceDate,
        today,
        fetchedUrls,
      });
      const quotes = check.ok ? await verifyQuotes(report) : null;
      if (!check.ok) {
        rejected.push({ id: target.id, reason: check.reason });
      } else if (quotes === "missing") {
        rejected.push({ id: target.id, reason: "引用が根拠のページに見つからない" });
      } else {
        if (quotes === "unverifiable") unverified.push(target.id);
        results.push({ before, after: check.after });
        writeFileSync(
          join(out, "festivals", `${target.id}.json`),
          `${JSON.stringify(check.after, null, 2)}\n`,
        );
        result = "found";
      }
    }
    counts[result] += 1;
    ledger = recordResearchResult(ledger, {
      festivalId: target.id,
      occurrenceDate: target.occurrenceDate,
      result,
      today,
    });
  }

  writeFileSync(join(out, "research-ledger.json"), serializeResearchLedger(ledger));
  const note =
    unverified.length > 0
      ? `\n\n### 引用を機械で照合できなかった祭り\n\nページが PDF やスクリプトで描かれているなどの理由です。根拠のページを開いて確かめてください。\n\n${unverified.map((id) => `- ${id}`).join("\n")}\n`
      : "";
  writeFileSync(join(out, "body.md"), `${refreshPullRequestBody(results, rejected)}${note}`);

  // 同じ結果を二重に回収せず、次の週まで古いリストを調べ直さないよう、リストを空にする
  await client.beta.memoryStores.memories.update(queueId, {
    memory_store_id: store.id,
    content: JSON.stringify({ ...queue, targets: [] }, null, 2),
  });

  setOutput("changed", "true");
  setOutput("review", results.length > 0 || rejected.length > 0 ? "human" : "auto");
  console.log(
    `調べた祭り ${queue.targets.length} 件（見つかった ${counts.found}、見つからない ${counts.not_found}、失敗 ${counts.failed}）、費用 $${(Number(session.usage?.list_cost?.amount ?? 0) / 100).toFixed(2)}`,
  );
  return 0;
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      limit: { type: "string" },
      issues: { type: "string" },
      "under-review": { type: "string" },
      out: { type: "string" },
    },
  });
  const client = new Anthropic();
  switch (positionals[0]) {
    case "setup":
      return setup(client);
    case "prepare":
      return prepare(client, {
        ...(values.limit === undefined ? {} : { limit: values.limit }),
        ...(values.issues === undefined ? {} : { issues: values.issues }),
        ...(values["under-review"] === undefined ? {} : { underReview: values["under-review"] }),
      });
    case "trigger":
      return trigger(client);
    case "collect":
      if (values.out === undefined) throw new Error("--out を指定してください");
      return collect(client, values.out);
    default:
      console.error("setup・prepare・trigger・collect のどれかを指定してください");
      return 1;
  }
}

process.exitCode = await main();
