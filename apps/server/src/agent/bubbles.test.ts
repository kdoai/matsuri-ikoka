import { DEFAULT_PREFERENCES } from "@matsuri-ikoka/schema";
import { describe, expect, it } from "vitest";
import { staffOf, staffStartBubble, toolEndBubble, toolStartBubble } from "./bubbles";

const state = { preferences: { ...DEFAULT_PREFERENCES }, hasItinerary: false };

describe("吹き出し（docs/spec/api.md の例）", () => {
  it("サブエージェントの開始", () => {
    expect(staffStartBubble("researcher", { hasItinerary: false })).toBe("調べてきますね");
    expect(staffStartBubble("planner", { hasItinerary: false })).toBe("道のりを調べます");
    expect(staffStartBubble("planner", { hasItinerary: true })).toBe("組み直します");
  });

  it("search_festivals の前は、希望日と出発地から作る", () => {
    expect(
      toolStartBubble(
        "search_festivals",
        { when: { kind: "date", date: "2026-08-16" }, origin: "みなと中央駅", nights: 0 },
        state,
      ),
    ).toBe("8月16日に、みなと中央駅から日帰りで行ける祭りを探しています");
    expect(
      toolStartBubble(
        "search_festivals",
        {
          when: { kind: "range", from: "2026-08-15", to: "2026-08-16" },
          origin: "みなと中央駅",
          nights: 2,
        },
        state,
      ),
    ).toBe("8月15日から8月16日に、みなと中央駅から2泊で行ける祭りを探しています");
  });

  it("入力の形が崩れていても、決まった文に戻す", () => {
    expect(toolStartBubble("search_festivals", { when: "あした" }, state)).toBe(
      "条件に合う祭りを探しています",
    );
    expect(toolStartBubble("get_weather", null, state)).toBe("当日の天気を確かめています");
  });

  it("search_nearby の前は、こだわりから探すものを言う", () => {
    expect(toolStartBubble("search_nearby", {}, state)).toBe(
      "会場の近くで、寄れる場所を探しています",
    );
    expect(
      toolStartBubble(
        "search_nearby",
        { preferences: { party: "adults", spot: "hidden", food: "local", move: "train" } },
        state,
      ),
    ).toBe("会場の近くで、地元の味と人の少ない場所を探しています");
  });

  it("get_access・get_weather・update_itinerary・verify_festival の前", () => {
    expect(toolStartBubble("get_access", {}, state)).toBe("電車の所要時間を確かめています");
    expect(toolStartBubble("get_access", { move: "car" }, state)).toBe(
      "車の道のりと駐車場を確かめています",
    );
    expect(toolStartBubble("get_weather", { date: "2026-08-16" }, state)).toBe(
      "8月16日の天気を確かめています",
    );
    expect(toolStartBubble("update_itinerary", {}, state)).toBe("旅程を書き込んでいます");
    expect(toolStartBubble("update_itinerary", {}, { ...state, hasItinerary: true })).toBe(
      "旅程を書き直しています",
    );
    expect(toolStartBubble("verify_festival", {}, state)).toBe(
      "開催予定を公式情報で確かめています",
    );
  });

  it("ツールの後は結果の件数", () => {
    expect(toolEndBubble("search_festivals", { candidates: [{}, {}, {}] })).toEqual({
      ok: true,
      bubble: "3件見つかりました",
      count: 3,
    });
    expect(toolEndBubble("search_nearby", { spots: [{}, {}, {}, {}] })).toEqual({
      ok: true,
      bubble: "4か所見つかりました",
      count: 4,
    });
    expect(toolEndBubble("get_weather", { weather: { status: "not_yet" } }).bubble).toBe(
      "まだ予報が出ていない日でした",
    );
    expect(
      toolEndBubble("update_itinerary", { saved: true, diff: { fromVersion: 0 } }).bubble,
    ).toBe("旅程ができました");
    expect(
      toolEndBubble("update_itinerary", { saved: true, diff: { fromVersion: 1 } }).bubble,
    ).toBe("旅程を直しました");
    expect(toolEndBubble("update_itinerary", { saved: false, errors: [{}] }).ok).toBe(false);
    expect(
      toolEndBubble("verify_festival", {
        result: "as_planned",
        sources: [{ url: "https://example.com/a", confidence: "official" }],
      }).bubble,
    ).toBe("開催予定を公式情報で確認しました");
    // 公式の出典がなければ「公式情報で」とは言わない
    expect(
      toolEndBubble("verify_festival", {
        result: "as_planned",
        sources: [{ url: "https://example.net/a", confidence: "single" }],
      }).bubble,
    ).toBe("開催予定を確かめました");
    expect(toolEndBubble("get_access", null)).toEqual({
      ok: false,
      bubble: "うまく調べられませんでした",
      count: null,
    });
  });
});

describe("staffOf", () => {
  it("本体はコンシェルジュ、サブエージェントは名前のスタッフ、それ以外は null", () => {
    expect(staffOf(undefined)).toBe("concierge");
    expect(staffOf("planner")).toBe("planner");
    expect(staffOf("general-purpose")).toBeNull();
  });
});
