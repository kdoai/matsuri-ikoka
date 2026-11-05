import { type Festival, type FestivalInput, FestivalWishIntentSchema } from "@matsuri-ikoka/schema";
import { fictionalSource } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { searchFestivalsByConditions } from "./festivalSearch";
import { readWishByWords, scoreWish } from "./festivalSearchWish";
import { type TestFestivalOptions, testFestival } from "./testFestivals";

const TODAY = "2026-07-01";

/** 希望に関わる値を空にした、何の特徴もない架空の祭りを作る */
function plain(id: string, options: Omit<TestFestivalOptions, "id"> = {}): Festival {
  const { edit, ...rest } = options;
  return testFestival({
    id,
    date: "2026-12-10",
    category: "other",
    popularity: "regional",
    scaleTier: "M",
    start: null,
    end: null,
    ...rest,
    edit: (f: FestivalInput) => {
      f.name = { ja: `${id}祭` };
      f.highlights = ["町の人が集まる"];
      f.trivia = [];
      f.venue.name = "町の広場";
      f.municipalities = [{ prefecture: "滋賀県", name: "架空町" }];
      f.nearby = [];
      f.food = { stalls: "unknown", local: [] };
      f.access.parking = "unknown";
      f.access.stations = [];
      f.etiquette = {
        participation: "unknown",
        howToJoin: null,
        rules: "unknown",
        dress: "unknown",
        bring: "unknown",
        risk: "unknown",
        photo: "unknown",
        sources: [fictionalSource("etiquette")],
      };
      edit?.(f);
    },
  });
}

const CATALOG: Festival[] = [
  plain("kids", {
    edit: (f) => {
      f.highlights = ["子ども神輿が町を回る"];
      f.etiquette.risk = { level: "low", reason: "見学だけ" };
    },
  }),
  plain("danger", {
    edit: (f) => {
      f.highlights = ["子どもが火の粉の中を駆け抜ける"];
      f.etiquette.risk = { level: "high", reason: "火の粉が飛ぶ" };
    },
  }),
  plain("night", { start: "18:30", end: "21:00" }),
  plain("dawn", { start: "06:00", end: "09:00" }),
  plain("stalls", {
    edit: (f) => {
      f.food.stalls = "yes";
    },
  }),
  plain("nostalls", {
    edit: (f) => {
      f.food.stalls = "no";
    },
  }),
  plain("quiet", { popularity: "local", scaleTier: "XS" }),
  plain("crowded", { popularity: "major", scaleTier: "L" }),
  plain("photo", {
    edit: (f) => {
      f.etiquette.photo = { policy: "allowed" };
      f.highlights = ["海辺に並ぶ絶景の灯り"];
    },
  }),
  plain("nophoto", {
    edit: (f) => {
      f.etiquette.photo = { policy: "prohibited", note: "撮影は禁止" };
    },
  }),
  plain("fire", {
    category: "fireworks",
    edit: (f) => {
      f.highlights = ["尺玉が次々に開く"];
    },
  }),
  plain("smallfire", {
    category: "float",
    edit: (f) => {
      f.highlights = ["最後に花火が上がる"];
    },
  }),
  plain("nofire", {
    edit: (f) => {
      f.highlights = ["花火の打ち上げはありません"];
    },
  }),
  plain("join", {
    edit: (f) => {
      f.etiquette.participation = "join_open";
      f.etiquette.howToJoin = "当日、踊りの輪に入る";
    },
  }),
  plain("watch", {
    edit: (f) => {
      f.etiquette.participation = "watch_only";
      f.etiquette.howToJoin = null;
    },
  }),
  plain("august", { date: "2026-08-20" }),
  plain("october", { date: "2026-10-20" }),
  plain("kyoto", {
    edit: (f) => {
      f.municipalities = [{ prefecture: "京都府", name: "町" }];
    },
  }),
  plain("food", {
    edit: (f) => {
      f.food.local = [{ name: "架空そば", note: "町の名物", sources: [fictionalSource("food")] }];
    },
  }),
  plain("snow", {
    edit: (f) => {
      f.highlights = ["雪の中で松明を掲げる"];
    },
  }),
  plain("old", {
    edit: (f) => {
      f.styles = [
        {
          style: "traditional",
          basis: "国の重要無形民俗文化財に指定",
          sources: [fictionalSource("style")],
        },
      ];
    },
  }),
  plain("kagura", {
    edit: (f) => {
      f.name = { ja: "里神楽祭" };
    },
  }),
  plain("arts", { category: "performing_arts" }),
  plain("named", {
    edit: (f) => {
      f.name = { ja: "鈴鳴灯籠祭" };
    },
  }),
];

function rank(wish: string): { ids: string[]; fit: Map<string, string | null> } {
  const ids: string[] = [];
  const fit = new Map<string, string | null>();
  for (;;) {
    const { results, remaining } = searchFestivalsByConditions(CATALOG, {
      conditions: { kinds: [], season: null, prefectures: [] },
      sessionId: "session-a",
      excludeIds: ids,
      wish,
      today: TODAY,
    });
    for (const r of results) {
      ids.push(r.candidate.festivalId);
      fit.set(r.candidate.festivalId, r.wishFit);
    }
    if (remaining === 0) return { ids, fit };
  }
}

/** 言い方と、上に来るべき祭り・下に来るべき祭り */
const WISH_CASES: { wish: string; top: string[]; below?: string[] }[] = [
  { wish: "子連れで行きたい", top: ["kids"], below: ["danger"] },
  { wish: "こどもと一緒に楽しみたい", top: ["kids"], below: ["danger"] },
  { wish: "家族で", top: ["kids"], below: ["danger"] },
  { wish: "夜の祭りがいい", top: ["night"], below: ["dawn"] },
  { wish: "ナイトイベント", top: ["night"], below: ["dawn"] },
  { wish: "朝のうちに見たい", top: ["dawn"], below: ["night"] },
  { wish: "屋台を楽しみたい", top: ["stalls"], below: ["nostalls"] },
  { wish: "露店で食べ歩き", top: ["stalls"], below: ["nostalls"] },
  { wish: "静かなところがいい", top: ["quiet"], below: ["crowded"] },
  { wish: "のんびり過ごしたい", top: ["quiet"], below: ["crowded"] },
  { wish: "人が少ないところ", top: ["quiet"], below: ["crowded"] },
  { wish: "人混みは苦手", top: [], below: ["crowded"] },
  { wish: "混雑を避けたい", top: [], below: ["crowded"] },
  { wish: "にぎやかなのがいい", top: ["crowded"], below: ["quiet"] },
  { wish: "写真を撮りたい", top: ["photo"], below: ["nophoto"] },
  { wish: "インスタ映えする祭り", top: ["photo"], below: ["nophoto"] },
  { wish: "花火が見たい", top: ["fire", "smallfire"], below: ["nofire"] },
  { wish: "ハナビ", top: ["fire", "smallfire"], below: ["nofire"] },
  { wish: "花火は苦手です", top: [], below: ["fire"] },
  { wish: "踊りの輪に飛び入りで加わりたい", top: ["join"], below: ["watch"] },
  { wish: "自分も参加したい", top: ["join"], below: ["watch"] },
  { wish: "見るだけがいい", top: ["watch"] },
  { wish: "8月に行きたい", top: ["august"], below: ["october"] },
  { wish: "夏休みに", top: ["august"], below: ["october"] },
  { wish: "１０月がいい", top: ["october"], below: ["august"] },
  { wish: "京都で探したい", top: ["kyoto"] },
  { wish: "郷土料理も食べたい", top: ["food"] },
  { wish: "雪の中の祭り", top: ["snow"] },
  { wish: "歴史のある祭り", top: ["old"] },
  { wish: "海辺の絶景", top: ["photo"] },
  { wish: "鈴鳴灯籠祭に行きたい", top: ["named"] },
  { wish: "神楽が見たい", top: ["kagura", "arts"] },
];

describe("自由記述の上位の精度", () => {
  it.each(WISH_CASES)("「$wish」", ({ wish, top, below }) => {
    const { ids } = rank(wish);
    const position = (id: string) => ids.indexOf(id);
    for (const id of top) {
      expect(position(id), `${id} の位置 ${ids.join(",")}`).toBeLessThan(top.length);
    }
    for (const id of below ?? []) {
      expect(position(id), `${id} の位置 ${ids.join(",")}`).toBeGreaterThanOrEqual(
        ids.length - CATALOG.length / 2,
      );
      for (const upper of top) expect(position(upper)).toBeLessThan(position(id));
    }
  });

  it("名前にその言葉のある祭りを、同じ種類の祭りより上にする", () => {
    expect(rank("神楽が見たい").ids[0]).toBe("kagura");
  });

  it("避けたいと言われた祭りは、いちばん下に来る", () => {
    expect(rank("人混みは苦手").ids.at(-1)).toBe("crowded");
    expect(rank("花火は苦手です").ids.at(-1)).toBe("fire");
  });
});

describe("wishFit", () => {
  const fitOf = (wish: string, id: string) => rank(wish).fit.get(id);

  it("すべて合うと matched、一部だと partial、何も合わないと none", () => {
    expect(fitOf("夜がいい", "night")).toBe("matched");
    expect(fitOf("夜がいい", "dawn")).toBe("none");
    expect(fitOf("夜の屋台", "night")).toBe("partial");
    expect(fitOf("夜の屋台", "stalls")).toBe("partial");
    expect(fitOf("夜の屋台", "dawn")).toBe("none");
  });

  it("避けたいことに当たると none に、当たらなければ matched にする", () => {
    expect(fitOf("人混みは苦手", "crowded")).toBe("none");
    expect(fitOf("人混みは苦手", "quiet")).toBe("matched");
  });

  it("希望を読み取れなければ、どの祭りにも「合うと言えない」と出さない", () => {
    const { fit } = rank("よろしくお願いします");
    expect([...fit.values()].every((v) => v === null)).toBe(true);
  });

  it("否定している文には当たらない", () => {
    const list = [
      plain("a", {
        edit: (f) => {
          f.highlights = ["屋台はありません"];
        },
      }),
      plain("b", {
        edit: (f) => {
          f.highlights = ["屋台が並ぶ。写真は禁止"];
        },
      }),
    ];
    const fits = Object.fromEntries(
      searchFestivalsByConditions(list, {
        conditions: { kinds: [], season: null, prefectures: [] },
        sessionId: "s",
        wish: "屋台",
        today: TODAY,
      }).results.map((r) => [r.candidate.festivalId, r.wishFit]),
    );
    expect(fits).toEqual({ a: "none", b: "matched" });
  });

  it("同じ意味の言葉がいくつ並んでも、1つの希望として数える", () => {
    const festival = plain("c", {
      edit: (f) => {
        f.highlights = ["宵の口に始まる"];
      },
    });
    const occurrence = festival.occurrences[0] as Festival["occurrences"][number];
    const intent = (terms: string[]) => ({
      summary: "テスト",
      categories: [],
      terms,
      avoidTerms: [],
      months: [],
      prefectures: [],
      wantsToJoin: false,
    });
    const one = scoreWish(festival, occurrence, intent(["夜"]), "夜");
    const many = scoreWish(festival, occurrence, intent(["夜", "宵", "夕暮れ"]), "夜");
    expect(many.points).toBe(one.points);
    expect(many.fit).toBe("matched");
  });
});

describe("readWishByWords", () => {
  it("読み取りの結果はスキーマに合う", () => {
    for (const wish of [
      "子連れで夜の屋台と花火を楽しみたい、静かで写真も撮れて、温泉と海辺も、郷土料理も、桜も紅葉も雪も",
      "架空町内会神社例大祭山車神輿太鼓獅子舞灯籠提灯松明盆踊り朝市奉納神事".repeat(4),
      "北海道・東北・関東・中部・近畿・中国・四国・九州沖縄で1月2月3月4月5月6月7月8月9月10月11月12月",
      "😀😀😀",
      "",
    ]) {
      const read = readWishByWords(wish.slice(0, 200));
      expect(() => FestivalWishIntentSchema.parse(read), wish).not.toThrow();
    }
  });

  it("言い換えを、決まった呼び方に読む", () => {
    expect(readWishByWords("こどもと行く").terms).toContain("子連れ");
    expect(readWishByWords("露店で買い食い").terms).toEqual(["屋台"]);
    expect(readWishByWords("インスタ映え").terms).toEqual(["写真"]);
    expect(readWishByWords("宵の頃").terms).toEqual(["夜"]);
  });

  it("種類の言葉を category に読む", () => {
    const read = readWishByWords("太鼓と山車が見たい");
    expect(read.categories.sort()).toEqual(["float", "performing_arts"]);
    expect(read.terms).toEqual(expect.arrayContaining(["太鼓", "山車"]));
  });

  it("月と時期を読む", () => {
    expect(readWishByWords("8月か九月").months).toEqual([8, 9]);
    expect(readWishByWords("１０月").months).toEqual([10]);
    expect(readWishByWords("夏休み").months).toEqual([7, 8]);
    expect(readWishByWords("秋に行きたい").months).toEqual([9, 10, 11]);
    expect(readWishByWords("13月").months).toEqual([]);
  });

  it("地名を読み、ほかの言葉に当てない", () => {
    expect(readWishByWords("京都か北陸で").prefectures).toEqual([
      "富山県",
      "石川県",
      "福井県",
      "京都府",
    ]);
    // 「秋田」を季節の秋に、「北海道」を海に読まない
    const read = readWishByWords("秋田か北海道");
    expect(read.months).toEqual([]);
    expect(read.terms).toEqual([]);
    expect(read.prefectures).toEqual(["北海道", "秋田県"]);
    expect(readWishByWords("東京以外").prefectures).toEqual([]);
  });

  it("避けたいことを、希望と分けて読む", () => {
    const read = readWishByWords("人混みは苦手で、夜がいい");
    expect(read.avoidTerms).toEqual(["混雑"]);
    expect(read.terms).toEqual(["夜"]);
    expect(readWishByWords("混雑しないところ").avoidTerms).toEqual(["混雑"]);
    expect(readWishByWords("混まないところ").terms).toEqual(["静か"]);
    expect(readWishByWords("屋台がなくてもいい")).toMatchObject({ terms: [], avoidTerms: [] });
  });

  it("加わりたいことを読む", () => {
    expect(readWishByWords("自分も踊りたい").wantsToJoin).toBe(true);
    expect(readWishByWords("参加したい").wantsToJoin).toBe(true);
    expect(readWishByWords("見るだけ").wantsToJoin).toBe(false);
    expect(readWishByWords("参加はしない").wantsToJoin).toBe(false);
  });

  it("辞書にない言葉は、そのまま文に当てる", () => {
    const read = readWishByWords("架空神社の祭りが好き、友達と");
    expect(read.terms).toContain("架空神社");
    expect(read.terms).not.toContain("友達");
  });

  it("受け取り方の文は40字までで、読めなければそう書く", () => {
    expect(readWishByWords("よろしくお願いします").summary).toBe(
      "希望の言葉を読み取れず、条件だけで探しました",
    );
    expect(readWishByWords("夜がいい").summary).toContain("「夜」");
    expect(
      readWishByWords("子連れで夜の屋台と花火で静かで写真で温泉で海辺で郷土料理で桜で紅葉").summary
        .length,
    ).toBeLessThanOrEqual(40);
  });
});

describe("モデルで読んだ結果", () => {
  it("同じ形で照らし合わせ、reading の by が model になる", () => {
    const response = searchFestivalsByConditions(CATALOG, {
      conditions: { kinds: [], season: null, prefectures: [] },
      sessionId: "session-a",
      wish: "夕涼みに行きたい",
      wishIntent: {
        summary: "夕方から夜の祭り",
        categories: [],
        terms: ["夕方", "夜"],
        avoidTerms: [],
        months: [],
        prefectures: [],
        wantsToJoin: false,
      },
      today: TODAY,
    });
    expect(response.reading).toEqual({ text: "夕方から夜の祭り", by: "model" });
    expect(response.results[0]?.candidate.festivalId).toBe("night");
    expect(response.results[0]?.reasons.join()).toContain("夜");
  });

  it("自由記述がなければ読まず、reading も wishFit も null", () => {
    const response = searchFestivalsByConditions(CATALOG, {
      conditions: { kinds: [], season: null, prefectures: [] },
      sessionId: "session-a",
      wish: "   ",
      today: TODAY,
    });
    expect(response.reading).toBeNull();
    expect(response.results.every((r) => r.wishFit === null)).toBe(true);
  });
});
