import { existsSync } from "node:fs";
import path from "node:path";
import { deleteSession, query } from "@anthropic-ai/claude-agent-sdk";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createAccount, readAccountConfig } from "./account/firebase";
import { createInternalVerifiers, readInternalAuthConfig } from "./account/internalAuth";
import { ClaudeAgentRunner } from "./agent/claudeRunner";
import { createFestivalWishReader } from "./agent/festivalWishReader";
import { agentEnv, createAgentWorkdir } from "./agent/options";
import { createPlanEvaluator } from "./agent/planEvaluator";
import { loadPrompts } from "./agent/prompts";
import { loadSampleConversations, ReplayAgentRunner } from "./agent/replayRunner";
import { createRobotsChecker } from "./agent/robots";
import type { AgentRunner } from "./agent/runner";
import { agentConfigDir, forgetTranscript, forgetTranscripts } from "./agent/transcripts";
import { createWebGuideResearcher } from "./agent/webGuideResearcher";
import { createWebLodgingResearcher } from "./agent/webLodgingResearcher";
import { createWebNearbyResearcher } from "./agent/webNearbyResearcher";
import { createWebRouteResearcher } from "./agent/webRouteResearcher";
import { createWebVerifier } from "./agent/webVerifier";
import { type AppDeps, createApp } from "./app";
import { missingRecommendedConfig, portInUseMessage, readConfig, startupNotice } from "./config";
import { festivalDirs, loadFestivals } from "./data/festivalStore";
import { loadOsmPlaces } from "./data/osmPlaces";
import { loadStationPoints } from "./data/stationPoints";
import { nowInJapan, todayInJapan } from "./domain/calendar";
import { ClaudeGuideRunner } from "./guide/claudeRunner";
import { loadSampleGuides, ReplayGuideRunner } from "./guide/replayRunner";
import type { GuideRunner } from "./guide/runner";
import { errorForLog } from "./log";
import { createPatrolDeps } from "./patrol";
import type { PatrolDeps } from "./patrol/runner";
import type { FestivalWishReader } from "./routes/festivalSearch";
import { ConcurrencyLimiter, clientIp, DailyLimiter } from "./routes/guard";
import { StoragePersistence } from "./session/persistence";
import { ItineraryStore, SessionStore } from "./session/sessionStore";
import { createCandidateChecker } from "./tools/candidateCheck";
import { createLodgingService } from "./tools/lodging";
import { createJmaWeather } from "./tools/weather";

// 待たれていない Promise の失敗で、サーバーごと止めない。止まると、返答の途中の接続がすべて切れる
process.on("unhandledRejection", (reason) => {
  console.error(JSON.stringify({ kind: "unhandled_rejection", ...errorForLog(reason) }));
});

const config = readConfig(process.env);
// 欠けていても起動はするが、黙って効かなくなる設定を、名前だけ知らせる
const missingConfig = missingRecommendedConfig(config, process.env);
if (missingConfig.length > 0) {
  console.warn(JSON.stringify({ kind: "config_missing", missing: missingConfig }));
}
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
const stations = await loadStationPoints(config.repoRoot);
// モックと CI ではつながず、自由記述は言葉の辞書で読む
let readFestivalWish: FestivalWishReader | undefined;
// ガイドは、モデルの設定（MODEL_GUIDE）がなければ動かさない。入口だけが断り、今の相談は動く
let guideRunner: GuideRunner | undefined;
// 見回りは、live で鍵（PATROL_ANTHROPIC_API_KEY）があるときだけ動かす。なければ入口だけが断り、今の相談はそのまま動く
let patrol: PatrolDeps | null = null;
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
  readFestivalWish = createFestivalWishReader({
    prompt: prompts["wish-reader"],
    model: config.models.wishReader,
    cwd,
    env,
    query,
    maxBudgetUsd: config.maxBudgetUsd,
  });
  const robots = createRobotsChecker();
  const osmPlaces = await loadOsmPlaces(config.repoRoot);
  // 店内の相談とガイドで分け合う部品
  const weather = createJmaWeather();
  const lodging = createLodgingService(process.env, {
    production: config.production,
    now: () => nowInJapan(),
  });
  // 組み立てに失敗しても、サーバーと相談は止めない
  patrol = await createPatrolDeps({
    env: process.env,
    festivals: festivals.store,
    lodging,
  }).catch((error: unknown) => {
    console.error(JSON.stringify({ kind: "patrol_setup_failed", ...errorForLog(error) }));
    return null;
  });
  const verifier = createWebVerifier({
    prompt: prompts.verifier,
    model: config.models.verifier,
    cwd,
    env,
    query,
    maxBudgetUsd: config.maxBudgetUsd,
  });
  // 旅程の評価は、旅程係が保存するたびに update_itinerary の中で動く。足りないところを見抜く力が要るので、
  // 評価係のモデル（MODEL_EVALUATOR、省略時は旅程係のモデル）で行う
  const planEvaluator = createPlanEvaluator({
    prompt: prompts.evaluator,
    model: config.models.evaluator,
    cwd,
    env,
    query,
    maxBudgetUsd: config.maxBudgetUsd,
  });
  // 行き方の調べは旅程係の中で行きと帰りの2回動くので、スタッフのモデルで行う
  const routes = createWebRouteResearcher({
    prompt: prompts.route,
    model: config.models.staff,
    cwd,
    env,
    query,
    maxBudgetUsd: config.maxBudgetUsd,
  });
  // 寄り道の調べは周辺係・旅程係の search_nearby の中で動くので、スタッフのモデルで行う
  const nearby = createWebNearbyResearcher({
    robots,
    prompt: prompts.nearby,
    model: config.models.staff,
    cwd,
    env,
    query,
    maxBudgetUsd: config.maxBudgetUsd,
  });
  if (config.models.guide !== undefined) {
    guideRunner = new ClaudeGuideRunner({
      prompt: prompts.guide,
      model: config.models.guide,
      festivals: festivals.store,
      itineraries,
      weather,
      lodging,
      verifier,
      stations: stations ?? undefined,
      routes,
      nearby,
      osmPlaces: osmPlaces ?? undefined,
      planEvaluator,
      // Web を読むのはこの調べ役だけ。ガイドの質問だけを受け取り、利用者の情報を持たない
      researcher: createWebGuideResearcher({
        robots,
        prompt: prompts["guide-research"],
        model: config.models.staff,
        cwd,
        env,
        query,
        maxBudgetUsd: config.maxBudgetUsd,
      }),
      maxBudgetUsd: config.maxBudgetUsd,
      cwd,
      env,
      today,
      now: () => nowInJapan(),
      query,
      forgetTranscript: forgetTranscript(deleteSession, cwd),
    });
  }
  runner = new ClaudeAgentRunner({
    ...(stations ? { stations } : {}),
    planEvaluator,
    routes,
    nearby,
    // 店と宿の一覧は、OpenStreetMap から作った手元のデータで引く（docs/adr/0010-place-data-sources.md）
    ...(osmPlaces ? { osmPlaces } : {}),
    // 宿の調べは旅程係の search_lodging の中で観点ごとに並べて動くので、スタッフのモデルで行う
    lodgingResearch: createWebLodgingResearcher({
      robots,
      prompt: prompts.lodging,
      model: config.models.staff,
      cwd,
      env,
      query,
      maxBudgetUsd: config.maxBudgetUsd,
    }),
    festivals: festivals.store,
    itineraries,
    weather,
    lodging,
    verifier,
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
  guideRunner = new ReplayGuideRunner(
    await loadSampleGuides(path.join(config.repoRoot, "data", "samples", "guide")),
    { speed: config.replaySpeed },
  );
}

// 旅程の版と相談の途中の状態を、保存の口に残す
const persistence = new StoragePersistence({ storage: account.storage, itineraries, sessions });

const guide: AppDeps["guide"] =
  guideRunner === undefined ? undefined : { runner: guideRunner, limits: config.guideLimits };
console.info(JSON.stringify({ kind: "guide", available: guide !== undefined }));
console.info(JSON.stringify({ kind: "patrol", available: patrol !== null }));

const app = createApp({
  ...(guide === undefined ? {} : { guide }),
  patrol,
  runner,
  sessions,
  itineraries,
  persistence,
  verifier: account.verifier,
  authConfig: account.web,
  internal: createInternalVerifiers(readInternalAuthConfig(process.env)),
  festivals: festivals.store,
  ...(stations ? { stations } : {}),
  ...(readFestivalWish ? { readFestivalWish } : {}),
  limiter: new DailyLimiter(config.dailyChatLimit, today),
  clientLimiter: new DailyLimiter(config.dailyChatLimitPerIp, today),
  trialLimiter: new DailyLimiter(config.dailyTrialChatLimit, today),
  concurrency: new ConcurrencyLimiter(
    config.maxConcurrentTurns,
    config.maxConcurrentTurnsPerClient,
  ),
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

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
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
// ポートがふさがっていたら、長いスタックトレースではなく、何をすればよいかを出して止まる
server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EADDRINUSE") throw error;
  console.error(portInUseMessage(config.port));
  process.exit(1);
});
