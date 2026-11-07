import { DEFAULT_PREFERENCES, REDO_SUBJECTS, SseEventSchema } from "@matsuri-ikoka/schema";
import { describe, expect, it } from "vitest";
import {
  formatMinuteRange,
  plainName,
  redoEvent,
  redoLines,
  staffOf,
  staffStartBubble,
  toolEndBubble,
  toolStartBubble,
} from "./bubbles";

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
          when: { kind: "date", date: "2026-08-16" },
          origin: "みなと中央駅",
          nights: 0,
          maxTravelMinutes: 120,
        },
        state,
      ),
    ).toBe("8月16日に、みなと中央駅から片道2時間以内の日帰りで行ける祭りを探しています");
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

  it("search_festivals の前は、行き先と広げた段階も言う", () => {
    const base = { when: { kind: "date", date: "2026-08-16" }, origin: "みなと中央駅", nights: 1 };
    expect(toolStartBubble("search_festivals", { ...base, destinations: ["北陸"] }, state)).toBe(
      "8月16日に、北陸で、みなと中央駅から1泊で行ける祭りを探しています",
    );
    expect(toolStartBubble("search_festivals", { ...base, widen: "neighbor" }, state)).toBe(
      "8月16日に、隣の県まで広げて、みなと中央駅から1泊で行ける祭りを探しています",
    );
    expect(toolStartBubble("search_festivals", { ...base, widen: "nationwide" }, state)).toBe(
      "8月16日に、日本全国で、みなと中央駅から1泊で行ける祭りを探しています",
    );
  });

  it("search_festivals の後、条件に合う祭りがなければ、見つからなかったと言う", () => {
    expect(
      toolEndBubble("search_festivals", { candidates: [], search: { status: "none" } }),
    ).toMatchObject({ ok: true, bubble: "条件に合う祭りが見つかりませんでした", count: 0 });
  });

  it("search_festivals の後は、行き先を広げる前の確認と、広げた段階を言う", () => {
    expect(
      toolEndBubble("search_festivals", {
        candidates: [],
        destination: { needsConsent: "neighbor" },
      }),
    ).toMatchObject({
      ok: true,
      bubble: "選んだ地域には見つかりませんでした。隣の県にはあります",
      detail: expect.stringContaining("隣の県まで広げて探してよいか"),
      count: 0,
    });
    expect(
      toolEndBubble("search_festivals", {
        candidates: [],
        destination: { needsConsent: "nationwide" },
      }).bubble,
    ).toBe("選んだ地域と隣の県には見つかりませんでした");
    expect(
      toolEndBubble("search_festivals", {
        candidates: [{}, {}],
        destination: { stage: "neighbor", needsConsent: null },
      }).bubble,
    ).toBe("隣の県で2件見つかりました");
    expect(
      toolEndBubble("search_festivals", {
        candidates: [{}],
        destination: { stage: "nationwide", needsConsent: null },
      }).bubble,
    ).toBe("日本全国から1件選びました");
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
    expect(toolStartBubble("verify_festival", {}, state)).toBe("旅程を確定しています");
  });

  it("ツールの後は結果の件数", () => {
    expect(toolEndBubble("search_festivals", { candidates: [{}, {}, {}] })).toMatchObject({
      ok: true,
      bubble: "3件見つかりました",
      count: 3,
    });
    // 種類の分からない場所しかなければ、数だけを言う
    expect(toolEndBubble("search_nearby", { spots: [{}, {}, {}, {}] })).toMatchObject({
      ok: true,
      bubble: "4か所見つけました",
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
    // 候補を出す前に確かめた結果で確定したときは、調べ直したとは言わない
    expect(
      toolEndBubble("verify_festival", {
        result: "as_planned",
        reused: true,
        sources: [{ url: "https://example.com/a", confidence: "official" }],
      }).bubble,
    ).toBe("旅程を確定しました");
    expect(
      toolEndBubble("verify_festival", { result: "needs_check", reused: true, sources: [] }).bubble,
    ).toBe("旅程を確定しました（出発前に開催を要確認）");
  });

  it("ツールが失敗しても、スタッフは続けるので、失敗で止まったようには言わない", () => {
    expect(toolEndBubble("get_access", null)).toEqual({
      ok: false,
      bubble: "もう少し調べています",
      count: null,
    });
    expect(toolEndBubble("update_itinerary", null).bubble).toBe("旅程を整えています");
    expect(toolEndBubble("verify_festival", null).bubble).toBe("開催の情報を確かめています");
    expect(toolEndBubble("verify_festival", { result: "unknown", sources: [] }).bubble).toBe(
      "開催の情報を確かめています",
    );
  });
});

describe("見つけたものを具体的に言う（店内のようすの窓のくわしい文）", () => {
  it("search_festivals の後は、希望の日に合う数と、いちばん上の1件を言う", () => {
    const end = toolEndBubble("search_festivals", {
      candidates: [
        {
          name: "鈴鳴灯籠まつり",
          date: "2026-08-16",
          place: "滋賀県鈴鳴町",
          daysFromWish: 0,
          confirmed: true,
        },
        { name: "架空の夏祭り", date: "2026-08-17", daysFromWish: 1, confirmed: false },
      ],
    });
    expect(end.bubble).toBe("2件見つかりました。いちばん上は「鈴鳴灯籠まつり」");
    expect(end.detail).toBe(
      "希望の日に開かれる祭りを1件、前後の日を1件見つけました。いちばん上は「鈴鳴灯籠まつり」（8月16日・滋賀県鈴鳴町）です。うち1件は、開催をまだ確かめられていません",
    );
  });

  it("search_nearby の後は、種類ごとの数と、会場からいちばん近い1か所を言う", () => {
    const end = toolEndBubble("search_nearby", {
      research: { status: "researched", foodFound: true, rounds: 1 },
      spots: [
        { name: "架空食堂 みなと", kind: "food", walkMinutesFromVenueEstimate: [8, 10] },
        { name: "架空そば処", kind: "food", walkMinutesFromVenueEstimate: [3, 5] },
        {
          name: "架空甘味処",
          kind: "food",
          walkMinutesFromVenueEstimate: [5, 7],
          openStatus: "needs_check",
        },
        { name: "架空の展望台", kind: "sightseeing", walkMinutesFromVenueEstimate: [6, 9] },
      ],
    });
    expect(end).toMatchObject({ ok: true, bubble: "4か所見つけました。うち食事どころ3軒" });
    expect(end.detail).toBe(
      "会場から歩いて10分以内に、食事どころを3軒、見どころを1か所見つけました。いちばん近いのは「架空そば処」（歩いて3〜5分）です。うち1か所は、行く日の営業を確かめられませんでした",
    );
  });

  it("search_nearby で歩く時間が分からない場所があれば、範囲は言わず、食べたいものが見つからなかったことも言う", () => {
    const end = toolEndBubble("search_nearby", {
      research: { status: "researched", foodFound: false, rounds: 2 },
      spots: [
        { name: "架空の資料館", kind: "sightseeing", walkMinutesFromVenueEstimate: null },
        { name: "架空の休憩所", kind: "rest", walkMinutesFromVenueEstimate: [2, 2] },
      ],
    });
    expect(end.bubble).toBe("2か所見つけました");
    expect(end.detail).toBe(
      "会場の近くで、見どころを1か所、休めるところを1か所見つけました。いちばん近いのは「架空の休憩所」（歩いて約2分）です。食べたいものに合う店は、調べても見つかりませんでした",
    );
  });

  it("search_nearby を地域で探したときは、地域の名前とその日の祭りの数を言う", () => {
    const end = toolEndBubble("search_nearby", {
      area: "鈴鳴町",
      spots: [{ name: "架空の城跡", kind: "sightseeing" }],
      festivalsOnDate: [{ name: "架空の秋祭り" }],
    });
    // 1種類だけなら、その種類で言う
    expect(end.bubble).toBe("見どころを1か所見つけました");
    expect(end.detail).toBe(
      "鈴鳴町で、見どころを1か所見つけました。その日に開かれる祭りも1件あります",
    );
  });

  it("get_access の後は、会場までの目安と最寄り駅からの歩きを言う", () => {
    const end = toolEndBubble("get_access", {
      move: "car",
      parking: "limited",
      stations: [{ name: "鈴鳴駅", walkMinutesEstimate: [10, 15] }],
      fromOrigin: {
        origin: "みなと中央駅",
        hub: "架空本町駅",
        doorToVenueMinutesEstimate: [110, 130],
      },
    });
    expect(end.bubble).toBe("会場まで1時間50分〜2時間10分です");
    expect(end.detail).toBe(
      "みなと中央駅から会場まで1時間50分〜2時間10分の目安です（架空本町駅経由）。最寄りの鈴鳴駅から歩いて10〜15分です。駐車場は限られています",
    );
  });

  it("research_route の前後は、出発の駅と、乗り換えの回数・所要時間を言う", () => {
    expect(toolStartBubble("research_route", { origin: "みなと中央駅" }, state)).toBe(
      "みなと中央駅からの乗り換えを調べています",
    );
    const base = {
      origin: "みなと中央駅",
      destinationStation: "鈴鳴駅",
      walkMinutesFromStationEstimate: [10, 10],
      estimate: { minutes: [90, 120], basis: "distance" },
    };
    const once = toolEndBubble("research_route", {
      ...base,
      status: "researched",
      researched: { minutes: [100, 120], transfers: 1, summary: "使わない文", sources: [] },
    });
    expect(once.bubble).toBe("乗り換えは1回、1時間40分〜2時間です");
    expect(once.detail).toBe(
      "みなと中央駅から鈴鳴駅まで、乗り換え1回で1時間40分〜2時間です。鈴鳴駅から会場まで歩いて約10分です",
    );
    // 調べた文（summary）はモデルの書いた文なので、セリフに入れない
    expect(once.detail).not.toContain("使わない文");
    expect(
      toolEndBubble("research_route", {
        ...base,
        status: "researched",
        researched: { minutes: [45, 45], transfers: 0, sources: [] },
      }).bubble,
    ).toBe("乗り換えなしで、約45分です");
    const estimated = toolEndBubble("research_route", {
      ...base,
      status: "rejected",
      researched: null,
    });
    expect(estimated.bubble).toBe("行き方は見積もりで組みます");
    expect(estimated.detail).toBe(
      "調べた所要時間が駅の位置からの見積もりと合わなかったので、見積もりを使います。みなと中央駅から鈴鳴駅まで1時間30分〜2時間の目安です。鈴鳴駅から会場まで歩いて約10分です",
    );
  });

  it("search_lodging の前後は、泊まる日と、見つけた軒数・会場にいちばん近い宿を言う", () => {
    expect(toolStartBubble("search_lodging", { checkIn: "2026-08-15", nights: 2 }, state)).toBe(
      "8月15日から2泊の宿を探しています",
    );
    const end = toolEndBubble("search_lodging", {
      status: "ok",
      provider: "fictional",
      checkIn: "2026-08-15",
      offers: [
        {
          name: "架空の宿 みなと荘",
          fromVenue: { distanceKm: 2.34, mode: "ride", minutes: [10, 15] },
        },
        { name: "架空旅館", fromVenue: { distanceKm: 0.62, mode: "walk", minutes: [8, 12] } },
      ],
    });
    expect(end).toMatchObject({ ok: true, bubble: "宿を2軒見つけました", count: 2 });
    expect(end.detail).toBe(
      "8月15日に泊まれる宿を2軒見つけました。会場にいちばん近いのは「架空旅館」（歩いて8〜12分・0.6km）です。いまは見本の宿です。空きと料金は変わるので、予約のページで確かめてください",
    );
    expect(toolEndBubble("search_lodging", { status: "unavailable", reason: "x" })).toMatchObject({
      bubble: "宿の空きは調べられませんでした",
      detail: "宿の名前は挙げず、泊まる地域だけを案内します",
    });
  });

  it("get_weather の後は、予報の空模様と降水確率・最高気温を言う", () => {
    const end = toolEndBubble("get_weather", {
      date: "2026-08-16",
      weather: {
        status: "forecast",
        summary: "晴れ時々くもり",
        precipitationPercent: 20,
        highC: 31,
      },
    });
    expect(end.bubble).toBe("予報は晴れ時々くもりです");
    expect(end.detail).toBe("8月16日は晴れ時々くもり・降水確率20%・最高31℃");
  });

  it("集めた名前は、改行やかぎかっこを詰め、長ければ切って文字列として入れる", () => {
    expect(plainName("架空の\n店「本店」")).toBe("架空の 店 本店");
    expect(plainName("あ".repeat(30))).toBe(`${"あ".repeat(20)}…`);
    expect(plainName("   ")).toBeNull();
    expect(plainName(42)).toBeNull();
    const end = toolEndBubble("search_nearby", {
      spots: [{ name: "<b>架空食堂</b>", kind: "food", walkMinutesFromVenueEstimate: [5, 5] }],
    });
    // HTML として埋め込まないので、記号はそのまま文字として残る（画面は文字列として出す）
    expect(end.detail).toContain("「<b>架空食堂</b>」");
  });

  it("分の幅は「10〜15分」「1時間40分〜2時間」「約45分」の形にする", () => {
    expect(formatMinuteRange([10, 15])).toBe("10〜15分");
    expect(formatMinuteRange([100, 120])).toBe("1時間40分〜2時間");
    expect(formatMinuteRange([45, 45])).toBe("約45分");
  });
});

describe("調べ直しの頼みと受け", () => {
  it("足りないものから、頼むセリフと受けるセリフを作る", () => {
    expect(redoLines("request", "scout", "lunch")).toEqual({
      bubble: "昼ごはんの店がまだです。もう一度探してもらえますか",
      detail: "旅程に昼ごはんの店が入っていません。周辺係に調べ直しを頼みます",
    });
    expect(redoLines("accept", "planner", "lunch")).toEqual({
      bubble: "昼ごはんの店ですね。もう一度探してきます",
      detail: "旅程係から頼まれた昼ごはんの店を、もう一度探します",
    });
  });

  it("staff.redo のイベントは、スキーマに合う", () => {
    for (const subject of REDO_SUBJECTS) {
      const request = redoEvent("request", "planner", "scout", subject);
      const accept = redoEvent("accept", "scout", "planner", subject);
      expect(SseEventSchema.safeParse(request).success).toBe(true);
      expect(SseEventSchema.safeParse(accept).success).toBe(true);
    }
    expect(redoEvent("accept", "scout", "planner", "lodging").data.bubble).toBe(
      "泊まる宿ですね。もう一度探してきます",
    );
  });
});

describe("staffOf", () => {
  it("本体はコンシェルジュ、サブエージェントは名前のスタッフ、それ以外は null", () => {
    expect(staffOf(undefined)).toBe("concierge");
    expect(staffOf("planner")).toBe("planner");
    expect(staffOf("general-purpose")).toBeNull();
  });
});
