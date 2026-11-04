import { existsSync } from "node:fs";
import path from "node:path";
import { deleteSession, query } from "@anthropic-ai/claude-agent-sdk";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createAccount, readAccountConfig } from "./account/firebase";
import { ClaudeAgentRunner } from "./agent/claudeRunner";
import { agentEnv, createAgentWorkdir } from "./agent/options";
import { loadPrompts } from "./agent/prompts";
import { loadSampleConversations, ReplayAgentRunner } from "./agent/replayRunner";
import type { AgentRunner } from "./agent/runner";
import { agentConfigDir, forgetTranscripts } from "./agent/transcripts";
import { createWebVerifier } from "./agent/webVerifier";
import { createApp } from "./app";
import { readConfig, startupNotice } from "./config";
import { festivalDirs, loadFestivals } from "./data/festivalStore";
import { nowInJapan, todayInJapan } from "./domain/calendar";
import { ConcurrencyLimiter, clientIp, DailyLimiter } from "./routes/guard";
import { StoragePersistence } from "./session/persistence";
import { ItineraryStore, SessionStore } from "./session/sessionStore";
import { createCandidateChecker } from "./tools/candidateCheck";
import { createLodgingService } from "./tools/lodging";
import { createJmaWeather } from "./tools/weather";

// 待たれていない Promise の失敗で、サーバーごと止めない。止まると、返答の途中の接続がすべて切れる
process.on("unhandledRejection", (reason) => {
  console.error("[process] 待たれていない Promise が失敗しました", reason);
});

const config = readConfig(process.env);
const account = await createAccount(readAccountConfig(process.env));
console.info(
  JSON.stringify({ kind: "account", storage: account.storage.kind, login: account.web.enabled }),
);
if (config.production && account.storage.kind === "memory") {
  console.warn("[storage] 保存先がメモリです。再起動で旅程と共有のしおりが消えます");
}
const today = () => todayInJapan();

const dirs = await festivalDirs({
  repoRoot: config.repoRoot,
  mode: config.mode,
  configured: config.festivalsDir,
  production: config.production,
});
const festivals = await loadFestivals(dirs);
console.info(
  JSON.stringify({
    kind: "festivals_loaded",
    dirs: dirs.map((dir) => path.relative(config.repoRoot, dir) || "."),
    festivals: festivals.store.size,
    optedOut: festivals.optedOut,
    skipped: festivals.issues.length,
  }),
);
for (const issue of festivals.issues) {
  console.warn(`[festivals] ${path.basename(issue.file)}: ${issue.message}`);
}

const itineraries = new ItineraryStore();
let runner: AgentRunner;
let sampleIds: string[] = [];
let sessions = new SessionStore();
if (config.mode === "live") {
  const prompts = await loadPrompts();
  const cwd = createAgentWorkdir();
  // API キーで動かすときは、会話の記録の置き場所を一時ディレクトリにし、終了時に消す
  const configDir = agentConfigDir(process.env);
  if (configDir.dir !== null) {
    process.env.CLAUDE_CONFIG_DIR = configDir.dir;
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        configDir.cleanup();
        process.exit(0);
      });
    }
  }
  // 相談が消えたら、その相談の会話の記録を消す
  sessions = new SessionStore({ onRemove: forgetTranscripts(deleteSession, cwd) });
  const env = agentEnv(process.env);
  runner = new ClaudeAgentRunner({
    festivals: festivals.store,
    itineraries,
    weather: createJmaWeather(),
    lodging: createLodgingService(process.env, {
      production: config.production,
      now: () => nowInJapan(),
    }),
    verifier: createWebVerifier({
      prompt: prompts.verifier,
      model: config.models.verifier,
      cwd,
      env,
      query,
      maxBudgetUsd: config.maxBudgetUsd,
    }),
    // 候補を出す前の確かめは3件ずつ動くので、スタッフのモデルで行う
    candidateChecks: createCandidateChecker({
      verifier: createWebVerifier({
        prompt: prompts.verifier,
        model: config.models.staff,
        cwd,
        env,
        query,
        maxBudgetUsd: config.maxBudgetUsd,
      }),
      today,
      now: () => nowInJapan(),
    }),
    prompts,
    models: config.models,
    maxBudgetUsd: config.maxBudgetUsd,
    cwd,
    env,
    today,
    now: () => nowInJapan(),
    query,
  });
} else {
  const samples = await loadSampleConversations(
    path.join(config.repoRoot, "data", "samples", "conversations"),
  );
  sampleIds = samples.map((sample) => sample.id);
  runner = new ReplayAgentRunner(samples, itineraries, { speed: config.replaySpeed });
}

// 旅程の版と相談の途中の状態を、保存の口に残す
const persistence = new StoragePersistence({ storage: account.storage, itineraries, sessions });

const app = createApp({
  runner,
  sessions,
  itineraries,
  persistence,
  verifier: account.verifier,
  authConfig: account.web,
  festivals: festivals.store,
  limiter: new DailyLimiter(config.dailyChatLimit, today),
  ipLimiter: new DailyLimiter(config.dailyChatLimitPerIp, today),
  concurrency: new ConcurrencyLimiter(config.maxConcurrentTurns),
  clientIp: (c) => {
    let remote: string | undefined;
    try {
      remote = getConnInfo(c).remote.address;
    } catch {
      remote = undefined;
    }
    return clientIp(c.req.header("x-forwarded-for"), remote, config.trustedProxyHops);
  },
  accessPasscode: config.accessPasscode,
  webDist: config.webDist,
});
if (config.webDist !== null && !existsSync(path.join(config.webDist, "index.html"))) {
  console.warn(`[web] 画面のビルドがありません：${config.webDist}（先に pnpm build）`);
}

// 使われなくなった相談と、期限を過ぎた旅程を、10分ごとに片付ける
setInterval(
  () => {
    sessions.sweep();
    itineraries.sweep();
  },
  10 * 60 * 1000,
).unref();

serve({ fetch: app.fetch, port: config.port }, (info) => {
  const notice = startupNotice({
    mode: config.mode,
    port: info.port,
    festivals: festivals.store.size,
    festivalDirs: dirs.map((dir) => path.relative(config.repoRoot, dir) || "."),
    samples: sampleIds,
  });
  console.info(JSON.stringify(notice.log));
  console.info(`server listening on http://localhost:${info.port} (${config.mode})`);
  // mock のままだと、何を相談しても同じ見本が流れる。気づけるように目立つ出力にする
  (config.mode === "mock" ? console.warn : console.info)(notice.message);
});
