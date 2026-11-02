// live の確認：架空の祭りへの相談を Agent SDK で実際に流し、スタッフのイベントと候補が SSE で返るかを確かめる。
//
//   pnpm --filter @matsuri-ikoka/server check:live              # 祭りの候補まで
//   pnpm --filter @matsuri-ikoka/server check:live -- --itinerary # 旅程の保存まで
//
// 認証は Agent SDK に任せる（ANTHROPIC_API_KEY か、ログイン済みの Claude Code の資格情報）。
// 祭りは data/samples/festivals の架空の祭りだけを使い、開催日を今日より先にずらした写しを一時フォルダに作る。
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
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
import { DailyLimiter } from "../src/routes/guard";
import { ItineraryStore, SessionStore } from "../src/session/sessionStore";
import { unavailableVerifier } from "../src/tools/verifier";
import { createJmaWeather } from "../src/tools/weather";

const withItinerary = process.argv.includes("--itinerary");
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
          ? ` 候補=${event.data.candidates.map((c) => `${c.festivalId}(${c.daysFromWish >= 0 ? "+" : ""}${c.daysFromWish})`).join(",")}`
          : ""
      }`;
    case "itinerary.updated":
      return `itinerary.updated 第${event.data.itinerary.version}版 予定${event.data.itinerary.items.length}件 追加=${event.data.diff.added.length}`;
    case "message.delta":
      return `message.delta 「${event.data.text}」`;
    case "error":
      return `error ${event.data.code}「${event.data.message}」`;
    case "done":
      return `done stage=${event.data.stage} conditions=${JSON.stringify(event.data.conditions)}`;
    default:
      return event.type;
  }
}

async function main() {
  const festivalsDir = await mkdtemp(path.join(tmpdir(), "matsuri-live-check-"));
  const cwd = createAgentWorkdir();
  try {
    await shiftedFictionalFestivals(festivalsDir);
    const festivals = (await loadFestivals([festivalsDir])).store;
    const itineraries = new ItineraryStore();
    const env = agentEnv(process.env);
    const runner = new ClaudeAgentRunner({
      festivals,
      itineraries,
      weather: createJmaWeather(),
      // 架空の祭りは Web で確かめられないので、再確認は使わない
      verifier: unavailableVerifier,
      prompts: await loadPrompts(),
      models: config.models,
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
        console.log(`  +${((Date.now() - started) / 1000).toFixed(1)}s ${describe(event)}`);
      });
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

    if (withItinerary) {
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

    if (failures.length > 0) {
      console.error(`\n${failures.length}件の確認に失敗しました`);
      process.exitCode = 1;
    } else {
      console.log("\nすべて確認できました");
    }
  } finally {
    await rm(festivalsDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}

await main();
