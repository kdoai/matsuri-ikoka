import {
  buildJsonRetryPrompt,
  createWebActivityLog,
  parseJsonWithSchema,
  STRICT_JSON_RULES,
  ungroundedSources,
} from "@matsuri-ikoka/agent-kit";
import { z } from "zod";
import { formatMonthDayWithWeekday } from "../domain/calendar";
import { sameStationName } from "../domain/travelEstimate";
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

const MinutesSchema = z
  .tuple([z.number().int().min(0), z.number().int().min(0)])
  .refine(([min, max]) => min <= max);

const LegSchema = z.object({
  from: z.string().trim().min(1).max(60),
  to: z.string().trim().min(1).max(60),
  line: z.string().trim().min(1).max(60).nullable(),
  minutes: MinutesSchema,
});

const ReportSchema = z.object({
  found: z.boolean(),
  minutes: z.tuple([z.number().int(), z.number().int()]).optional(),
  summary: z.string().max(160).optional(),
  transfers: z.number().int().min(0).max(10).nullable().optional(),
  legs: z.array(LegSchema).max(6).nullable().optional(),
  lastDeparture: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable()
    .optional(),
  sources: z.array(z.object({ url: z.string(), title: z.string().optional() })).max(5),
});

const ANSWER_FORMAT = [
  "## 返し方",
  "",
  "最後に、次の形の JSON を1つだけ返す。",
  "",
  '{"found":true,"minutes":[最短の分, 長くかかるときの分],"summary":"乗る路線と乗り換えの駅を1文で","transfers":乗り換えの回数,' +
    '"legs":[{"from":"乗る駅","to":"降りる駅","line":"路線の名前","minutes":[最短の分, 長くかかるときの分]}],' +
    '"lastDeparture":"HH:MM","sources":[{"url":"読んだページの URL","title":"ページの題名"}]}',
  "",
  "- 路線と所要時間が分からなければ found を false にし、minutes と summary は入れない。最終の時刻だけが分からないときは found を true にし、lastDeparture を null にする",
  "- legs は乗り換えごとの区間を乗る順に並べる。最初の区間は出発の駅から、最後の区間は着く駅で終える。区間の境の駅が乗り換えの駅になる。読んだページで分からなければ null",
  "- lastDeparture は、帰りの調べのときだけ、その日のうちに着く駅まで帰れる、出発の駅を出る最終の時刻。読んだページで分からなければ null（推測で書かない）",
  "- sources には、WebFetch で実際に読んだページだけを入れる",
  STRICT_JSON_RULES,
].join("\n");

/** 区間がつながっていて、出発の駅から着く駅までを結んでいるか */
function connectedLegs(
  legs: readonly z.infer<typeof LegSchema>[],
  from: string,
  to: string,
): boolean {
  const [first] = legs;
  const last = legs.at(-1);
  if (first === undefined || last === undefined) return false;
  if (!sameStationName(first.from, from) || !sameStationName(last.to, to)) return false;
  return legs.every((leg, index) => {
    const next = legs[index + 1];
    return next === undefined || sameStationName(next.from, leg.to);
  });
}

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
    async research({ from, to, date, arriveBy, direction = "outbound", focus, signal }) {
      // 調べ直し（focus があるとき）は、とっておいた結果を使わない
      const key = `${direction}:${from}→${to}`;
      const hit = focus === undefined ? cache.get(key) : undefined;
      if (hit !== undefined && hit.expiresAt > clock()) return hit.value;

      const request = [
        `調べること：${direction === "return" ? "帰り（乗り換えの区間と、その日のうちに帰れる最終の時刻）" : "行き（乗り換えの区間）"}`,
        `出発の駅：${from}`,
        `着く駅：${to}`,
        `日付：${formatMonthDayWithWeekday(date)}（${date}）`,
        ...(arriveBy ? [`この時刻までに着きたい：${arriveBy}`] : []),
        ...(focus ? [`調べ直しで特に確かめること：${focus}`] : []),
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
        // 区間は、出発の駅から着く駅までつながっているときだけ使う（つながらない区間は取り違えのおそれがある）
        const legs =
          report.legs != null && connectedLegs(report.legs, from, to)
            ? // 区間の両端の駅は、頼んだ駅の名前にそろえる
              report.legs.map((leg, index, all) => ({
                ...leg,
                ...(index === 0 ? { from } : {}),
                ...(index === all.length - 1 ? { to } : {}),
              }))
            : undefined;
        const value: RouteReport = {
          minutes: report.minutes,
          summary: report.summary ?? "",
          transfers: report.transfers ?? null,
          ...(legs === undefined ? {} : { legs }),
          ...(direction === "return" ? { lastDeparture: report.lastDeparture ?? null } : {}),
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
