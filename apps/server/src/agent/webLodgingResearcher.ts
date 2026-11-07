import {
  buildJsonRetryPrompt,
  checkPublicWebUrl,
  createWebActivityLog,
  parseJsonWithSchema,
  STRICT_JSON_RULES,
  ungroundedSources,
} from "@matsuri-ikoka/agent-kit";
import { LatLngSchema, type LodgingPerspective } from "@matsuri-ikoka/schema";
import { z } from "zod";
import { formatMonthDayWithWeekday } from "../domain/calendar";
import type {
  LodgingSearchPlan,
  PerspectiveLodgingReport,
  ResearchedLodgingReport,
} from "../domain/lodgingResearch";
import type { LodgingResearcher, LodgingResearchRequest } from "../tools/lodgingResearch";
import type { ResolveHost } from "./addressGuard";
import { partyLabel } from "./briefing";
import type { RobotsChecker } from "./robots";
import type { QueryFn } from "./runner";
import { buildVerifierOptions, createVerifierHooks, finalText } from "./webVerifier";

// search_lodging の中で、Web の検索と取得だけを許した1回きりのエージェント（宿の調べ役）を、
// 観点（会場の近く・駅の近く・予算・家族向け）ごとに並べて動かす（docs/spec/agent-runtime.md の「宿の調べ」）。
// 動かし方（開発環境から切り離す・WebFetch の宛先を確かめる・JSON の差し戻し）は寄り道の調べと同じ。
// 観点をまたいだ突き合わせ・距離・予算に合うかは、ツールの側でコードが決め（screenResearchedLodging）、出典は読んだページだけを残す。

const HotelSchema = z.object({
  name: z.string().trim().min(1).max(100),
  summary: z.string().trim().min(1).max(120),
  lat: LatLngSchema.shape.lat,
  lng: LatLngSchema.shape.lng,
  perPersonNightYen: z
    .tuple([z.number().int().min(0), z.number().int().min(0)])
    .refine(([min, max]) => min <= max)
    .nullable()
    .default(null),
  price: z.string().trim().min(1).max(80).nullable().default(null),
  familyFriendly: z.boolean().nullable().default(null),
  pageUrl: z.string(),
  sources: z.array(z.object({ url: z.string(), title: z.string().optional() })).max(3),
});

// 宿ごとに形を確かめ、形の合わない宿だけを捨てる（1件の誤りで全体を捨てない）
const ReportSchema = z.object({ hotels: z.array(z.unknown()).max(8) });

const ANSWER_FORMAT = [
  "## 返し方",
  "",
  "最後に、次の形の JSON を1つだけ返す。合う宿がなければ hotels を空の配列にする。",
  "",
  '{"hotels":[{"name":"宿の名前","summary":"自分の言葉で1文の要約","lat":緯度,"lng":経度,' +
    '"perPersonNightYen":[1泊1人の最低の円, 最高の円],"price":"料金の目安の文","familyFriendly":true,' +
    '"pageUrl":"宿の公式か予約サイトの宿のページの URL","sources":[{"url":"読んだページの URL","title":"ページの題名"}]}]}',
  "",
  "- perPersonNightYen と price は、ページに書かれた1泊1人あたりの料金だけ。分からなければ null。1部屋の料金しかなければ price に「1室○円から」のように書き、perPersonNightYen は null",
  "- familyFriendly は、子どもの宿泊や家族で泊まれる部屋があるとページにあれば true、子どもを断っていれば false、分からなければ null",
  "- lat・lng は、読んだページの地図や住所から分かる位置。分からない宿は入れない",
  "- pageUrl は、sources のうちの宿のページ",
  "- sources には、WebFetch で実際に読んだページだけを入れる（検索結果に出ただけのページは入れない）",
  STRICT_JSON_RULES,
].join("\n");

/** 1つの観点の調べのターンの上限。検索を並べて呼び、宿のページ（最大5つ）を読み、言葉を変えて探し直せるだけの回数 */
export const LODGING_MAX_TURNS = 12;

/** 調べた結果をとっておく時間（料金と休館の告知が変わりうるので短めにする） */
export const LODGING_RESEARCH_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const PERSPECTIVE_LABELS: Record<LodgingPerspective, string> = {
  venue: "会場の近くの宿",
  station: "最寄りの駅の近くの宿",
  budget: "予算に合う宿",
  family: "家族で泊まりやすい宿",
};

/** 観点の調べ方を、依頼文に入れる形にする（毎回の調べに必ず入れる） */
export function lodgingPlanLines(plan: LodgingSearchPlan): string[] {
  return [
    "",
    `## 調べ方（観点：${PERSPECTIVE_LABELS[plan.perspective]}）`,
    "",
    "検索の言葉（上から優先。いくつかを並べて検索する。合う宿が少なければ、言葉を変えて探し直してよい）：",
    ...plan.queries.map((q) => `- ${q}`),
    "",
    "宿のページで確かめる観点：",
    ...plan.checkpoints.map((c) => `- ${c}`),
    "",
    `探す範囲：会場からおおむね ${plan.radiusKm}km 以内`,
  ];
}

/** 宿のページの URL を、公開の Web の https か http のものだけにする */
function safePageUrl(raw: string): string | null {
  const check = checkPublicWebUrl(raw);
  return check.ok ? check.url.toString() : null;
}

/** 報告の宿を形で確かめ、読んでいないページを出典から外す。宿のページを読んでいなければ入れない */
export function parseHotels(
  items: unknown[],
  fetched: readonly string[],
): ResearchedLodgingReport[] {
  return items.flatMap((item) => {
    const parsed = HotelSchema.safeParse(item);
    if (!parsed.success) return [];
    const { lat, lng, sources, pageUrl, ...rest } = parsed.data;
    const unread = new Set(ungroundedSources(sources, fetched));
    const read = sources.flatMap((s) => {
      if (unread.has(s.url)) return [];
      const url = safePageUrl(s.url);
      return url === null ? [] : [{ ...s, url }];
    });
    const [first] = read;
    if (first === undefined) return [];
    // 宿のページは、読んだページのうちの1つだけを使う（読んでいなければ、読んだ最初のページ）
    const page =
      ungroundedSources([{ url: pageUrl }], fetched).length === 0 ? safePageUrl(pageUrl) : null;
    return [{ ...rest, location: { lat, lng }, pageUrl: page ?? first.url, sources: read }];
  });
}

export function createWebLodgingResearcher(deps: {
  prompt: string;
  model?: string | undefined;
  cwd: string;
  env: Record<string, string>;
  query: QueryFn;
  resolveHost?: ResolveHost;
  robots?: RobotsChecker;
  maxBudgetUsd?: number | undefined;
  /** 調べ役の会話の記録を消す（ターンの上限で終わった調べを救うために、調べの間だけ記録を残す） */
  forgetSession?: (sessionId: string) => void;
  clock?: () => number;
}): LodgingResearcher {
  const systemPrompt = `${deps.prompt}\n\n${ANSWER_FORMAT}`;
  const clock = deps.clock ?? Date.now;
  const cache = new Map<string, { value: PerspectiveLodgingReport; expiresAt: number }>();

  /** 1つの観点を、1回きりのエージェントで調べる。調べられなければ null */
  async function researchOne(
    input: LodgingResearchRequest,
    plan: LodgingSearchPlan,
    controller: AbortController,
  ): Promise<PerspectiveLodgingReport | null> {
    const { festival } = input;
    const key = JSON.stringify([
      festival.id,
      input.checkIn,
      input.nights,
      input.party,
      input.perPersonNightLimitYen,
      plan,
    ]);
    const hit = cache.get(key);
    if (hit !== undefined && hit.expiresAt > clock()) return hit.value;

    const request = [
      `祭り：${festival.name}（${festival.place}）`,
      `会場：${festival.venue.name}（緯度 ${festival.venue.lat}、経度 ${festival.venue.lng}）`,
      `泊まる日：${formatMonthDayWithWeekday(input.checkIn)}（${input.checkIn}）から ${input.nights}泊`,
      `人数：${partyLabel(input.party)}`,
      ...(input.perPersonNightLimitYen !== null
        ? [`宿の予算：1泊1人あたり ${input.perPersonNightLimitYen.toLocaleString("ja-JP")}円まで`]
        : []),
      // 調べ方（検索の言葉と確かめる観点）は、コードで決めたものを毎回必ず入れる
      ...lodgingPlanLines(plan),
    ].join("\n");
    const log = createWebActivityLog();
    const options = (withTools: boolean) =>
      buildVerifierOptions({
        systemPrompt,
        model: deps.model,
        cwd: deps.cwd,
        env: deps.env,
        abortController: controller,
        maxBudgetUsd: deps.maxBudgetUsd,
        withTools,
        keepRecord: deps.forgetSession !== undefined,
        maxTurns: LODGING_MAX_TURNS,
        ...(withTools
          ? {
              hooks: createVerifierHooks(
                log,
                deps.resolveHost,
                [],
                "検索結果だけでは宿を確かめられません。宿のページを WebFetch で読んでから、決めた形の JSON で答えてください。",
                deps.robots,
              ),
            }
          : {}),
      });
    const started = Date.now();
    let costUsd = 0;
    let found = 0;
    let salvaged = false;
    const ask = async (prompt: string, withTools: boolean) => {
      const reply = await finalText(
        deps.query,
        prompt,
        options(withTools),
        input.onActivity,
        withTools ? { options: options(false), forget: deps.forgetSession } : undefined,
      );
      costUsd += reply.costUsd;
      salvaged ||= reply.salvaged;
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
      // 1つもページを読んでいなければ、調べたことにしない
      if (log.fetchedUrls.length === 0) return null;
      const value = {
        perspective: plan.perspective,
        hotels: parseHotels(parsed.value.hotels, log.fetchedUrls),
      };
      found = value.hotels.length;
      cache.set(key, { value, expiresAt: clock() + LODGING_RESEARCH_CACHE_TTL_MS });
      return value;
    } finally {
      // 費用・所要時間・調べた数だけを残す（宿の名前や URL は残さない）
      console.info(
        JSON.stringify({
          kind: "lodging_research",
          perspective: plan.perspective,
          found,
          salvaged,
          totalCostUsd: costUsd,
          elapsedMs: Date.now() - started,
          searches: log.searches.length,
          fetched: log.fetchedUrls.length,
        }),
      );
    }
  }

  return {
    async research(input) {
      const { signal } = input;
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      if (signal.aborted) abort();
      signal.addEventListener("abort", abort, { once: true });
      try {
        // 観点ごとの調べ役を並べて動かす。1つが失敗しても、ほかの観点の結果は使う
        const settled = await Promise.allSettled(
          input.plans.map((plan) => researchOne(input, plan, controller)),
        );
        const reports = settled.flatMap((result) =>
          result.status === "fulfilled" && result.value !== null ? [result.value] : [],
        );
        return reports.length === 0 ? null : { reports };
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}
