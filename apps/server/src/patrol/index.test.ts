import { describe, expect, it } from "vitest";
import { createFestivalStore } from "../data/festivalStore";
import { createUnavailableLodging } from "../tools/lodging";
import { createPatrolDeps } from "./index";
import { MemoryPatrolStore } from "./store";

// 見回りの部品の組み立て。API には出ない。鍵の値はテストのためだけのもの。

const input = {
  db: null,
  festivals: createFestivalStore([]),
  lodging: createUnavailableLodging(),
};

describe("createPatrolDeps", () => {
  it("設定がなければ用意しない。見回りの入口だけが断り、サーバーは起動する", async () => {
    expect(await createPatrolDeps({ ...input, env: {} })).toBeNull();
  });

  it("鍵があれば、部品をそろえる", async () => {
    const deps = await createPatrolDeps({
      ...input,
      env: { PATROL_ANTHROPIC_API_KEY: "test-only-not-a-real-key" },
    });

    expect(deps?.store).toBeInstanceOf(MemoryPatrolStore);
    expect(deps?.config.sessionBudgetCents).toBe(200);
    expect(deps?.agent).toBeDefined();
  });
});
