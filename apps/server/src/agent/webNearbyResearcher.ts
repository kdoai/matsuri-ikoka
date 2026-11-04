import {
  buildJsonRetryPrompt,
  createWebActivityLog,
  parseJsonWithSchema,
  STRICT_JSON_RULES,
  ungroundedSources,
} from "@matsuri-ikoka/agent-kit";
import {
  DIETARY_NEEDS,
  FOOD_WISHES,
  LatLngSchema,
  NEARBY_KINDS,
  OpeningHoursSchema,
  WeekdaySchema,
} from "@matsuri-ikoka/schema";
import { z } from "zod";
import { formatMonthDayWithWeekday } from "../domain/calendar";
import { DIETARY_LABELS, FOOD_WISH_LABELS } from "../domain/food";
import type { ResearchedSpotReport } from "../domain/nearbyResearch";
import type { NearbyResearcher } from "../tools/nearbyResearch";
import type { ResolveHost } from "./addressGuard";
import type { QueryFn } from "./runner";
import {
  buildVerifierOptions,
  createVerifierHooks,
  type FetchedPage,
  finalText,
} from "./webVerifier";

// search_nearby の中で、Web の検索と取得だけを許した1回きりのエージェントに、会場の周りの店・寄り道と
// 行く日の営業を調べさせる（docs/spec/agent-runtime.md の「寄り道の調べ」）。
// 動かし方（開発環境から切り離す・WebFetch の宛先を確かめる・JSON の差し戻し）は確定前の再確認と同じ。
// 希望・予算・同行者・営業に合うかは、ツールの側でコードが決め直し（screenResearchedSpots）、出典は読んだページだけを残す。

const SpotSchema = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(NEARBY_KINDS),
  summary: z.string().trim().min(1).max(120),
  lat: LatLngSchema.shape.lat,
  lng: LatLngSchema.shape.lng,
  foods: z.array(z.enum(FOOD_WISHES)).max(FOOD_WISHES.length).default([]),
  dietaryOk: z.array(z.enum(DIETARY_NEEDS)).max(DIETARY_NEEDS.length).default([]),
  adultsOnly: z.boolean().default(false),
  pricePerPersonYen: z
    .tuple([z.number().int().min(0), z.number().int().min(0)])
    .refine(([min, max]) => min <= max)
    .nullable()
    .default(null),
  price: z.string().trim().min(1).max(60).nullable().default(null),
  hours: OpeningHoursSchema.nullable().default(null),
  closedDays: z.array(WeekdaySchema).max(7).nullable().default(null),
  openOnDate: z.enum(["open", "closed", "unconfirmed"]),
  sources: z.array(z.object({ url: z.string(), title: z.string().optional() })).max(3),
});

// 場所ごとに形を確かめ、形の合わない場所だけを捨てる（1か所の誤りで全体を捨てない）
const ReportSchema = z.object({ spots: z.array(z.unknown()).max(12) });

const ANSWER_FORMAT = [
  "## 返し方",
  "",
  "最後に、次の形の JSON を1つだけ返す。合う場所がなければ spots を空の配列にする。",
  "",
  '{"spots":[{"name":"場所の名前","kind":"food か sightseeing か rest","summary":"自分の言葉で1文の要約","lat":緯度,"lng":経度,' +
    '"foods":["出す料理の種類"],"dietaryOk":["対応するとページにある食事の制限"],"adultsOnly":false,' +
    '"pricePerPersonYen":[1人あたりの最低の円, 最高の円],"price":"料金の目安の文","hours":{"open":"HH:MM","close":"HH:MM","lastEntry":"HH:MM"},' +
    '"closedDays":["mon"],"openOnDate":"open か closed か unconfirmed","sources":[{"url":"読んだページの URL","title":"ページの題名"}]}]}',
  "",
  `- foods は ${FOOD_WISHES.join("・")} から、ページに書かれているものだけ`,
  `- dietaryOk は ${DIETARY_NEEDS.join("・")} から、対応するとページに書かれているものだけ。書かれていなければ空にする`,
  "- closedDays は mon・tue・wed・thu・fri・sat・sun。定休日がなければ空の配列、分からなければ null",
  "- hours は行く日の営業時間。分からなければ null。料金が分からなければ pricePerPersonYen と price は null",
  "- openOnDate は、行く日の曜日の定休日と、臨時休業・休業日の告知まで確かめて open。休みと分かれば closed。確かめきれなければ unconfirmed",
  "- lat・lng は、読んだページの地図や住所から分かる位置。分からない場所は入れない",
  "- sources には、WebFetch で実際に読んだページだけを入れる（検索結果に出ただけのページは入れない）",
  STRICT_JSON_RULES,
].join("\n");

/** 調べた結果をとっておく時間（営業の告知が変わりうるので短めにする） */
export const NEARBY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function parseSpots(items: unknown[], fetched: readonly string[]): ResearchedSpotReport[] {
  return items.flatMap((item) => {
    const parsed = SpotSchema.safeParse(item);
    if (!parsed.success) return [];
    const { lat, lng, sources, ...rest } = parsed.data;
    // 実際に読んでいないページは出典にしない。読んだページがなければ、調べたことにしない
    const unread = new Set(ungroundedSources(sources, fetched));
    const read = sources.filter((s) => !unread.has(s.url));
    if (read.length === 0) return [];
    return [{ ...rest, location: { lat, lng }, sources: read }];
  });
}

export function createWebNearbyResearcher(deps: {
  prompt: string;
  model?: string | undefined;
  cwd: string;
  env: Record<string, string>;
  query: QueryFn;
  resolveHost?: ResolveHost;
  maxBudgetUsd?: number | undefined;
  clock?: () => number;
}): NearbyResearcher {
  const systemPrompt = `${deps.prompt}\n\n${ANSWER_FORMAT}`;
  const clock = deps.clock ?? Date.now;
  const cache = new Map<string, { value: { spots: ResearchedSpotReport[] }; expiresAt: number }>();
  return {
    async research(input) {
      const { festival, date, signal } = input;
      const children = (input.party?.children ?? 0) + (input.party?.infants ?? 0);
      const key = JSON.stringify([
        festival.id,
        date,
        [...input.foodWishes].sort(),
        [...input.dietary].sort(),
        input.perPersonBudgetYen,
        children > 0,
      ]);
      const hit = cache.get(key);
      if (hit !== undefined && hit.expiresAt > clock()) return hit.value;

      const request = [
        `祭り：${festival.name}（${festival.place}）`,
        `会場：${festival.venue.name}（緯度 ${festival.venue.lat}、経度 ${festival.venue.lng}）`,
        `行く日：${formatMonthDayWithWeekday(date)}（${date}）`,
        `食べたいもの：${input.foodWishes.length > 0 ? input.foodWishes.map((w) => `${w}（${FOOD_WISH_LABELS[w]}）`).join("・") : "こだわらない"}`,
        ...(input.dietary.length > 0
          ? [
              `食事で気をつけたいこと：${input.dietary.map((d) => `${d}（${DIETARY_LABELS[d]}）`).join("・")}`,
            ]
          : []),
        ...(input.perPersonBudgetYen !== null
          ? [`旅の予算：1人あたり ${input.perPersonBudgetYen.toLocaleString("ja-JP")}円まで`]
          : []),
        `同行者：${children > 0 ? "子ども連れ" : "大人だけ（または不明）"}`,
        ...(input.references.length > 0
          ? [
              "",
              "参考：祭りのデータにある周辺の場所（営業と料理は、改めて確かめる）",
              ...input.references.map((r) => `- ${r.name}（${r.kind}）：${r.summary}`),
            ]
          : []),
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
                  "検索結果だけでは営業を確かめられません。店や施設のページを WebFetch で読んでから、決めた形の JSON で答えてください。",
                ),
              }
            : {}),
        });
      const started = Date.now();
      let costUsd = 0;
      let found = 0;
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
        // 1つもページを読んでいなければ、調べたことにしない（祭りのデータの場所に戻す）
        if (log.fetchedUrls.length === 0) return null;
        const value = { spots: parseSpots(parsed.value.spots, log.fetchedUrls) };
        found = value.spots.length;
        cache.set(key, { value, expiresAt: clock() + NEARBY_CACHE_TTL_MS });
        return value;
      } finally {
        signal.removeEventListener("abort", abort);
        // 費用・所要時間・調べた数だけを残す（店の名前や URL は残さない）
        console.info(
          JSON.stringify({
            kind: "nearby_research",
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
