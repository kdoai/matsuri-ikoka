import { describe, expect, it } from "vitest";
import { newTurnState, type TurnState } from "../tools/context";
import { nextStage } from "./runner";

const turn = (overrides: Partial<TurnState> = {}): TurnState => ({
  ...newTurnState(),
  ...overrides,
});

// docs/spec/agents.md の「会話の流れ」
describe("nextStage", () => {
  it("祭りを探したら候補へ", () => {
    expect(nextStage("hearing", turn({ searched: true }), false)).toBe("candidates");
  });

  it("旅程を保存したら旅程の案へ（修正のあとも）", () => {
    expect(nextStage("candidates", turn({ savedItinerary: true }), true)).toBe("itinerary");
    expect(nextStage("revising", turn({ savedItinerary: true }), true)).toBe("itinerary");
  });

  it("旅程係が動いたのに保存できなければ修正のまま", () => {
    expect(nextStage("itinerary", turn({ startedStaff: new Set(["planner"]) }), true)).toBe(
      "revising",
    );
  });

  it("再確認：予定どおり・要事前確認ならしおり、変更・中止・情報が見つからなければ候補へ戻る", () => {
    expect(nextStage("itinerary", turn({ verification: "as_planned" }), true)).toBe("shiori");
    expect(nextStage("itinerary", turn({ verification: "cancelled" }), true)).toBe("candidates");
    expect(nextStage("itinerary", turn({ verification: "changed" }), true)).toBe("candidates");
    expect(nextStage("itinerary", turn({ verification: "needs_check" }), true)).toBe("shiori");
    expect(nextStage("itinerary", turn({ verification: "not_found" }), true)).toBe("candidates");
  });

  it("何も調べなければ状態は変わらない", () => {
    expect(nextStage("hearing", turn(), false)).toBe("hearing");
    expect(nextStage("itinerary", turn(), true)).toBe("itinerary");
  });
});
