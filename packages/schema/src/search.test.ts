import { describe, expect, it } from "vitest";
import { ChatRequestSchema } from "./api";
import { SearchOutcomeSchema } from "./events";
import { SearchRetrySchema, SearchSuggestionSchema } from "./search";

const later = {
  kind: "later_dates",
  label: "次の週末（8月22日〜8月23日）で探す",
  retry: { when: { kind: "range", from: "2026-08-22", to: "2026-08-23" } },
  message: "日程を8月22日〜8月23日に変えて、もう一度祭りを探してください。",
  found: 2,
} as const;

describe("次の手", () => {
  it("探し直す手は、変える条件と送る発言を持つ", () => {
    expect(SearchSuggestionSchema.parse(later)).toEqual(later);
  });

  it("条件を選び直す手だけが、変える条件と発言を持たない", () => {
    const edit = {
      kind: "edit_conditions",
      label: "条件を選び直す",
      retry: null,
      message: null,
      found: null,
    };
    expect(SearchSuggestionSchema.safeParse(edit).success).toBe(true);
    expect(SearchSuggestionSchema.safeParse({ ...later, retry: null }).success).toBe(false);
    expect(SearchSuggestionSchema.safeParse({ ...edit, retry: later.retry }).success).toBe(false);
  });

  it("変える条件は1つ以上", () => {
    expect(SearchRetrySchema.safeParse({}).success).toBe(false);
    expect(SearchRetrySchema.safeParse({ maxTravelMinutes: 240 }).success).toBe(true);
    expect(SearchRetrySchema.safeParse({ maxTravelMinutes: 900 }).success).toBe(false);
  });
});

describe("条件の検査の結果", () => {
  it("見つからなかったことと、外れた数・次の手を持つ", () => {
    const outcome = {
      status: "none",
      excluded: { date: 1, travel: 2, area: 0 },
      nearMisses: [],
      suggestions: [later],
      attempts: 4,
    };
    expect(SearchOutcomeSchema.parse(outcome)).toEqual(outcome);
    expect(SearchOutcomeSchema.safeParse({ ...outcome, attempts: 0 }).success).toBe(false);
  });

  it("発言の本文に、次の手の条件を添えられる", () => {
    const request = {
      sessionId: "s-abcdefghijklmnop",
      message: later.message,
      preferences: { party: "adults", spot: "auto", food: "stalls", move: "train" },
      search: later.retry,
    };
    expect(ChatRequestSchema.safeParse(request).success).toBe(true);
  });
});
