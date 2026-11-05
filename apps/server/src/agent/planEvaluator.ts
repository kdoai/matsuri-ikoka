import {
  buildJsonRetryPrompt,
  parseJsonWithSchema,
  STRICT_JSON_RULES,
} from "@matsuri-ikoka/agent-kit";
import { EVALUATION_CRITERIA, type Itinerary, RESEARCH_TARGETS } from "@matsuri-ikoka/schema";
import { z } from "zod";
import type { ModelScore, PlanEvaluationRequest, PlanEvaluator } from "../tools/planEvaluator";
import type { QueryFn } from "./runner";
import { buildVerifierOptions, finalText } from "./webVerifier";

// update_itinerary の中で、道具を持たない1回きりのエージェント（評価係）に、保存した旅程を観点ごとに採点させる
// （docs/spec/agent-runtime.md の「旅程の評価」）。動かし方（開発環境から切り離す・JSON の差し戻し）は確定前の再確認と同じ。
// 返す点は信用しない入力として、合否と調べ直しの頼みはコードで決める（domain/planEvaluation.ts）。

const AnswerSchema = z.object({
  scores: z
    .array(
      z.object({
        criterion: z.enum(EVALUATION_CRITERIA),
        rating: z.number().int().min(1).max(5),
        findings: z.array(z.string().trim().min(1).max(120)).max(5),
        targets: z.array(z.enum(RESEARCH_TARGETS)).max(RESEARCH_TARGETS.length),
      }),
    )
    .min(1)
    .max(EVALUATION_CRITERIA.length),
});

const ANSWER_FORMAT = [
  "## 返し方",
  "",
  "最後に、次の形の JSON を1つだけ返す。",
  "",
  '{"scores":[{"criterion":"coverage","rating":1から5,"findings":["足りない点を1文で"],"targets":["route"]}]}',
  "",
  `- criterion は ${EVALUATION_CRITERIA.join("・")} の4つを1つずつ`,
  "- rating は 5 十分 / 4 ほぼ十分 / 3 足りないところがある / 2 大きく足りない / 1 使えない",
  "- findings は点を下げた理由を、旅程の予定の名前を挙げて1文ずつ（5つまで）。満点なら空の配列",
  `- targets は、足りない点を調べ直すと直る係（${RESEARCH_TARGETS.join("・")}）。調べ直しで直らない（旅程係が書けば直る）なら空の配列`,
  STRICT_JSON_RULES,
].join("\n");

/** 評価係に渡す旅程。採点に要るものだけにして、文を短くする */
export function itineraryForReview(itinerary: Itinerary) {
  return {
    title: itinerary.title,
    origin: itinerary.origin,
    returnTo: itinerary.returnTo,
    party: itinerary.party,
    days: itinerary.days.map((day) => ({
      date: day.date,
      stay: day.stay === null ? null : day.stay.area,
      items: day.items.map((item) => ({
        id: item.id,
        time: `${item.start}-${item.end}`,
        type: item.type,
        name: item.name,
        reason: item.reason,
        move: item.move,
        hours: item.hours,
        cost: item.cost,
        sources: item.sources.length,
      })),
      meals: day.meals ?? [],
      lastReturn: day.lastReturn ?? null,
    })),
    considered: itinerary.considered ?? [],
  };
}

export function createPlanEvaluator(deps: {
  prompt: string;
  model?: string | undefined;
  cwd: string;
  env: Record<string, string>;
  query: QueryFn;
  maxBudgetUsd?: number | undefined;
}): PlanEvaluator {
  const systemPrompt = `${deps.prompt}\n\n${ANSWER_FORMAT}`;
  return {
    async evaluate(input: PlanEvaluationRequest): Promise<ModelScore[] | null> {
      const { signal } = input;
      const request = [
        "<聞き取った条件>",
        input.conditions,
        "</聞き取った条件>",
        "<旅程>",
        JSON.stringify(itineraryForReview(input.itinerary)),
        "</旅程>",
        "<点検の結果>",
        JSON.stringify({ gaps: input.gaps, scores: input.codeScores }),
        "</点検の結果>",
      ].join("\n");
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      if (signal.aborted) abort();
      signal.addEventListener("abort", abort, { once: true });
      const options = buildVerifierOptions({
        systemPrompt,
        model: deps.model,
        cwd: deps.cwd,
        env: deps.env,
        abortController: controller,
        maxBudgetUsd: deps.maxBudgetUsd,
        withTools: false,
        // 長い旅程を見比べて足りないところを探すので、浅く速くではなく、よく考えさせる
        effort: "medium",
      });
      const started = Date.now();
      let costUsd = 0;
      let ok = false;
      const ask = async (prompt: string) => {
        const reply = await finalText(deps.query, prompt, options);
        costUsd += reply.costUsd;
        return reply.text;
      };
      try {
        const answer = await ask(request);
        if (answer === null) return null;
        let parsed = parseJsonWithSchema(answer, AnswerSchema, "object");
        if (!parsed.ok) {
          const failure =
            parsed.reason === "parse"
              ? { reason: "parse" as const, error: parsed.error }
              : { reason: "shape" as const, issues: parsed.issues };
          const retry = await ask(
            buildJsonRetryPrompt({ previous: answer, failure, shape: "object" }),
          );
          if (retry === null) return null;
          parsed = parseJsonWithSchema(retry, AnswerSchema, "object");
          if (!parsed.ok) return null;
        }
        ok = true;
        // 同じ観点が2つあれば、先のものを使う
        const seen = new Set<string>();
        return parsed.value.scores.filter((score) => {
          if (seen.has(score.criterion)) return false;
          seen.add(score.criterion);
          return true;
        });
      } finally {
        signal.removeEventListener("abort", abort);
        // 費用・所要時間・成否だけを残す（旅程の中身は残さない）
        console.info(
          JSON.stringify({
            kind: "plan_evaluator",
            ok,
            totalCostUsd: costUsd,
            elapsedMs: Date.now() - started,
          }),
        );
      }
    },
  };
}
