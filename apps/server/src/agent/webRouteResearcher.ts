import {
  buildJsonRetryPrompt,
  createWebActivityLog,
  parseJsonWithSchema,
  STRICT_JSON_RULES,
  ungroundedSources,
} from "@matsuri-ikoka/agent-kit";
import { z } from "zod";
import { formatMonthDayWithWeekday } from "../domain/calendar";
import type { RouteReport, RouteResearcher } from "../tools/routeResearch";
import type { ResolveHost } from "./addressGuard";
import type { QueryFn } from "./runner";
import {
  buildVerifierOptions,
  createVerifierHooks,
  type FetchedPage,
  finalText,
} from "./webVerifier";

// research_route の中で、Web の検索と取得だけを許した1回きりのエージェントに、出発の駅から会場の最寄り駅までの
// 行き方を調べさせる（docs/spec/agent-runtime.md の「行き方の調べ」）。
// 動かし方（開発環境から切り離す・WebFetch の宛先を確かめる・JSON の差し戻し）は確定前の再確認と同じ。
// 所要時間は、ツールの側で駅の位置からの見積もりと照らし（checkResearchedMinutes）、出典は読んだページだけを残す。

const ReportSchema = z.object({
  found: z.boolean(),
  minutes: z.tuple([z.number().int(), z.number().int()]).optional(),
  summary: z.string().max(160).optional(),
  transfers: z.number().int().min(0).max(10).nullable().optional(),
  sources: z.array(z.object({ url: z.string(), title: z.string().optional() })).max(5),
});

const ANSWER_FORMAT = [
  "## 返し方",
  "",
  "最後に、次の形の JSON を1つだけ返す。",
  "",
  '{"found":true,"minutes":[最短の分, 長くかかるときの分],"summary":"乗る路線と乗り換えの駅を1文で","transfers":乗り換えの回数,"sources":[{"url":"読んだページの URL","title":"ページの題名"}]}',
  "",
  "- 分からなければ found を false にし、minutes と summary は入れない",
  "- sources には、WebFetch で実際に読んだページだけを入れる",
  STRICT_JSON_RULES,
].join("\n");

/** 調べた結果をとっておく時間（行き方は日によって変わりにくい） */
export const ROUTE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function createWebRouteResearcher(deps: {
  prompt: string;
  model?: string | undefined;
  cwd: string;
  env: Record<string, string>;
  query: QueryFn;
  resolveHost?: ResolveHost;
  maxBudgetUsd?: number | undefined;
  clock?: () => number;
}): RouteResearcher {
  const systemPrompt = `${deps.prompt}\n\n${ANSWER_FORMAT}`;
  const clock = deps.clock ?? Date.now;
  const cache = new Map<string, { value: RouteReport; expiresAt: number }>();
  return {
    async research({ from, to, date, arriveBy, signal }) {
      const key = `${from}→${to}`;
      const hit = cache.get(key);
      if (hit !== undefined && hit.expiresAt > clock()) return hit.value;

      const request = [
        `出発の駅：${from}`,
        `着く駅：${to}`,
        `日付：${formatMonthDayWithWeekday(date)}（${date}）`,
        ...(arriveBy ? [`この時刻までに着きたい：${arriveBy}`] : []),
      ].join("\n");
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      if (signal.aborted) abort();
      signal.addEventListener("abort", abort, { once: true });
      const log = createWebActivityLog();
      const pages: FetchedPage[] = [];
      const options = (withTools: boolean) =>
        buildVerifierOptions({
          systemPrompt,
          model: deps.model,
          cwd: deps.cwd,
          env: deps.env,
          abortController: controller,
          maxBudgetUsd: deps.maxBudgetUsd,
          withTools,
          ...(withTools
            ? {
                hooks: createVerifierHooks(
                  log,
                  deps.resolveHost,
                  pages,
                  "検索結果だけでは行き方を確かめられません。乗り換え案内か鉄道会社のページを WebFetch で1つ読んでから、決めた形の JSON で答えてください。",
                ),
              }
            : {}),
        });
      const started = Date.now();
      let costUsd = 0;
      let found = false;
      const ask = async (prompt: string, withTools: boolean) => {
        const reply = await finalText(deps.query, prompt, options(withTools));
        costUsd += reply.costUsd;
        return reply.text;
      };
      try {
        const answer = await ask(request, true);
        if (answer === null) return null;
        let parsed = parseJsonWithSchema(answer, ReportSchema, "object");
        if (!parsed.ok) {
          const failure =
            parsed.reason === "parse"
              ? { reason: "parse" as const, error: parsed.error }
              : { reason: "shape" as const, issues: parsed.issues };
          const retry = await ask(
            buildJsonRetryPrompt({ previous: answer, failure, shape: "object" }),
            false,
          );
          if (retry === null) return null;
          parsed = parseJsonWithSchema(retry, ReportSchema, "object");
          if (!parsed.ok) return null;
        }
        const report = parsed.value;
        // 実際に読んでいないページは出典にしない。読んだページがなければ、調べたことにしない
        const unread = new Set(ungroundedSources(report.sources, log.fetchedUrls));
        const sources = report.sources.filter((s) => !unread.has(s.url));
        if (!report.found || report.minutes === undefined || sources.length === 0) return null;
        found = true;
        const value: RouteReport = {
          minutes: report.minutes,
          summary: report.summary ?? "",
          transfers: report.transfers ?? null,
          sources,
        };
        cache.set(key, { value, expiresAt: clock() + ROUTE_CACHE_TTL_MS });
        return value;
      } finally {
        signal.removeEventListener("abort", abort);
        // 費用・所要時間・調べた数だけを残す（駅の名前や URL は残さない）
        console.info(
          JSON.stringify({
            kind: "route_research",
            found,
            totalCostUsd: costUsd,
            elapsedMs: Date.now() - started,
            searches: log.searches.length,
            fetched: log.fetchedUrls.length,
          }),
        );
      }
    },
  };
}
