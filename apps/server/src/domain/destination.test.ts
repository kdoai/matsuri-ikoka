import { PREFECTURES, type Prefecture } from "@matsuri-ikoka/schema";
import { describe, expect, it } from "vitest";
import {
  destinationQuestion,
  destinationReason,
  NEIGHBOR_PREFECTURES,
  neighborsOf,
  pickByDestination,
  REGION_PREFECTURES,
  resolveDestination,
} from "./destination";
import { testFestival } from "./testFestivals";

/** 架空の祭りを、開催地の都道府県と希望日からのずれだけ変えて作る */
function match(id: string, prefecture: Prefecture, daysFromWish = 0) {
  const festival = testFestival({
    id,
    edit: (f) => {
      f.municipalities = [{ prefecture, name: "鈴鳴町" }];
    },
  });
  return { festival, daysFromWish };
}

/** 決まった並びの数を順に返す（ランダムの代わり） */
function sequence(...values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length] as number;
}

describe("隣接する県の表", () => {
  it("どの組も、両方の県から隣に見える", () => {
    for (const p of PREFECTURES) {
      for (const n of NEIGHBOR_PREFECTURES[p]) expect(NEIGHBOR_PREFECTURES[n]).toContain(p);
    }
  });

  it("自分自身を隣に持たない", () => {
    for (const p of PREFECTURES) expect(NEIGHBOR_PREFECTURES[p]).not.toContain(p);
  });

  it("富山県の隣は新潟県・石川県・長野県・岐阜県", () => {
    expect(NEIGHBOR_PREFECTURES["富山県"]).toEqual(["新潟県", "石川県", "長野県", "岐阜県"]);
  });

  it("橋やトンネルでつながる県も隣とする", () => {
    expect(NEIGHBOR_PREFECTURES["北海道"]).toEqual(["青森県"]);
    expect(NEIGHBOR_PREFECTURES["香川県"]).toContain("岡山県");
  });

  it("沖縄県には隣の県がない", () => {
    expect(NEIGHBOR_PREFECTURES["沖縄県"]).toEqual([]);
  });

  it("地方の表の県は、どれも都道府県の名前", () => {
    for (const prefectures of Object.values(REGION_PREFECTURES)) {
      for (const p of prefectures) expect(PREFECTURES).toContain(p);
    }
  });
});

describe("resolveDestination", () => {
  it("地方の名前を、その中の都道府県にする", () => {
    expect(resolveDestination(["北陸"]).prefectures).toEqual(["富山県", "石川県", "福井県"]);
    expect(resolveDestination(["北陸地方"]).prefectures).toEqual(["富山県", "石川県", "福井県"]);
  });

  it("「県」を省いた呼び方や、中黒の入った地方も受け付ける", () => {
    expect(resolveDestination(["富山", "京都"]).prefectures).toEqual(["富山県", "京都府"]);
    expect(resolveDestination(["九州・沖縄"]).prefectures).toContain("沖縄県");
  });

  it("重なりは1つにし、番号順に並べる", () => {
    expect(resolveDestination(["石川県", "北陸"]).prefectures).toEqual([
      "富山県",
      "石川県",
      "福井県",
    ]);
  });

  it("都道府県にも地方にも当たらない名前は、推測せず unknown に返す", () => {
    expect(resolveDestination(["鈴鳴町", "富山県"])).toEqual({
      prefectures: ["富山県"],
      unknown: ["鈴鳴町"],
    });
  });
});

describe("neighborsOf", () => {
  it("選んだ県どうしは隣に入れない", () => {
    const near = neighborsOf(["富山県", "石川県", "福井県"]);
    expect(near).toEqual(["新潟県", "長野県", "岐阜県", "滋賀県", "京都府"]);
  });
});

describe("pickByDestination", () => {
  const options = { widen: "area" as const, random: () => 0 };

  it("行き先がなければ、日程で探した順のまま返す", () => {
    const matches = [match("a", "滋賀県"), match("b", "沖縄県")];
    const picked = pickByDestination(matches, { ...options, prefectures: [] });
    expect(picked).toEqual({ kind: "matches", stage: "anywhere", matches, foundIn: [] });
  });

  it("選んだ地域に祭りがあれば、それだけを返す", () => {
    const toyama = match("toyama", "富山県", 5);
    const picked = pickByDestination([match("shiga", "滋賀県"), toyama, match("gifu", "岐阜県")], {
      ...options,
      prefectures: ["富山県"],
    });
    expect(picked).toEqual({
      kind: "matches",
      stage: "area",
      matches: [toyama],
      foundIn: ["富山県"],
    });
  });

  it("選んだ地域になく、隣の県にあれば、紹介してよいかを先に聞く", () => {
    const picked = pickByDestination([match("shiga", "滋賀県"), match("gifu", "岐阜県")], {
      ...options,
      prefectures: ["富山県"],
    });
    expect(picked).toEqual({ kind: "ask", next: "neighbor", foundIn: ["岐阜県"] });
  });

  it("隣の県まで了承を得ていれば、隣の県の祭りを返す", () => {
    const gifu = match("gifu", "岐阜県");
    const picked = pickByDestination([match("shiga", "滋賀県"), gifu], {
      ...options,
      widen: "neighbor",
      prefectures: ["富山県"],
    });
    expect(picked).toEqual({
      kind: "matches",
      stage: "neighbor",
      matches: [gifu],
      foundIn: ["岐阜県"],
    });
  });

  it("全国まで了承を得ていても、隣の県にあれば隣の県を先にする", () => {
    const picked = pickByDestination([match("shiga", "滋賀県"), match("gifu", "岐阜県")], {
      ...options,
      widen: "nationwide",
      prefectures: ["富山県"],
    });
    expect(picked.kind === "matches" && picked.stage).toBe("neighbor");
  });

  it("隣の県にもなければ、全国から紹介してよいかを聞く", () => {
    const picked = pickByDestination([match("okinawa", "沖縄県"), match("shiga", "滋賀県")], {
      ...options,
      widen: "neighbor",
      prefectures: ["富山県"],
    });
    expect(picked).toEqual({ kind: "ask", next: "nationwide", foundIn: ["滋賀県", "沖縄県"] });
  });

  it("全国まで了承を得ていれば、希望日に開く祭りからランダムに並べる", () => {
    const onWish = [match("a", "沖縄県"), match("b", "滋賀県"), match("c", "高知県")];
    const picked = pickByDestination([...onWish, match("later", "大阪府", 3)], {
      widen: "nationwide",
      prefectures: ["富山県"],
      // 最後の祭りから順に、0 番目と入れ替える
      random: sequence(0, 0),
    });
    expect(picked.kind).toBe("matches");
    if (picked.kind !== "matches") return;
    expect(picked.stage).toBe("nationwide");
    expect(picked.matches.map((m) => m.festival.id)).toEqual(["b", "c", "a"]);
  });

  it("希望日に開く祭りがなければ、前後の日の祭りからランダムに選ぶ", () => {
    const picked = pickByDestination([match("a", "沖縄県", 2), match("b", "滋賀県", -1)], {
      widen: "nationwide",
      prefectures: ["富山県"],
      random: () => 0.99,
    });
    expect(picked.kind === "matches" && picked.matches.map((m) => m.festival.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("全国にも祭りがなければ none", () => {
    expect(pickByDestination([], { ...options, prefectures: ["富山県"] })).toEqual({
      kind: "none",
    });
  });

  it("沖縄県には隣の県がないので、なければ全国を聞く", () => {
    const picked = pickByDestination([match("shiga", "滋賀県")], {
      ...options,
      prefectures: ["沖縄県"],
    });
    expect(picked).toEqual({ kind: "ask", next: "nationwide", foundIn: ["滋賀県"] });
  });

  it("県をまたぐ祭りは、どちらかの県に入れば選んだ地域の祭りにする", () => {
    const across = testFestival({
      id: "across",
      edit: (f) => {
        f.municipalities = [
          { prefecture: "岐阜県", name: "鈴鳴町" },
          { prefecture: "富山県", name: "風見町" },
        ];
      },
    });
    const picked = pickByDestination([{ festival: across, daysFromWish: 0 }], {
      ...options,
      prefectures: ["富山県"],
    });
    expect(picked).toMatchObject({ kind: "matches", stage: "area", foundIn: ["富山県"] });
  });
});

describe("確認と理由の文", () => {
  it("隣の県を紹介する前の問い", () => {
    expect(
      destinationQuestion("富山県", { kind: "ask", next: "neighbor", foundIn: ["岐阜県"] }),
    ).toBe(
      "富山県には、この日程で開く祭りが見つかりませんでした。隣の岐阜県なら祭りがあります。こちらを紹介してもよいですか？",
    );
  });

  it("全国から紹介する前の問い", () => {
    expect(destinationQuestion("北陸", { kind: "ask", next: "nationwide", foundIn: [] })).toBe(
      "北陸と隣の県には、この日程で開く祭りが見つかりませんでした。日本全国で、この日程に開く祭りからランダムに紹介しましょうか？",
    );
  });

  it("広げて出すときだけ理由を添える", () => {
    expect(destinationReason("富山県", "neighbor", ["岐阜県"])).toBe(
      "富山県にはなかったので、隣の岐阜県の祭りです",
    );
    expect(destinationReason("富山県", "area", ["富山県"])).toBeNull();
    expect(destinationReason("", "anywhere", [])).toBeNull();
  });
});
