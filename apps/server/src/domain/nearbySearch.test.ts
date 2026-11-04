import { describe, expect, it } from "vitest";
import type { ResearchedSpotReport } from "./nearbyResearch";
import {
  CAR_SPOT_KM,
  MAX_NEARBY_QUERIES,
  maxSpotKm,
  mealTimes,
  mergeResearchedReports,
  type NearbySearchInput,
  nearbyCheckpoints,
  nearbySearchPlan,
  nearbySearchQueries,
  searchRadiusKm,
  stationWord,
  WALK_SPOT_KM,
} from "./nearbySearch";

// 架空の祭り（鈴鳴町の鈴鳴川の河原が会場、最寄りは鈴鳴駅と鈴鳴口駅）の周りの店探し
function input(edit: Partial<NearbySearchInput> = {}): NearbySearchInput {
  return {
    venueName: "鈴鳴川の河原",
    municipalities: [{ prefecture: "滋賀県", name: "鈴鳴町" }],
    stations: ["鈴鳴駅", "鈴鳴口"],
    foodWishes: ["meat"],
    dietary: [],
    withChildren: false,
    byCar: false,
    ...edit,
  };
}

describe("nearbySearchQueries", () => {
  it("1回目は、肉料理を料理の名前に言い換え、最寄り駅・市町村・時間帯・グルメの案内サイトと組む", () => {
    expect(nearbySearchQueries(input({ withChildren: true }), "first")).toEqual([
      "鈴鳴駅 焼肉 ランチ",
      "鈴鳴町 ステーキ",
      "鈴鳴駅 焼肉 食べログ",
      "鈴鳴駅 焼肉 子連れ",
      "鈴鳴駅 ハンバーグ",
      "鈴鳴町 焼肉 ディナー",
      "鈴鳴町 とんかつ ホットペッパーグルメ",
      "鈴鳴駅 ステーキ",
    ]);
  });

  it("2回目は、会場の周辺・隣の駅・言い換えの残り・料理の種類の大きな言葉に広げる", () => {
    const queries = nearbySearchQueries(input({ withChildren: true }), "widened");
    expect(queries).toEqual([
      "鈴鳴川の河原 周辺 焼肉",
      "鈴鳴口駅 焼肉",
      "鈴鳴町 焼き鳥",
      "滋賀県 鈴鳴町 肉料理 おすすめ",
      "鈴鳴町 鉄板焼き ランチ",
      "鈴鳴町 肉料理 Retty",
      "鈴鳴町 肉料理 子連れ",
      "鈴鳴駅 肉料理",
    ]);
    // 1回目と同じ言葉は繰り返さない
    const first = new Set(nearbySearchQueries(input({ withChildren: true }), "first"));
    expect(queries.filter((q) => first.has(q))).toEqual([]);
  });

  it("条件が多くても、言葉は上限までにする。食べたいものが2つあれば、どちらの言い換えも入る", () => {
    const queries = nearbySearchQueries(
      input({
        foodWishes: ["meat", "noodles", "sweets"],
        dietary: ["halal", "allergy"],
        withChildren: true,
        byCar: true,
      }),
      "first",
    );
    expect(queries).toHaveLength(MAX_NEARBY_QUERIES);
    expect(queries.some((q) => q.includes("焼肉"))).toBe(true);
    expect(queries.some((q) => q.includes("うどん"))).toBe(true);
    expect(queries.some((q) => q.includes("駐車場"))).toBe(true);
    expect(queries.some((q) => q.includes("ハラール"))).toBe(true);
  });

  it("屋台だけ・食べたいものがないときは、地元の味とカフェを探す", () => {
    for (const foodWishes of [[], ["stalls"]] as const) {
      const queries = nearbySearchQueries(input({ foodWishes: [...foodWishes] }), "first");
      expect(queries[0]).toBe("鈴鳴駅 ランチ");
      expect(queries.some((q) => q.includes("郷土料理"))).toBe(true);
      expect(queries.some((q) => q.includes("屋台"))).toBe(false);
    }
  });

  it("夜だけ寄れるなら、時間帯の言葉はディナーにする。駅がなければ市町村で探す", () => {
    const queries = nearbySearchQueries(
      input({ stations: [], window: { from: "17:30", to: "19:00" } }),
      "first",
    );
    expect(queries[0]).toBe("鈴鳴町 焼肉 ディナー");
    expect(queries.some((q) => q.includes("ランチ"))).toBe(false);
  });
});

describe("mealTimes", () => {
  it("使える時間帯が昼・夜にかかるかで決める。分からなければ両方", () => {
    expect(mealTimes(undefined)).toEqual(["lunch", "dinner"]);
    expect(mealTimes({ from: "11:30", to: "13:00" })).toEqual(["lunch"]);
    expect(mealTimes({ from: "13:00", to: "18:00" })).toEqual(["lunch", "dinner"]);
    expect(mealTimes({ from: "15:00", to: "16:30" })).toEqual([]);
  });
});

describe("stationWord", () => {
  it("駅の名前を「〇〇駅」の形にそろえる", () => {
    expect(stationWord("鈴鳴駅")).toBe("鈴鳴駅");
    expect(stationWord("鈴鳴口")).toBe("鈴鳴口駅");
    expect(stationWord("鈴鳴（すずなり）駅")).toBe("鈴鳴駅");
  });
});

describe("距離の上限と探す範囲", () => {
  it("車で回るときは、遠い店も選べる", () => {
    expect(maxSpotKm(false)).toBe(WALK_SPOT_KM);
    expect(maxSpotKm(true)).toBe(CAR_SPOT_KM);
    expect(CAR_SPOT_KM).toBeGreaterThan(WALK_SPOT_KM);
  });

  it("1回目は近くを、2回目は距離の上限まで広げる", () => {
    expect(searchRadiusKm(false, "first")).toBe(2);
    expect(searchRadiusKm(false, "widened")).toBe(WALK_SPOT_KM);
    expect(searchRadiusKm(true, "first")).toBe(5);
    expect(searchRadiusKm(true, "widened")).toBe(CAR_SPOT_KM);
  });
});

describe("nearbyCheckpoints", () => {
  it("営業・定休日・臨時休業・料金・位置はいつも確かめる。子ども連れ・車・食事の制限は、そのときだけ足す", () => {
    const base = nearbyCheckpoints(input()).join("\n");
    for (const word of ["焼肉", "営業時間", "定休日", "臨時休業", "料金", "位置"]) {
      expect(base).toContain(word);
    }
    expect(base).not.toContain("子ども連れ");
    expect(base).not.toContain("駐車場");

    const full = nearbyCheckpoints(
      input({ withChildren: true, byCar: true, dietary: ["vegan"] }),
    ).join("\n");
    expect(full).toContain("子ども連れで入れるか");
    expect(full).toContain("駐車場");
    expect(full).toContain("食事で気をつけたいこと");
  });
});

describe("nearbySearchPlan", () => {
  it("2回目にだけ、広げ方を入れる", () => {
    expect(nearbySearchPlan(input(), "first").widening).toEqual([]);
    const widened = nearbySearchPlan(input({ byCar: true }), "widened");
    expect(widened.radiusKm).toBe(CAR_SPOT_KM);
    expect(widened.widening.join("\n")).toContain("駐車場のある郊外の店");
  });
});

describe("mergeResearchedReports", () => {
  const report = (name: string, lat: number): ResearchedSpotReport => ({
    name,
    kind: "food",
    summary: "架空の店",
    location: { lat, lng: 136.08 },
    foods: ["meat"],
    dietaryOk: [],
    adultsOnly: false,
    pricePerPersonYen: null,
    price: null,
    hours: null,
    closedDays: null,
    openOnDate: "unconfirmed",
    sources: [{ url: `https://example.com/${encodeURIComponent(name)}` }],
  });

  it("2回の結果をまとめ、同じ場所は先に見つけたものを残す", () => {
    const merged = mergeResearchedReports(
      [report("鈴鳴グリル", 35.12)],
      [{ ...report("鈴鳴グリル", 35.12), summary: "重なり" }, report("鈴鳴亭", 35.13)],
    );
    expect(merged.map((r) => [r.name, r.summary])).toEqual([
      ["鈴鳴グリル", "架空の店"],
      ["鈴鳴亭", "架空の店"],
    ]);
  });
});
