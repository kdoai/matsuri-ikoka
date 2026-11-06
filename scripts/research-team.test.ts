import { describe, expect, it } from "vitest";
import { FestivalSchema } from "../packages/schema/src";
import { fictionalFestival } from "../packages/schema/src/testing";
import {
  centsOf,
  leadAgent,
  RESEARCH_ENVIRONMENT,
  readerAgent,
  researchBrief,
  researchDeployment,
  reviewerAgent,
} from "./research-team";

function enabledTools(agent: { tools: readonly { configs: readonly { name: string }[] }[] }) {
  return agent.tools.flatMap((toolset) => toolset.configs.map((config) => config.name)).sort();
}

describe("エージェントの道具", () => {
  it("ページを読む役は、Web と読み取りだけで書き込めない", () => {
    for (const agent of [readerAgent("model-a", "skill"), reviewerAgent("model-a", "skill")]) {
      expect(enabledTools(agent)).toEqual(["read", "web_fetch", "web_search"]);
      expect(agent.tools[0]?.default_config.enabled).toBe(false);
    }
  });

  it("結果を書く役は、Web を読めない", () => {
    const lead = leadAgent("model-b", "agent_reader", "agent_reviewer");
    expect(enabledTools(lead)).toEqual(["read", "write"]);
    expect(lead.tools[0]?.default_config.enabled).toBe(false);
  });

  it("コマンドを実行できるエージェントはない", () => {
    const agents = [
      readerAgent("m", "s"),
      reviewerAgent("m", "s"),
      leadAgent("m", "reader", "reviewer"),
    ];
    for (const agent of agents) expect(enabledTools(agent)).not.toContain("bash");
  });

  it("リードは決めたエージェントだけに任せる", () => {
    const { multiagent } = leadAgent("m", "reader", "reviewer");
    for (const member of [multiagent.subagents, multiagent.workflows]) {
      expect(member.predefined_agents).toEqual(["reader", "reviewer"]);
      expect(member.inline_agents).toEqual({ type: "disabled" });
    }
  });

  it("モデル名は渡された値を使う", () => {
    expect(readerAgent("model-a", "s").model).toBe("model-a");
    expect(leadAgent("model-b", "r", "v").model).toBe("model-b");
  });
});

describe("researchDeployment", () => {
  const deployment = researchDeployment({
    leadId: "agent_lead",
    environmentId: "env_1",
    storeId: "memstore_1",
    budgetCents: "3000",
  });

  it("調査リストは読み取り専用で付ける", () => {
    expect(deployment.resources[0]).toMatchObject({
      type: "memory_store",
      memory_store_id: "memstore_1",
      access: "read_only",
    });
  });

  it("秘密の値を持つ資源を付けない", () => {
    expect(deployment.resources.map((resource) => resource.type)).toEqual(["memory_store"]);
    expect(deployment).not.toHaveProperty("vault_ids");
  });

  it("週に1回、日本時間で起動し、費用の上限を付ける", () => {
    expect(deployment.schedule).toEqual({
      type: "cron",
      expression: "0 6 * * 1",
      timezone: "Asia/Tokyo",
    });
    expect(deployment.budget.max_list_cost).toEqual({ amount: "3000", currency: "USD" });
  });

  it("採点の基準つきの成果物として起動する", () => {
    expect(deployment.initial_events[0]?.type).toBe("user.define_outcome");
  });
});

describe("RESEARCH_ENVIRONMENT", () => {
  it("クラウドの環境で動かす", () => {
    expect(RESEARCH_ENVIRONMENT.config.type).toBe("cloud");
  });
});

describe("centsOf", () => {
  it.each([
    ["30.00", "3000"],
    ["2", "200"],
    ["1.5", "150"],
  ])("%s は %s セント", (usd, cents) => {
    expect(centsOf(usd)).toBe(cents);
  });

  it.each(["0", "abc", "1.234", ""])("%s は読まない", (usd) => {
    expect(centsOf(usd)).toBeNull();
  });
});

describe("researchBrief", () => {
  it("名前と場所と開催回と出典だけを渡し、ほかの文章は渡さない", () => {
    const festival = FestivalSchema.parse(fictionalFestival());
    const brief = researchBrief(
      festival,
      { id: festival.id, reasons: ["due_soon"], nextDate: "2026-08-16", notes: [] },
      "2026-08-01",
    );
    expect(brief).toMatchObject({
      id: festival.id,
      occurrenceDate: "2026-08-16",
      estimatedDate: false,
      reasons: ["due_soon"],
    });
    expect(brief).not.toHaveProperty("etiquette");
    expect(brief).not.toHaveProperty("trivia");
    expect(brief.knownSources.length).toBeGreaterThan(0);
  });
});
