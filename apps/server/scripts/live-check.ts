// live の確認：相談を Agent SDK で実際に流し、段階ごとに OK / NG を出す。最後に、かかった時間と費用の合計を出す。
//
//   pnpm --filter @matsuri-ikoka/server check:live               # 祭りの候補まで
//   pnpm --filter @matsuri-ikoka/server check:live -- --itinerary # 旅程の保存まで
//   pnpm --filter @matsuri-ikoka/server check:live -- --shiori    # 決定・再確認・しおり（HTML と PDF）まで
//
// 認証は Agent SDK に任せる（ANTHROPIC_API_KEY か、ログイン済みの Claude Code の資格情報）。
// 祭りは data/samples/festivals の架空の祭りだけを使い、開催日を今日より先にずらした写しを一時フォルダに作る。
// 架空の祭りは Web で確かめられないので、確定前の再確認は、データの公式の出典を読んだとみなす代わりの口で行う。
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deleteSession, query } from "@anthropic-ai/claude-agent-sdk";
import {
  DEFAULT_PREFERENCES,
  decodeSseEvent,
  type FestivalInput,
  FestivalSchema,
  type SseEvent,
} from "@matsuri-ikoka/schema";
import { ClaudeAgentRunner } from "../src/agent/claudeRunner";
import { agentEnv, createAgentWorkdir } from "../src/agent/options";
import { loadPrompts } from "../src/agent/prompts";
import { createWebVerifier } from "../src/agent/webVerifier";
import { createApp } from "../src/app";
import { findRepoRoot, readConfig } from "../src/config";
import { loadFestivals } from "../src/data/festivalStore";
import {
  addDays,
  daysBetween,
  formatMonthDay,
  nowInJapan,
  todayInJapan,
} from "../src/domain/calendar";
import { occurrenceOn } from "../src/domain/planCheck";
import { DailyLimiter } from "../src/routes/guard";
import { ItineraryStore, SessionStore } from "../src/session/sessionStore";
import { createCandidateChecker } from "../src/tools/candidateCheck";
import { createLodgingService } from "../src/tools/lodging";
import type { FestivalVerifier } from "../src/tools/verifier";
import { createJmaWeather } from "../src/tools/weather";

// 発言を引数で渡すと、その発言を順に流し、段階ごと（候補・旅程の保存・再確認・しおり）に確かめる。
//   check:live -- --festivals <フォルダ> --say "<発言1>" --say "<発言2>" --say "この旅程で決定します。"
// --festivals を渡すと、その祭りのデータを開催日をずらさずに使い、候補の確かめと再確認は Web で行う。
// 発言を渡したときは、しおりまでを確かめる（--itinerary なら旅程の保存まで）。--no-pdf で PDF を取らない。
function argValues(name: string): string[] {
  const values: string[] = [];
  process.argv.forEach((arg, index) => {
    const value = process.argv[index + 1];
    if (arg === name && value !== undefined) values.push(value);
  });
  return values;
}

const realFestivalsDir = argValues("--festivals")[0];
const messages = argValues("--say");
/** どの段階まで確かめるか */
const target: "candidates" | "itinerary" | "shiori" = process.argv.includes("--itinerary")
  ? "itinerary"
  : process.argv.includes("--shiori") || messages.length > 0
    ? "shiori"
    : "candidates";
const withPdf = !process.argv.includes("--no-pdf");
const repoRoot = findRepoRoot(process.cwd());
const config = readConfig(process.env, process.cwd());
const today = todayInJapan();
/** 主役の架空の祭りを開く日（今日の2週間後） */
const festivalDay = addDays(today, 14);

/** 架空の祭りの写しを、開催日を今日より先にずらして一時フォルダに作る */
async function shiftedFictionalFestivals(dir: string) {
  const source = path.join(repoRoot, "data", "samples", "festivals");
  const files = (await readdir(source)).filter((name) => name.endsWith(".json"));
  const original = JSON.parse(
    await readFile(path.join(source, "suzunari-toro.json"), "utf8"),
  ) as FestivalInput;
  const shift = daysBetween(original.occurrences[0]?.date ?? today, festivalDay);
  for (const name of files) {
    const festival = JSON.parse(await readFile(path.join(source, name), "utf8")) as FestivalInput;
    festival.occurrences = festival.occurrences.map((o) => ({
      ...o,
      date: addDays(o.date, shift),
      ...(o.endDate ? { endDate: addDays(o.endDate, shift) } : {}),
    }));
    await writeFile(path.join(dir, name), JSON.stringify(FestivalSchema.parse(festival)));
  }
}

async function readSse(res: Response, onEvent: (event: SseEvent) => void) {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("SSE の本文がありません");
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf("\n\n");
    while (end >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const lines = block.split("\n");
      const name = lines
        .find((l) => l.startsWith("event:"))
        ?.slice(6)
        .trim();
      const data = lines
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (name) onEvent(decodeSseEvent({ event: name, data }));
      end = buffer.indexOf("\n\n");
    }
  }
}

function describe(event: SseEvent): string {
  switch (event.type) {
    case "staff.start":
      return `staff.start  ${event.data.staff}「${event.data.bubble}」`;
    case "tool.start":
      return `tool.start   ${event.data.staff} ${event.data.tool}「${event.data.bubble}」`;
    case "tool.end":
      return `tool.end     ${event.data.staff} ${event.data.tool} ok=${event.data.ok}「${event.data.bubble}」${
        event.data.candidates
          ? ` 候補=${event.data.candidates
              .map(
                (c) =>
                  `${c.festivalId}(${c.date} ${c.daysFromWish >= 0 ? "+" : ""}${c.daysFromWish} ${c.confidence}${c.confirmed ? "" : " 未確認"})`,
              )
              .join(",")}`
          : ""
      }`;
    case "festival.verified":
      return `festival.verified ${event.data.scope ?? "itinerary"} ${event.data.festivalId} ${event.data.date ?? ""} ${event.data.result} 出典=${event.data.sources.map((s) => `${s.url}(${s.confidence})`).join(",")}${event.data.note ? `「${event.data.note}」` : ""}`;
    case "itinerary.updated":
      return `itinerary.updated 第${event.data.itinerary.version}版 ${event.data.itinerary.days.length}日 予定${event.data.itinerary.days.reduce((n, d) => n + d.items.length, 0)}件 追加=${event.data.diff.added.length}`;
    case "message.delta":
      return `message.delta 「${event.data.text}」`;
    case "error":
      return `error ${event.data.code}「${event.data.message}」`;
    case "done":
      return `done stage=${event.data.stage} conditions=${JSON.stringify(event.data.conditions)}`;
  }
}

/**
 * 架空の祭りの再確認の代わりの口。架空の祭りの出典（example.com）は読みに行けないので、
 * データの公式の出典を読んだとみなして「予定どおり」を返す。結果は本物と同じく domain/verification.ts で決め直す
 */
const fictionalVerifier: FestivalVerifier = {
  async verify({ festival, date }) {
    const official = [...(occurrenceOn(festival, date)?.sources ?? []), ...festival.sources].find(
      (s) => s.confidence === "official",
    );
    return official === undefined
      ? { result: "not_found", sources: [], note: "公式の出典がありません" }
      : {
          result: "as_planned",
          sources: [{ url: official.url }],
          note: "架空の祭りのため、データの公式の出典で確かめたとみなしました",
        };
  },
};

/**
 * 費用の控え。接客サーバーのログ（console.info の JSON）から、相談と開催の確かめの費用を拾う。
 * 相談の費用は、続けて話すと累計で届くので、最後の値を読む（docs/spec/agent-runtime.md の「費用と使用量」）
 */
function tallyCosts() {
  let lastTurnUsd = 0;
  const costs = {
    verify: 0,
    verifyCount: 0,
    concierge: () => lastTurnUsd,
    total: () => lastTurnUsd + costs.verify,
  };
  const info = console.info.bind(console);
  console.info = (...args: unknown[]) => {
    info(...args);
    if (typeof args[0] !== "string" || !args[0].startsWith("{")) return;
    try {
      const line = JSON.parse(args[0]) as { kind?: unknown; totalCostUsd?: unknown };
      if (typeof line.totalCostUsd !== "number") return;
      if (line.kind === "turn") lastTurnUsd = line.totalCostUsd;
      if (line.kind === "verify") {
        costs.verify += line.totalCostUsd;
        costs.verifyCount += 1;
      }
    } catch {
      // JSON でないログは数えない
    }
  };
  return costs;
}

function formatUsd(usd: number): string {
  return `$${usd.toFixed(3)}`;
}

async function main() {
  const startedAt = Date.now();
  const costs = tallyCosts();
  const festivalsDir = await mkdtemp(path.join(tmpdir(), "matsuri-live-check-"));
  const cwd = createAgentWorkdir();
  let agentSessionId: string | null = null;
  try {
    if (realFestivalsDir === undefined) await shiftedFictionalFestivals(festivalsDir);
    const festivals = (await loadFestivals([realFestivalsDir ?? festivalsDir])).store;
    const itineraries = new ItineraryStore();
    const env = agentEnv(process.env);
    const prompts = await loadPrompts();
    const webVerifier = (model: string | undefined) =>
      createWebVerifier({
        prompt: prompts.verifier,
        model,
        cwd,
        env,
        query,
        maxBudgetUsd: config.maxBudgetUsd,
      });
    // 架空の祭りは Web で確かめられないので、候補の確かめは使わず、再確認は代わりの口で行う。
    // 実在の祭りでは、接客サーバーと同じく、再確認は MODEL_VERIFIER、候補の確かめは MODEL_STAFF で行う
    const verifier =
      realFestivalsDir === undefined ? fictionalVerifier : webVerifier(config.models.verifier);
    const runner = new ClaudeAgentRunner({
      festivals,
      itineraries,
      weather: createJmaWeather(),
      lodging: createLodgingService(process.env, { production: false, now: () => nowInJapan() }),
      verifier,
      ...(realFestivalsDir === undefined
        ? {}
        : {
            candidateChecks: createCandidateChecker({
              verifier: webVerifier(config.models.staff),
              today: () => today,
              now: () => nowInJapan(),
            }),
          }),
      prompts,
      models: config.models,
      maxBudgetUsd: config.maxBudgetUsd,
      cwd,
      env,
      today: () => today,
      now: () => nowInJapan(),
      query,
    });
    const sessions = new SessionStore();
    const app = createApp({
      runner,
      sessions,
      itineraries,
      festivals,
      limiter: new DailyLimiter(null, () => today),
      accessPasscode: null,
    });

    const { sessionId } = (await (
      await app.request("/api/session", { method: "POST", body: "{}" })
    ).json()) as { sessionId: string };
    const allEvents: SseEvent[] = [];
    const send = async (message: string) => {
      console.log(`\n> ${message}`);
      const started = Date.now();
      const events: SseEvent[] = [];
      const res = await app.request("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, message, preferences: DEFAULT_PREFERENCES }),
      });
      if (res.status !== 200)
        throw new Error(`/api/chat が ${res.status} を返しました：${await res.text()}`);
      await readSse(res, (event) => {
        events.push(event);
        allEvents.push(event);
        console.log(`  +${((Date.now() - started) / 1000).toFixed(1)}s ${describe(event)}`);
      });
      agentSessionId = sessions.get(sessionId)?.agentSessionId ?? agentSessionId;
      return events;
    };

    const failures: string[] = [];
    const finalStage = (events: SseEvent[]) => {
      const last = events.at(-1);
      return last?.type === "done" ? last.data.stage : null;
    };
    const expect = (ok: boolean, label: string) => {
      console.log(`${ok ? "OK" : "NG"}  ${label}`);
      if (!ok) failures.push(label);
    };
    const stage = (ok: boolean, label: string, detail: string) => {
      console.log(`${ok ? "OK" : "NG"}  ${label}：${detail}`);
      if (!ok) failures.push(label);
    };

    if (messages.length > 0) {
      for (const message of messages) await send(message);
    } else {
      const first = await send(
        `${formatMonthDay(festivalDay)}に、友だちと2人で、みなと中央駅から日帰りで行ける祭りはありますか。`,
      );
      const candidates = first.flatMap((e) =>
        e.type === "tool.end" ? (e.data.candidates ?? []) : [],
      );
      console.log("");
      expect(
        first.some((e) => e.type === "staff.start" && e.data.staff === "researcher"),
        "祭り調査係の staff.start",
      );
      expect(
        first.some((e) => e.type === "tool.start" && e.data.tool === "search_festivals"),
        "search_festivals の tool.start",
      );
      expect(
        candidates.some((c) => c.festivalId === "suzunari-toro" && c.daysFromWish === 0),
        "希望日の架空の祭りが候補に出る",
      );
      expect(
        first.some((e) => e.type === "message.delta"),
        "コンシェルジュの返答（message.delta）",
      );
      expect(finalStage(first) === "candidates", "最後が done で、会話の状態が candidates");

      if (target !== "candidates") {
        const second = await send("鈴鳴灯籠まつりにします。");
        console.log("");
        expect(
          second.some((e) => e.type === "staff.start" && e.data.staff === "planner"),
          "旅程係の staff.start",
        );
        expect(
          second.some((e) => e.type === "itinerary.updated"),
          "itinerary.updated",
        );
        expect(finalStage(second) === "itinerary", "最後が done で、会話の状態が itinerary");
      }

      if (target === "shiori") {
        const third = await send("この旅程で決定します。");
        console.log("");
        expect(
          third.some((e) => e.type === "tool.start" && e.data.tool === "verify_festival"),
          "verify_festival の tool.start",
        );
        expect(finalStage(third) === "shiori", "最後が done で、会話の状態が shiori");
      }
    }

    // 段階ごとの確認（相談の始めから、しおりまで）
    const session = sessions.get(sessionId);
    const itinerary = session?.itineraryId ? itineraries.get(session.itineraryId) : undefined;
    const verified = allEvents.flatMap((e) =>
      e.type === "festival.verified" && (e.data.scope ?? "itinerary") === "itinerary"
        ? [e.data]
        : [],
    );
    const shown = new Set(
      allEvents.flatMap((e) =>
        e.type === "tool.end" ? (e.data.candidates ?? []).map((c) => c.festivalId) : [],
      ),
    );
    console.log("\n段階ごとの確認");
    stage(shown.size > 0, "候補", shown.size > 0 ? [...shown].join(",") : "候補が出ていません");
    stage(
      itinerary !== undefined,
      "旅程の保存",
      itinerary === undefined
        ? "旅程が保存されていません"
        : `第${itinerary.version}版 ${itinerary.days.length}日 予定${itinerary.days.reduce((n, d) => n + d.items.length, 0)}件`,
    );
    if (itinerary !== undefined) {
      for (const day of itinerary.days) {
        console.log(`      ${day.date} 泊=${day.stay?.area ?? "帰宅"}`);
        for (const item of day.items) {
          console.log(`        ${item.start}-${item.end} ${item.type} ${item.name}`);
        }
      }
    }
    if (target === "shiori") {
      const last = verified.at(-1);
      const status = itinerary?.verification.status ?? "pending";
      stage(
        last !== undefined && status !== "pending",
        "確定前の再確認",
        last === undefined
          ? "再確認が行われていません"
          : `${status}${last.note ? `「${last.note}」` : ""} 出典=${last.sources.map((s) => `${s.url}(${s.confidence})`).join(",") || "なし"}`,
      );
      const html = itinerary ? await app.request(`/shiori/${itinerary.id}`) : null;
      stage(html?.status === 200, "しおり（HTML）", `${html?.status ?? "旅程なし"}`);
      if (withPdf) {
        const pdf = itinerary ? await app.request(`/shiori/${itinerary.id}.pdf`) : null;
        const type = pdf?.headers.get("content-type") ?? "";
        const bytes = pdf?.status === 200 ? (await pdf.arrayBuffer()).byteLength : 0;
        stage(
          pdf?.status === 200 && type.startsWith("application/pdf"),
          "しおり（PDF）",
          pdf ? `${pdf.status} ${type} ${bytes}バイト` : "旅程なし",
        );
      }
    }

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(0);
    console.log(
      `\n合計 ${seconds}秒・${formatUsd(costs.total())}（接客 ${formatUsd(costs.concierge())}・開催の確かめ ${costs.verifyCount}回 ${formatUsd(costs.verify)}。SDK の推定）`,
    );
    if (failures.length > 0) {
      console.error(`\n${failures.length}件の確認に失敗しました：${failures.join("、")}`);
      process.exitCode = 1;
    } else {
      console.log("\nすべて確認できました");
    }
  } finally {
    // 確かめ終えたら、この相談の会話の記録を消す
    if (agentSessionId !== null) await deleteSession(agentSessionId, { dir: cwd }).catch(() => {});
    await rm(festivalsDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}

await main();
