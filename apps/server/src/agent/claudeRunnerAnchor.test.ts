import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_PREFERENCES, type VerificationResult } from "@matsuri-ikoka/schema";
import { describe, expect, it } from "vitest";
import { createFestivalStore } from "../data/festivalStore";
import { testFestival } from "../domain/testFestivals";
import { ItineraryStore, SessionStore } from "../session/sessionStore";
import { createUnavailableLodging } from "../tools/lodging";
import { unavailableVerifier } from "../tools/verifier";
import { ClaudeAgentRunner } from "./claudeRunner";
import type { AgentPrompts } from "./prompts";

// 祭りを固定した旅程で、モデルを呼ぶ前に開催を確かめること。祭りは架空。

const ANCHOR = { festivalId: "suzunari-toro", date: "2026-08-16" };

async function runWith(result: VerificationResult) {
  const prompts: string[] = [];
  const runner = new ClaudeAgentRunner({
    festivals: createFestivalStore([testFestival({ id: "suzunari-toro" })]),
    itineraries: new ItineraryStore(),
    weather: { forecast: async () => ({ weather: { status: "not_yet" }, area: null }) },
    lodging: createUnavailableLodging(),
    verifier: unavailableVerifier,
    candidateChecks: {
      check: async ({ date }) => ({
        festivalId: ANCHOR.festivalId,
        date,
        checkedAt: "2026-08-03T10:00:00+09:00",
        cached: false,
        result,
        sources: [],
      }),
    },
    prompts: { concierge: "", researcher: "", scout: "", planner: "" } as AgentPrompts,
    models: {},
    cwd: "/tmp/matsuri-agent-test",
    env: {},
    today: () => "2026-08-03",
    now: () => "2026-08-03T10:00:00+09:00",
    query: (params) => {
      prompts.push(params.prompt);
      return (async function* () {
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-1",
        } as unknown as SDKMessage;
      })();
    },
  });
  const session = new SessionStore().create();
  session.anchor = ANCHOR;
  session.selectedFestivalId = ANCHOR.festivalId;
  await runner.runTurn(
    {
      session,
      message: "この祭りで旅を作ってください",
      preferences: DEFAULT_PREFERENCES,
      signal: new AbortController().signal,
    },
    () => {},
  );
  return { session, prompt: prompts[0] ?? "" };
}

describe("ClaudeAgentRunner（祭りを固定した旅程）", () => {
  it("中止と分かったら、店の記録で伝えて結果へ戻す", async () => {
    const { session, prompt } = await runWith("cancelled");

    expect(prompt).toContain("中止と分かった祭り");
    expect(prompt).not.toContain("必ず行く祭り：");
    expect(session.anchor).toBeNull();
    expect(session.stage).toBe("candidates");
  });

  it("開催が確かめられたら、固定のまま店の記録に載せる", async () => {
    const { session, prompt } = await runWith("as_planned");

    expect(prompt).toContain("必ず行く祭り：");
    expect(session.anchor).toEqual(ANCHOR);
    expect(session.stage).toBe("hearing");
  });
});
