import { describe, expect, it } from "vitest";
import { ChatRequestSchema } from "./api";
import {
  AnchorPlanRequestSchema,
  FestivalSearchNextSchema,
  FestivalSearchRequestSchema,
  FestivalSearchResponseSchema,
  MAX_FESTIVAL_RESULTS,
} from "./festivalSearch";
import { fictionalCandidate } from "./testing";

const conditions = { kinds: [], season: null, prefectures: [] };

describe("祭りから探す条件", () => {
  it("種類も季節も地域もおまかせで探せ、出さない祭りは省略できる", () => {
    const parsed = FestivalSearchRequestSchema.parse({ sessionId: "s", ...conditions });
    expect(parsed.excludeIds).toEqual([]);
  });

  it("都道府県の名前でない地域と、決まっていない種類は受け付けない", () => {
    const base = { sessionId: "s", ...conditions };
    expect(FestivalSearchRequestSchema.safeParse({ ...base, prefectures: ["北陸"] }).success).toBe(
      false,
    );
    expect(FestivalSearchRequestSchema.safeParse({ ...base, kinds: ["night"] }).success).toBe(
      false,
    );
  });

  it("自由記述は上限より長いと受け付けない", () => {
    const base = { sessionId: "s", ...conditions };
    expect(FestivalSearchRequestSchema.safeParse({ ...base, wish: "あ".repeat(201) }).success).toBe(
      false,
    );
  });
});

describe("祭りから探した結果", () => {
  const result = {
    candidate: fictionalCandidate(),
    matchedKinds: ["traditional"],
    reasons: ["国の重要無形民俗文化財です"],
    wishFit: null,
  };

  it("一度に出す祭りは上限まで", () => {
    const response = { remaining: 0, nearMatches: [], next: [], reading: null };
    expect(
      FestivalSearchResponseSchema.safeParse({
        ...response,
        results: Array(MAX_FESTIVAL_RESULTS).fill(result),
      }).success,
    ).toBe(true);
    expect(
      FestivalSearchResponseSchema.safeParse({
        ...response,
        results: Array(MAX_FESTIVAL_RESULTS + 1).fill(result),
      }).success,
    ).toBe(false);
  });

  it("条件を選び直す手だけが、変える条件を持たない", () => {
    const edit = { kind: "edit_conditions", label: "条件を選び直す", found: null };
    expect(FestivalSearchNextSchema.safeParse({ ...edit, conditions: null }).success).toBe(true);
    expect(FestivalSearchNextSchema.safeParse({ ...edit, conditions }).success).toBe(false);
    expect(
      FestivalSearchNextSchema.safeParse({
        kind: "nationwide",
        label: "全国から探す",
        conditions: null,
        found: 3,
      }).success,
    ).toBe(false);
  });
});

describe("祭りを決めたあとの旅程", () => {
  const anchor = { festivalId: "suzunari-matsuri", date: "2026-08-15" };

  it("発言に、必ず行く祭りを添えられる", () => {
    const preferences = { party: "adults", spot: "auto", food: "stalls", move: "train" };
    const parsed = ChatRequestSchema.parse({
      sessionId: "s",
      message: "組んで",
      preferences,
      anchor,
    });
    expect(parsed.anchor).toEqual(anchor);
  });

  it("寄りたい場所は上限まで", () => {
    const base = { sessionId: "s", anchor, origin: "鈴鳴駅", nights: 2 };
    expect(AnchorPlanRequestSchema.safeParse({ ...base, wishes: ["A", "B"] }).success).toBe(true);
    expect(AnchorPlanRequestSchema.safeParse({ ...base, wishes: Array(6).fill("A") }).success).toBe(
      false,
    );
  });
});
