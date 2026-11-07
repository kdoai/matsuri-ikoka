import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { CostMeter, remainingCostBudget, withCostMeter } from "./costMeter";
import type { QueryFn } from "./runner";
import { initMessage, MAX_TURNS, resultMessage } from "./testSdkMessages";
import { finalText } from "./webVerifier";

const result = (cost: number) =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "答え",
    total_cost_usd: cost,
  }) as unknown as SDKMessage;

function fakeQuery(cost: number) {
  const budgets: (number | undefined)[] = [];
  const query: QueryFn = ({ options }: { options: Options }) => {
    budgets.push(options.maxBudgetUsd);
    return (async function* () {
      yield result(cost);
    })();
  };
  return { query, budgets };
}

describe("CostMeter", () => {
  it("費用を足し、残りを返す。上限がなければ残りは null", () => {
    const limited = new CostMeter(1);
    limited.add(0.25);
    limited.add(-1);
    limited.add(Number.NaN);

    expect(limited.usd).toBe(0.25);
    expect(limited.remainingUsd).toBe(0.75);
    expect(new CostMeter().remainingUsd).toBeNull();
  });

  it("測る先の文脈の外では、残りは null", () => {
    expect(remainingCostBudget()).toBeNull();
    expect(withCostMeter(new CostMeter(0.5), () => remainingCostBudget())).toBe(0.5);
  });
});

describe("finalText の費用の上限", () => {
  it("測る先がなければ、渡された上限のまま動かす", async () => {
    const { query, budgets } = fakeQuery(0.1);

    await finalText(query, "問い", { maxBudgetUsd: 0.5 });

    expect(budgets).toEqual([0.5]);
  });

  it("今日の残りのほうが小さければ、残りを上限にし、費用を足す", async () => {
    const { query, budgets } = fakeQuery(0.1);
    const meter = new CostMeter(0.2);

    const reply = await withCostMeter(meter, () => finalText(query, "問い", { maxBudgetUsd: 0.5 }));

    expect(reply.text).toBe("答え");
    expect(budgets).toEqual([0.2]);
    expect(meter.usd).toBeCloseTo(0.1);
  });

  it("上限の指定がなくても、今日の残りで抑える", async () => {
    const { query, budgets } = fakeQuery(0);

    await withCostMeter(new CostMeter(0.3), () => finalText(query, "問い", {}));

    expect(budgets).toEqual([0.3]);
  });

  it("今日の残りがなければ、呼ばずに結果なしで返す", async () => {
    const query = vi.fn<QueryFn>();
    const meter = new CostMeter(0.1);
    meter.add(0.1);

    const reply = await withCostMeter(meter, () => finalText(query, "問い", {}));

    expect(reply).toEqual({ text: null, costUsd: 0, salvage: null });
    expect(query).not.toHaveBeenCalled();
  });
});

describe("finalText のターンの上限の救い", () => {
  /** 1回目はターンの上限で終わり（累計 0.3）、続けた2回目で答える（累計 0.4）偽物の query */
  function salvagedQuery() {
    const options: Options[] = [];
    const query: QueryFn = (params) => {
      options.push(params.options);
      const first = options.length === 1;
      return (async function* () {
        yield initMessage("session-1");
        yield first ? resultMessage(MAX_TURNS, 0.3) : resultMessage("答え", 0.4);
      })();
    };
    return { query, options };
  }

  it("道具を使う呼び出しがターンの上限で終わったら、同じセッションを道具なしで1ターン続け、続けた分の費用だけを足す", async () => {
    const { query, options } = salvagedQuery();
    const forgotten: string[] = [];
    const meter = new CostMeter(1);

    const reply = await withCostMeter(meter, () =>
      finalText(query, "問い", { tools: ["WebFetch"], persistSession: true }, undefined, (id) => {
        forgotten.push(id);
      }),
    );

    expect(reply.text).toBe("答え");
    expect(reply.costUsd).toBeCloseTo(0.4);
    expect(reply.salvage?.costUsd).toBeCloseTo(0.1);
    expect(meter.usd).toBeCloseTo(0.4);
    expect(options[1]).toMatchObject({
      resume: "session-1",
      tools: [],
      allowedTools: [],
      maxTurns: 1,
    });
    // 会話を残した呼び出しの記録は、救いを終えたら消す
    expect(forgotten).toEqual(["session-1"]);
  });

  it("道具のない呼び出しは、ターンの上限で終わっても続けない", async () => {
    const { query, options } = salvagedQuery();

    const reply = await finalText(query, "問い", { tools: [] });

    expect(reply).toMatchObject({ text: null, salvage: null });
    expect(options).toHaveLength(1);
  });
});
