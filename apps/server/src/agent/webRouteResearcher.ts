import {
  buildJsonRetryPrompt,
  createWebActivityLog,
  parseJsonWithSchema,
  STRICT_JSON_RULES,
  ungroundedSources,
} from "@matsuri-ikoka/agent-kit";
import { MOVE_MEANS } from "@matsuri-ikoka/schema";
import { z } from "zod";
import { formatMonthDayWithWeekday } from "../domain/calendar";
import { sameStationName } from "../domain/travelEstimate";
import type { RouteLeg, RouteReport, RouteResearcher } from "../tools/routeResearch";
import type { ResolveHost } from "./addressGuard";
import type { QueryFn } from "./runner";
import {
  buildVerifierOptions,
  createVerifierHooks,
  type FetchedPage,
  type FinalReply,
  finalText,
} from "./webVerifier";

// research_route の中で、Web の検索と取得だけを許した1回きりのエージェントに、出発の駅から会場の最寄り駅までの
// 行き方を調べさせる（docs/spec/agent-runtime.md の「行き方の調べ」）。
// 動かし方（開発環境から切り離す・WebFetch の宛先を確かめる・JSON の差し戻し）は確定前の再確認と同じ。
// 所要時間は、ツールの側で駅の位置からの見積もりと照らし（checkResearchedMinutes）、出典は読んだページだけを残す。
// 見つからなければ、時間の残りがあるときだけ、調べ方を変えて1回調べ直す。

const MinutesSchema = z
  .tuple([z.number().int().min(0), z.number().int().min(0)])
  .refine(([min, max]) => min <= max);

/** 区間ごとの所要時間や路線は書かれていないページが多いので、読めなければ null で受け取る */
const LegSchema = z.object({
  means: z.enum(MOVE_MEANS).catch("train"),
  from: z.string().trim().min(1).max(60),
  to: z.string().trim().min(1).max(60),
  line: z.string().trim().min(1).max(60).nullable().catch(null),
  minutes: MinutesSchema.nullable().catch(null),
});

/**
 * 答えに欠かせないのは found・minutes・sources だけ。
 * ほかの項目の書き方の違いで、読めた行き方を丸ごと捨てないよう、それぞれ「分からない」に倒す
 */
const ReportSchema = z.object({
  found: z.boolean(),
  minutes: z.tuple([z.number().int(), z.number().int()]).nullable().optional().catch(null),
  summary: z
    .string()
    .transform((text) => text.slice(0, 160))
    .optional()
    .catch(undefined),
  transfers: z.number().int().min(0).max(10).nullable().optional().catch(null),
  legs: z.array(LegSchema).max(6).nullable().optional().catch(null),
  lastDeparture: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable()
    .optional()
    .catch(null),
  sources: z.array(z.object({ url: z.string(), title: z.string().optional() })).max(5),
});

const ANSWER_FORMAT = [
  "## 返し方",
  "",
  "最後に、次の形の JSON を1つだけ返す。",
  "",
  '{"found":true,"minutes":[最短の分, 長くかかるときの分],"summary":"乗る路線と乗り換えの駅を1文で","transfers":乗り換えの回数,' +
    '"legs":[{"means":"train か bus か walk","from":"乗る駅","to":"降りる駅","line":"路線の名前","minutes":[最短の分, 長くかかるときの分]}],' +
    '"lastDeparture":"HH:MM","sources":[{"url":"読んだページの URL","title":"ページの題名"}]}',
  "",
  "- 全体の所要時間と、乗る路線か乗り換えの駅が読めたら found を true にする。全体の所要時間が読めないときだけ found を false にし、minutes と summary は入れない",
  "- legs は乗り換えごとの区間を乗る順に並べる。最初の区間は出発の駅から始め、最後の区間は着く駅で終える。前の区間の降りる駅から次の区間を始める。駅の間を歩いて移るところも means を walk にして区間にする。区間の所要時間が読めなければ、その区間の minutes を null にする。路線が読めなければ line を null にする。区間が1つも読めなければ legs を null にする",
  "- lastDeparture は、帰りの調べのときだけ、その日のうちに着く駅まで帰れる、出発の駅を出る最終の時刻。読んだページで分からなければ null（推測で書かない）",
  "- sources には、WebFetch で実際に読んだページだけを入れる",
  STRICT_JSON_RULES,
].join("\n");

/** 区間がつながっていて、出発の駅から着く駅までを結んでいるか */
function connectedLegs(legs: readonly RouteLeg[], from: string, to: string): boolean {
  const [first] = legs;
  const last = legs.at(-1);
  if (first === undefined || last === undefined) return false;
  if (!sameStationName(first.from, from) || !sameStationName(last.to, to)) return false;
  return legs.every((leg, index) => {
    const next = legs[index + 1];
    return next === undefined || sameStationName(next.from, leg.to);
  });
}

/** 区間の境と両端の駅の名前を、頼んだ駅の名前にそろえる（旅程の検査で書き方の違いが断られないように） */
function alignLegs(legs: readonly RouteLeg[], from: string, to: string): RouteLeg[] {
  return legs.map((leg, index, all) => ({
    ...leg,
    from: index === 0 ? from : (all[index - 1]?.to ?? leg.from),
    ...(index === all.length - 1 ? { to } : {}),
  }));
}

/** 調べた結果をとっておく時間（行き方は日によって変わりにくい） */
export const ROUTE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** 調べ直しを含めて、調べを打ち切る時間（ミリ秒）。ツールの上限（research_route・research_trip）より短くする */
export const ROUTE_RESEARCH_MS = 85_000;
/** 調べ方を変えて調べ直すのに要る、時間の残り（ミリ秒）。ふつうの調べは30秒から1分かかる */
export const ROUTE_RETRY_MIN_MS = 30_000;

const RETRY_HINT = [
  "調べ直しです。前回は、この2つの駅を結ぶ行き方を確かめられませんでした。",
  "検索の言葉を変えてください（「出発の駅の名前 着く駅の名前 乗換案内」「着く駅の名前 アクセス」など）。",
  "2つの駅を結ぶページがなければ、途中の主要な駅で区切って調べ（出発の駅→主要な駅、主要な駅→着く駅）、読めた区間をつなげて答えてください。",
].join("\n");

export function createWebRouteResearcher(deps: {
  prompt: string;
  model?: string | undefined;
  cwd: string;
  env: Record<string, string>;
  query: QueryFn;
  resolveHost?: ResolveHost;
  maxBudgetUsd?: number | undefined;
  /** 残した会話の記録を消す（Agent SDK の deleteSession を包んだもの）。省略すると消さない（テスト） */
  forgetTranscript?: ((sessionId: string) => void) | undefined;
  clock?: () => number;
}): RouteResearcher {
  const systemPrompt = `${deps.prompt}\n\n${ANSWER_FORMAT}`;
  const clock = deps.clock ?? Date.now;
  const cache = new Map<string, { value: RouteReport; expiresAt: number }>();
  return {
    async research({
      from,
      to,
      date,
      arriveBy,
      direction = "outbound",
      focus,
      signal,
      onActivity,
    }) {
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

      const researchOnce = async (prompt: string, limitMs: number): Promise<RouteReport | null> => {
        const controller = new AbortController();
        const abort = () => controller.abort(signal.reason);
        if (signal.aborted) abort();
        signal.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(() => controller.abort(new Error("timeout")), limitMs);
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
                    "まだページを読んでいません。乗り換え案内か鉄道会社のページを検索して WebFetch で1つ読んでから、決めた形の JSON で答えてください。",
                  ),
                }
              : {}),
          });
        const started = Date.now();
        let costUsd = 0;
        let found = false;
        let legCount = 0;
        let salvage: FinalReply["salvage"] = null;
        const ask = async (text: string, withTools: boolean) => {
          const reply = await finalText(
            deps.query,
            text,
            options(withTools),
            onActivity,
            deps.forgetTranscript,
          );
          costUsd += reply.costUsd;
          salvage ??= reply.salvage;
          return reply.text;
        };
        try {
          const answer = await ask(prompt, true);
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
          if (!report.found || report.minutes == null || sources.length === 0) return null;
          found = true;
          // 区間は、出発の駅から着く駅までつながっているときだけ使う（つながらない区間は取り違えのおそれがある）。
          // つながっていなければ、道具なしで1回だけ直してもらう。直らなければ区間なしで返す
          let legs: readonly RouteLeg[] | null = report.legs ?? null;
          if (legs !== null && !connectedLegs(legs, from, to)) {
            const fixed = await ask(
              buildJsonRetryPrompt({
                previous: answer,
                failure: {
                  reason: "shape",
                  issues: [
                    `legs：最初の区間は「${from}」から始め、最後の区間は「${to}」で終え、前の区間の降りる駅から次の区間を始めてください。駅の間を歩いて移るところも means を walk にして区間にしてください。読んだページで分からなければ legs を null にしてください`,
                  ],
                },
                shape: "object",
              }),
              false,
            ).catch(() => null);
            const again =
              fixed === null ? null : parseJsonWithSchema(fixed, ReportSchema, "object");
            const legsAgain = again?.ok ? (again.value.legs ?? null) : null;
            legs = legsAgain !== null && connectedLegs(legsAgain, from, to) ? legsAgain : null;
          }
          legCount = legs?.length ?? 0;
          return {
            minutes: report.minutes,
            summary: report.summary ?? "",
            transfers: report.transfers ?? null,
            ...(legs === null ? {} : { legs: alignLegs(legs, from, to) }),
            ...(direction === "return" ? { lastDeparture: report.lastDeparture ?? null } : {}),
            sources,
          };
        } catch (error) {
          // 時間の上限で止めたときは、見つからなかったものとして扱う
          if (controller.signal.aborted && !signal.aborted) return null;
          throw error;
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          // 費用・所要時間・調べた数だけを残す（駅の名前や URL は残さない）
          console.info(
            JSON.stringify({
              kind: "route_research",
              found,
              legs: legCount,
              ...(salvage === null ? {} : { salvage }),
              totalCostUsd: costUsd,
              elapsedMs: Date.now() - started,
              searches: log.searches.length,
              fetched: log.fetchedUrls.length,
            }),
          );
        }
      };

      const deadline = clock() + ROUTE_RESEARCH_MS;
      let value = await researchOnce(request, ROUTE_RESEARCH_MS);
      // 見つからなければ、時間の残りがあるときだけ、調べ方を変えて調べ直す
      const remaining = deadline - clock();
      if (value === null && !signal.aborted && remaining >= ROUTE_RETRY_MIN_MS) {
        value = await researchOnce(`${request}\n${RETRY_HINT}`, remaining);
      }
      if (value !== null) cache.set(key, { value, expiresAt: clock() + ROUTE_CACHE_TTL_MS });
      return value;
    },
  };
}
