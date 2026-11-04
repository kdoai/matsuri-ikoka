import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { fictionalPlannedItinerary } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { createPlanEvaluator, itineraryForReview } from "./planEvaluator";
import type { QueryFn } from "./runner";

// Agent SDK の代わりに、決まった返答を返す偽物の query で確かめる。旅程は架空

function setup(replies: (string | null)[]) {
  const calls: { prompt: string; options: Options }[] = [];
  const query: QueryFn = (params) => {
    calls.push(params);
    const text = replies[calls.length - 1];
    return (async function* () {
      yield {
        type: "result",
        subtype: text === null ? "error_during_execution" : "success",
        is_error: text === null,
        result: text ?? "",
        total_cost_usd: 0.01,
      } as unknown as SDKMessage;
    })();
  };
  const evaluator = createPlanEvaluator({
    prompt: "評価係",
    model: "model-e",
    cwd: "/tmp/agent",
    env: {},
    query,
  });
  return { calls, evaluator };
}

const request = () => ({
  itinerary: fictionalPlannedItinerary(),
  gaps: [],
  codeScores: [],
  conditions: "{}",
  signal: new AbortController().signal,
});

const answer = JSON.stringify({
  scores: [
    { criterion: "coverage", rating: 5, findings: [], targets: [] },
    {
      criterion: "specificity",
      rating: 3,
      findings: ["帰りの乗り換えの待ちが分からない"],
      targets: ["route"],
    },
    { criterion: "specificity", rating: 1, findings: ["重複"], targets: [] },
  ],
});

describe("createPlanEvaluator", () => {
  it("道具を持たずに1回で採点させ、評価係のモデルとよく考える深さで動かす", async () => {
    const { calls, evaluator } = setup([answer]);

    const scores = await evaluator.evaluate(request());

    expect(scores).toEqual([
      { criterion: "coverage", rating: 5, findings: [], targets: [] },
      {
        criterion: "specificity",
        rating: 3,
        findings: ["帰りの乗り換えの待ちが分からない"],
        targets: ["route"],
      },
    ]);
    const options = calls[0]!.options;
    expect(options).toMatchObject({ model: "model-e", tools: [], maxTurns: 1, effort: "medium" });
    expect(options.settingSources).toEqual([]);
    expect(calls[0]!.prompt).toContain("<旅程>");
    expect(calls[0]!.prompt).toContain("<点検の結果>");
  });

  it("JSON を取り出せなければ1回だけ差し戻し、それでもだめなら null", async () => {
    const retried = setup(["点はよいと思います", answer]);
    expect(await retried.evaluator.evaluate(request())).toHaveLength(2);
    expect(retried.calls).toHaveLength(2);

    const failed = setup(["だめ", "まだだめ"]);
    expect(await failed.evaluator.evaluate(request())).toBeNull();
  });

  it("失敗の結果なら null（点検の点だけで決める）", async () => {
    const { evaluator } = setup([null]);
    expect(await evaluator.evaluate(request())).toBeNull();
  });

  it("評価係に渡す旅程は、出典を数だけにして短くする", () => {
    const view = itineraryForReview(fictionalPlannedItinerary());
    expect(view.days[0]?.items[0]).toMatchObject({ id: "go", time: "14:30-15:20", sources: 1 });
    expect(view.days[0]?.lastReturn).toMatchObject({ station: "鈴鳴駅", departBy: "22:40" });
  });
});
