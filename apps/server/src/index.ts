import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { serve } from "@hono/node-server";
import { ClaudeAgentRunner } from "./agent/claudeRunner";
import { agentEnv, createAgentWorkdir } from "./agent/options";
import { loadPrompts } from "./agent/prompts";
import { loadSampleConversations, ReplayAgentRunner } from "./agent/replayRunner";
import type { AgentRunner } from "./agent/runner";
import { createWebVerifier } from "./agent/webVerifier";
import { createApp } from "./app";
import { readConfig } from "./config";
import { festivalDirs, loadFestivals } from "./data/festivalStore";
import { nowInJapan, todayInJapan } from "./domain/calendar";
import { DailyLimiter } from "./routes/guard";
import { ItineraryStore, SessionStore } from "./session/sessionStore";
import { createJmaWeather } from "./tools/weather";

const config = readConfig(process.env);
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
if (config.mode === "live") {
  const prompts = await loadPrompts();
  const cwd = createAgentWorkdir();
  const env = agentEnv(process.env);
  runner = new ClaudeAgentRunner({
    festivals: festivals.store,
    itineraries,
    weather: createJmaWeather(),
    verifier: createWebVerifier({
      prompt: prompts.verifier,
      model: config.models.staff,
      cwd,
      env,
      query,
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
  runner = new ReplayAgentRunner(samples, itineraries, { speed: config.replaySpeed });
}

const app = createApp({
  runner,
  sessions: new SessionStore(),
  itineraries,
  festivals: festivals.store,
  limiter: new DailyLimiter(config.dailyChatLimit, today),
  accessPasscode: config.accessPasscode,
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.info(`server listening on http://localhost:${info.port} (${config.mode})`);
});
