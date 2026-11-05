import {
  FESTIVAL_KINDS,
  type Festival,
  type FestivalKind,
  type FestivalSearchConditions,
  FestivalSearchResponseSchema,
  type Prefecture,
  SEASONS,
  type Season,
} from "@matsuri-ikoka/schema";
import { fictionalSource } from "@matsuri-ikoka/schema/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { neighborsOf } from "./destination";
import { matchKind, searchFestivalsByConditions } from "./festivalSearch";
import { type TestFestivalOptions, testFestival } from "./testFestivals";

const TODAY = "2026-07-01";
const SESSION = "session-a";

const CATEGORIES: Festival["category"][] = [
  "fireworks",
  "float",
  "mikoshi",
  "dance",
  "fire",
  "lantern",
  "performing_arts",
  "ritual",
  "market",
  "other",
];
const PREFECTURES: Prefecture[] = ["滋賀県", "京都府", "富山県", "沖縄県", "北海道", "福島県"];
const SCALES: Festival["scaleTier"][] = ["XS", "S", "M", "L"];
const POPULARITY: Festival["popularity"][] = ["major", "regional", "local"];
const PARTICIPATION = ["watch_only", "join_open", "join_by_application", "unknown"] as const;

function festival(
  id: string,
  options: Omit<TestFestivalOptions, "id"> & {
    prefecture?: Prefecture;
    highlights?: string[];
    trivia?: string[];
    styles?: ("traditional" | "community")[];
    participation?: (typeof PARTICIPATION)[number];
  } = {},
): Festival {
  const { prefecture, highlights, trivia, styles, participation, edit, ...rest } = options;
  return testFestival({
    id,
    ...rest,
    edit: (f) => {
      if (prefecture !== undefined) f.municipalities = [{ prefecture, name: "鈴鳴町" }];
      if (highlights !== undefined) f.highlights = highlights;
      if (trivia !== undefined) {
        f.trivia = trivia.map((text) => ({ text, source: fictionalSource("trivia") }));
      }
      if (styles !== undefined) {
        f.styles = styles.map((style) => ({
          style,
          basis: `${style} と言える根拠`,
          sources: [fictionalSource("style")],
        }));
      }
      if (participation !== undefined) {
        f.etiquette.participation = participation;
        f.etiquette.howToJoin = participation === "watch_only" ? null : "unknown";
      }
      edit?.(f);
    },
  });
}

/** 属性を散らした、架空の祭りの大きな一覧。季節・状態・またがりの端の場合を含む */
function manyFestivals(): Festival[] {
  const out: Festival[] = [];
  let state = 7;
  const next = (n: number) => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return (state >>> 8) % n;
  };
  const pick = <T>(items: readonly T[]) => items[next(items.length)] as T;
  for (let i = 0; i < 420; i += 1) {
    const month = next(12) + 1;
    const year = month >= 7 ? 2026 : 2027;
    const date = `${year}-${String(month).padStart(2, "0")}-${String(next(25) + 1).padStart(2, "0")}`;
    const shape = next(20);
    const status: TestFestivalOptions["status"] =
      shape === 0
        ? "cancelled"
        : shape === 1
          ? "postponed"
          : shape === 2
            ? "expected"
            : "announced";
    const prefecture = pick(PREFECTURES);
    out.push(
      festival(`gen-${i}`, {
        date: shape === 3 ? "2026-06-20" : date, // 過ぎた日
        status,
        category: pick(CATEGORIES),
        scaleTier: pick(SCALES),
        popularity: pick(POPULARITY),
        prefecture,
        participation: pick(PARTICIPATION),
        optOut: shape === 4,
        confidence: pick(["official", "single"]),
        highlights: [
          next(5) === 0 ? "最後に花火が上がる" : "川面に浮かぶ灯籠",
          next(3) === 0 ? "国の重要無形民俗文化財" : "宵の口の囃子",
        ],
        trivia: [next(4) === 0 ? "江戸時代に始まったと伝わる" : "和紙は町の小学生がすく"],
        styles: pick([[], [], ["traditional"], ["community"], ["traditional", "community"]]),
        edit: (f) => {
          const first = f.occurrences[0];
          if (first === undefined) return;
          if (shape === 5) first.endDate = "2026-12-03"; // 秋から冬へまたがる
          if (shape === 5) first.date = "2026-11-28";
          if (shape === 6) {
            // 今年の回は中止で、来年の回がある
            first.status = "cancelled";
            f.occurrences.push({ ...first, date: "2027-08-01", status: "expected" });
          }
          if (shape === 7) f.municipalities.push({ prefecture: pick(PREFECTURES), name: "隣町" });
          if (shape === 8) first.date = "2026-06-29"; // 始まっていて、今日まで続く
          if (shape === 8) first.endDate = "2026-07-02";
        },
      }),
    );
  }
  return out;
}

// テストの見本（実装とは別に、仕様の表をそのまま書く）
const HANDLERS: Record<FestivalKind, (f: Festival) => boolean> = {
  fireworks: (f) => f.category === "fireworks" || f.highlights.some((h) => h.includes("花火")),
  community: (f) =>
    f.styles.some((s) => s.style === "community") ||
    (f.styles.length === 0 &&
      f.scaleTier !== "L" &&
      f.popularity !== "major" &&
      f.category !== "fireworks"),
  traditional: (f) =>
    f.styles.some((s) => s.style === "traditional") ||
    (f.styles.length === 0 &&
      f.category !== "fireworks" &&
      f.category !== "market" &&
      [...f.highlights, ...f.trivia.map((t) => t.text)].some((t) => /文化財|江戸時代/.test(t))),
  participatory: (f) =>
    f.etiquette.participation === "join_open" ||
    f.etiquette.participation === "join_by_application",
  hidden: (f) => f.popularity === "local",
  famous: (f) => f.popularity === "major" || (f.popularity === "regional" && f.scaleTier === "L"),
};

const AXES: FestivalKind[][] = [
  ["fireworks", "community", "traditional"],
  ["participatory"],
  ["hidden", "famous"],
];

const MONTHS: Record<Season, number[]> = {
  spring: [3, 4, 5],
  summer: [6, 7, 8],
  autumn: [9, 10, 11],
  winter: [12, 1, 2],
};

function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  const end = new Date(`${to}T00:00:00Z`).getTime();
  for (let t = new Date(`${from}T00:00:00Z`).getTime(); t <= end; t += 86400000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

/** 条件に合うときに、候補に出してよい日（今日以降で季節に入る、開いている日） */
function allowedDays(f: Festival, season: Season | null): string[] {
  return f.occurrences
    .filter((o) => o.status === "announced" || o.status === "expected")
    .flatMap((o) => eachDay(o.date, o.endDate ?? o.date))
    .filter(
      (day) =>
        day >= TODAY && (season === null || MONTHS[season].includes(Number(day.slice(5, 7)))),
    )
    .sort();
}

function satisfies(f: Festival, c: FestivalSearchConditions): boolean {
  if (f.optOut) return false;
  if (allowedDays(f, c.season).length === 0) return false;
  if (
    c.prefectures.length > 0 &&
    !f.municipalities.some((m) => c.prefectures.includes(m.prefecture))
  ) {
    return false;
  }
  return AXES.every((axis) => {
    const selected = axis.filter((k) => c.kinds.includes(k));
    return selected.length === 0 || selected.some((k) => HANDLERS[k](f));
  });
}

function allKindSets(): FestivalKind[][] {
  const sets: FestivalKind[][] = [];
  for (let bits = 0; bits < 1 << FESTIVAL_KINDS.length; bits += 1) {
    sets.push(FESTIVAL_KINDS.filter((_, i) => bits & (1 << i)));
  }
  return sets;
}

const AREAS: Prefecture[][] = [
  [],
  ["滋賀県"],
  ["沖縄県"],
  ["滋賀県", "京都府"],
  ["富山県", "北海道", "福島県"],
  ["東京都"], // 祭りのない県
];

describe("必ず守る条件", () => {
  let festivals: Festival[];
  let byId: Map<string, Festival>;
  beforeAll(() => {
    festivals = manyFestivals();
    byId = new Map(festivals.map((f) => [f.id, f]));
  });

  it("種類×季節×地域のどの組み合わせでも、合う祭りだけが出て、合う祭りを数え漏らさない", () => {
    let combinations = 0;
    let nonEmpty = 0;
    for (const kinds of allKindSets()) {
      for (const season of [...SEASONS, null]) {
        for (const prefectures of AREAS) {
          const conditions = { kinds, season, prefectures };
          const response = searchFestivalsByConditions(festivals, {
            conditions,
            sessionId: SESSION,
            today: TODAY,
          });
          const expected = festivals.filter((f) => satisfies(f, conditions));
          combinations += 1;
          if (expected.length > 0) nonEmpty += 1;
          expect(response.results.length + response.remaining).toBe(expected.length);
          expect(response.results.length).toBeLessThanOrEqual(6);
          for (const result of response.results) {
            const f = byId.get(result.candidate.festivalId) as Festival;
            expect(satisfies(f, conditions), `${f.id} ${JSON.stringify(conditions)}`).toBe(true);
            expect(result.candidate.date).toBe(allowedDays(f, season)[0]);
            expect(result.candidate.daysFromWish).toBe(0);
          }
        }
      }
    }
    expect(combinations).toBe(64 * 5 * 6);
    // 見本の一覧が、条件の網羅に足りていることも確かめる
    expect(nonEmpty).toBeGreaterThan(combinations / 2);
  }, 120_000);

  it("応答はスキーマに合う（理由は3つまで、次の手は5つまで）", () => {
    for (const kinds of [[], ["participatory"], ["traditional", "hidden"]] as FestivalKind[][]) {
      for (const prefectures of AREAS) {
        const response = searchFestivalsByConditions(festivals, {
          conditions: { kinds, season: "winter", prefectures },
          sessionId: SESSION,
          wish: "子連れで夜の屋台を楽しみたい",
          today: TODAY,
        });
        expect(() => FestivalSearchResponseSchema.parse(response)).not.toThrow();
      }
    }
  });

  it("自由記述を書いても、候補の集まりは変わらない", () => {
    const conditions = { kinds: ["traditional"], season: "autumn", prefectures: [] } as const;
    const ids = (wish?: string) => {
      const seen: string[] = [];
      for (;;) {
        const { results, remaining } = searchFestivalsByConditions(festivals, {
          conditions: { ...conditions, kinds: [...conditions.kinds], prefectures: [] },
          sessionId: SESSION,
          excludeIds: seen,
          ...(wish === undefined ? {} : { wish }),
          today: TODAY,
        });
        seen.push(...results.map((r) => r.candidate.festivalId));
        if (remaining === 0) return seen.sort();
      }
    };
    expect(ids("花火は苦手で、静かな山里がいい。京都で8月")).toEqual(ids());
  });

  it("中止・延期・過ぎた日・掲載停止の祭りは出ない", () => {
    const list = [
      festival("cancelled", { date: "2026-08-01", status: "cancelled" }),
      festival("postponed", { date: "2026-08-01", status: "postponed" }),
      festival("past", { date: "2026-06-30" }),
      festival("opted-out", { date: "2026-08-01", optOut: true }),
      festival("open", { date: "2026-08-01" }),
    ];
    const { results, remaining } = searchFestivalsByConditions(list, {
      conditions: { kinds: [], season: null, prefectures: [] },
      sessionId: SESSION,
      today: TODAY,
    });
    expect(results.map((r) => r.candidate.festivalId)).toEqual(["open"]);
    expect(remaining).toBe(0);
  });

  it("開催回が見込みなら confirmed は false。中止の回を飛ばして次の回を使う", () => {
    const list = [
      festival("next-year", {
        date: "2026-08-01",
        status: "cancelled",
        edit: (f) => {
          const first = f.occurrences[0];
          if (first !== undefined) {
            f.occurrences.push({ ...first, date: "2027-08-02", status: "expected" });
          }
        },
      }),
    ];
    const [result] = searchFestivalsByConditions(list, {
      conditions: { kinds: [], season: "summer", prefectures: [] },
      sessionId: SESSION,
      today: TODAY,
    }).results;
    expect(result?.candidate.date).toBe("2027-08-02");
    expect(result?.candidate.confirmed).toBe(false);
  });

  it("季節をまたぐ開催は、季節に入る最初の日を候補の日にする", () => {
    const list = [festival("span", { date: "2026-11-28", endDate: "2026-12-03" })];
    const on = (season: Season | null) =>
      searchFestivalsByConditions(list, {
        conditions: { kinds: [], season, prefectures: [] },
        sessionId: SESSION,
        today: TODAY,
      }).results[0]?.candidate.date;
    expect(on("autumn")).toBe("2026-11-28");
    expect(on("winter")).toBe("2026-12-01");
    expect(on("summer")).toBeUndefined();
    expect(on(null)).toBe("2026-11-28");
  });

  it("冬は年をまたいで1月2月を含み、3月は春になる", () => {
    const list = [festival("jan", { date: "2027-01-10" }), festival("mar", { date: "2027-03-01" })];
    const ids = (season: Season) =>
      searchFestivalsByConditions(list, {
        conditions: { kinds: [], season, prefectures: [] },
        sessionId: SESSION,
        today: TODAY,
      }).results.map((r) => r.candidate.festivalId);
    expect(ids("winter")).toEqual(["jan"]);
    expect(ids("spring")).toEqual(["mar"]);
  });
});

describe("種類の判定", () => {
  it("強い一致と弱い一致を仕様の表のとおりに分ける", () => {
    expect(matchKind(festival("a", { category: "fireworks" }), "fireworks")).toBe("strong");
    expect(
      matchKind(
        festival("a", { category: "float", highlights: ["最後に花火が上がる"] }),
        "fireworks",
      ),
    ).toBe("weak");
    expect(
      matchKind(
        festival("a", { category: "float", highlights: ["花火はありません"] }),
        "fireworks",
      ),
    ).toBeNull();

    expect(matchKind(festival("a", { styles: ["community"] }), "community")).toBe("strong");
    expect(matchKind(festival("a", { scaleTier: "M" }), "community")).toBe("weak");
    expect(matchKind(festival("a", { scaleTier: "L" }), "community")).toBeNull();
    expect(matchKind(festival("a", { popularity: "major" }), "community")).toBeNull();
    expect(matchKind(festival("a", { category: "fireworks" }), "community")).toBeNull();
    // 性格を調べた祭りで community がなければ、弱い一致にもしない
    expect(matchKind(festival("a", { styles: ["traditional"] }), "community")).toBeNull();

    expect(matchKind(festival("a", { styles: ["traditional"] }), "traditional")).toBe("strong");
    const old = { trivia: ["江戸時代に始まったと伝わる"] };
    expect(matchKind(festival("a", old), "traditional")).toBe("weak");
    expect(matchKind(festival("a", { ...old, category: "market" }), "traditional")).toBeNull();
    expect(matchKind(festival("a", { ...old, category: "fireworks" }), "traditional")).toBeNull();
    expect(matchKind(festival("a", { ...old, styles: ["community"] }), "traditional")).toBeNull();
    expect(matchKind(festival("a", { trivia: ["昨年はじめて開いた"] }), "traditional")).toBeNull();

    expect(matchKind(festival("a", { participation: "join_open" }), "participatory")).toBe(
      "strong",
    );
    expect(matchKind(festival("a", { participation: "unknown" }), "participatory")).toBeNull();
    expect(matchKind(festival("a", { popularity: "local" }), "hidden")).toBe("strong");
    expect(matchKind(festival("a", { popularity: "regional" }), "hidden")).toBeNull();
    expect(matchKind(festival("a", { popularity: "major" }), "famous")).toBe("strong");
    expect(matchKind(festival("a", { popularity: "regional", scaleTier: "L" }), "famous")).toBe(
      "weak",
    );
    expect(
      matchKind(festival("a", { popularity: "regional", scaleTier: "M" }), "famous"),
    ).toBeNull();
  });

  it("軸の中はどれか、軸どうしはすべて合う祭りを出す", () => {
    const list = [
      festival("firework-local", { category: "fireworks", popularity: "local" }),
      festival("firework-major", { category: "fireworks", popularity: "major" }),
      festival("old-local", { popularity: "local", styles: ["traditional"] }),
      festival("old-major", { popularity: "major", styles: ["traditional"] }),
    ];
    const ids = (kinds: FestivalKind[]) =>
      searchFestivalsByConditions(list, {
        conditions: { kinds, season: null, prefectures: [] },
        sessionId: SESSION,
        today: TODAY,
      })
        .results.map((r) => r.candidate.festivalId)
        .sort();
    expect(ids(["fireworks", "traditional"])).toEqual([
      "firework-local",
      "firework-major",
      "old-local",
      "old-major",
    ]);
    expect(ids(["traditional", "hidden"])).toEqual(["old-local"]);
    expect(ids(["hidden", "famous"])).toEqual([
      "firework-local",
      "firework-major",
      "old-local",
      "old-major",
    ]);
  });

  it("強い一致を弱い一致より先に、確かめられている祭りを先に並べる", () => {
    const list = [
      festival("weak-confirmed", { date: "2026-08-02" }),
      festival("strong-unconfirmed", {
        date: "2026-08-03",
        styles: ["community"],
        status: "expected",
      }),
      festival("strong-confirmed", { date: "2026-08-04", styles: ["community"] }),
    ];
    const ids = searchFestivalsByConditions(list, {
      conditions: { kinds: ["community"], season: null, prefectures: [] },
      sessionId: SESSION,
      today: TODAY,
    }).results.map((r) => r.candidate.festivalId);
    expect(ids).toEqual(["strong-confirmed", "strong-unconfirmed", "weak-confirmed"]);
  });

  it("申し込みの要る参加型は、理由に必ず添える", () => {
    const [result] = searchFestivalsByConditions(
      [
        festival("apply", {
          participation: "join_by_application",
          styles: ["traditional", "community"],
          popularity: "local",
        }),
      ],
      {
        conditions: {
          kinds: ["traditional", "community", "hidden", "participatory"],
          season: null,
          prefectures: [],
        },
        sessionId: SESSION,
        wish: "灯籠",
        today: TODAY,
      },
    ).results;
    expect(result?.reasons).toContain("参加には申し込みが必要です");
    expect(result?.reasons.length).toBeLessThanOrEqual(3);
    expect(result?.matchedKinds).toEqual(
      expect.arrayContaining(["traditional", "community", "hidden", "participatory"]),
    );
  });
});

describe("偏りを抑えて選ぶ", () => {
  it("種類に強く合う祭りが残っているなら、同じ category が3件を超えても弱く合う祭りを混ぜない", () => {
    const fireworks = PREFECTURES.flatMap((prefecture, i) =>
      [0, 1].map((n) => festival(`hanabi-${i}-${n}`, { category: "fireworks", prefecture })),
    );
    const weak = PREFECTURES.map((prefecture, i) =>
      festival(`mikoshi-${i}`, {
        category: "mikoshi",
        prefecture,
        highlights: ["夜に上がる花火と神輿"],
      }),
    );

    const { results, remaining } = searchFestivalsByConditions([...weak, ...fireworks], {
      conditions: { kinds: ["fireworks"], season: null, prefectures: [] },
      sessionId: SESSION,
      today: TODAY,
    });

    expect(results).toHaveLength(6);
    expect(results.every((r) => r.candidate.festivalId.startsWith("hanabi-"))).toBe(true);
    expect(remaining).toBe(fireworks.length + weak.length - 6);
  });

  it("強く合う祭りを見終えたら、弱く合う祭りを続けて出す", () => {
    const fireworks = [festival("hanabi", { category: "fireworks" })];
    const weak = [festival("mikoshi", { category: "mikoshi", highlights: ["夜に上がる花火"] })];

    const { results } = searchFestivalsByConditions([...weak, ...fireworks], {
      conditions: { kinds: ["fireworks"], season: null, prefectures: [] },
      sessionId: SESSION,
      today: TODAY,
    });

    expect(results.map((r) => r.candidate.festivalId)).toEqual(["hanabi", "mikoshi"]);
  });

  it("全国の6件で、同じ県は2件まで、同じ category は3件まで", () => {
    const list = PREFECTURES.flatMap((prefecture, p) =>
      CATEGORIES.slice(0, 4).flatMap((category, c) =>
        [0, 1, 2].map((n) => festival(`f-${p}-${c}-${n}`, { prefecture, category })),
      ),
    );
    const { results } = searchFestivalsByConditions(list, {
      conditions: { kinds: [], season: null, prefectures: [] },
      sessionId: SESSION,
      today: TODAY,
    });
    expect(results).toHaveLength(6);
    const count = (key: (id: string) => string) => {
      const counts = new Map<string, number>();
      for (const r of results) {
        const k = key(r.candidate.festivalId);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      return Math.max(...counts.values());
    };
    expect(count((id) => id.split("-")[1] as string)).toBeLessThanOrEqual(2);
    expect(count((id) => id.split("-")[2] as string)).toBeLessThanOrEqual(3);
  });

  it("足りないときは上限を緩めて6件を埋める", () => {
    const list = [0, 1, 2, 3, 4, 5, 6, 7].map((n) =>
      festival(`same-${n}`, { prefecture: "滋賀県", category: "float" }),
    );
    const response = searchFestivalsByConditions(list, {
      conditions: { kinds: [], season: null, prefectures: ["滋賀県", "京都府"] },
      sessionId: SESSION,
      today: TODAY,
    });
    expect(response.results).toHaveLength(6);
    expect(response.remaining).toBe(2);
  });

  it("地域が1県なら県の上限は数えず、種類の上限だけを見る", () => {
    const list = CATEGORIES.slice(0, 3).flatMap((category, c) =>
      [0, 1, 2, 3].map((n) => festival(`f-${c}-${n}`, { prefecture: "滋賀県", category })),
    );
    const { results } = searchFestivalsByConditions(list, {
      conditions: { kinds: [], season: null, prefectures: ["滋賀県"] },
      sessionId: SESSION,
      today: TODAY,
    });
    expect(results).toHaveLength(6);
    const perCategory = new Map<string, number>();
    for (const r of results) {
      const c = r.candidate.festivalId.split("-")[1] as string;
      perCategory.set(c, (perCategory.get(c) ?? 0) + 1);
    }
    expect(Math.max(...perCategory.values())).toBeLessThanOrEqual(3);
  });

  it("希望に合う祭りが残っているのに、偏りを抑えるために合わない祭りを出さない", () => {
    const list = [
      ...[0, 1, 2, 3, 4, 5, 6].map((n) =>
        festival(`fire-${n}`, {
          category: "fireworks",
          prefecture: PREFECTURES[n % 6] as Prefecture,
        }),
      ),
      ...[0, 1, 2].map((n) => festival(`other-${n}`, { category: "ritual" })),
    ];
    const { results } = searchFestivalsByConditions(list, {
      conditions: { kinds: [], season: null, prefectures: [] },
      sessionId: SESSION,
      wish: "花火が見たい",
      today: TODAY,
    });
    expect(results).toHaveLength(6);
    expect(results.every((r) => r.candidate.festivalId.startsWith("fire-"))).toBe(true);
    expect(results.every((r) => r.wishFit === "matched")).toBe(true);
  });
});

describe("別の祭りを提案してもらう", () => {
  let festivals: Festival[];
  beforeAll(() => {
    festivals = manyFestivals();
  });

  function walk(conditions: FestivalSearchConditions, sessionId: string, wish?: string) {
    const pages: string[][] = [];
    const seen: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      const response = searchFestivalsByConditions(festivals, {
        conditions,
        sessionId,
        excludeIds: seen,
        ...(wish === undefined ? {} : { wish }),
        today: TODAY,
      });
      const ids = response.results.map((r) => r.candidate.festivalId);
      pages.push(ids);
      seen.push(...ids);
      if (response.remaining === 0) return { pages, seen, last: response };
    }
    throw new Error("見終わりませんでした");
  }

  it("見終えるまで同じ祭りが出ず、合う祭りをすべて見られる", () => {
    for (const kinds of [[], ["traditional"], ["participatory", "hidden"]] as FestivalKind[][]) {
      for (const season of [null, "summer"] as const) {
        for (const prefectures of AREAS.slice(0, 5)) {
          for (const wish of [undefined, "夜の屋台"]) {
            const conditions = { kinds, season, prefectures };
            const { seen } = walk(conditions, SESSION, wish);
            expect(new Set(seen).size).toBe(seen.length);
            expect([...seen].sort()).toEqual(
              festivals
                .filter((f) => satisfies(f, conditions))
                .map((f) => f.id)
                .sort(),
            );
          }
        }
      }
    }
  });

  it("同じ相談では同じ順になり、相談が違えば順が変わる", () => {
    const conditions = { kinds: [], season: null, prefectures: [] };
    expect(walk(conditions, SESSION).pages).toEqual(walk(conditions, SESSION).pages);
    expect(walk(conditions, SESSION).seen).not.toEqual(walk(conditions, "session-b").seen);
  });

  it("見せた祭りを除いても、残りの順はずれない", () => {
    const list = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) =>
      festival(`f-${n}`, { prefecture: PREFECTURES[n % 6] as Prefecture, category: "ritual" }),
    );
    const search = (excludeIds: string[]) =>
      searchFestivalsByConditions(list, {
        conditions: { kinds: [], season: null, prefectures: ["滋賀県", "京都府", "富山県"] },
        sessionId: SESSION,
        excludeIds,
        today: TODAY,
      });
    const first = search([]).results.map((r) => r.candidate.festivalId);
    const again = search([]).results.map((r) => r.candidate.festivalId);
    expect(again).toEqual(first);
    // 1件目を除いても、ほかの祭りどうしの前後は変わらない
    const without = search(first.slice(0, 1)).results.map((r) => r.candidate.festivalId);
    const shared = without.filter((id) => first.includes(id));
    expect(shared).toEqual(first.filter((id) => shared.includes(id)));
  });

  it("見終えたら remaining は 0 で、次の手を返す", () => {
    const { last } = walk(
      { kinds: ["hidden"], season: "summer", prefectures: ["滋賀県"] },
      SESSION,
    );
    expect(last.remaining).toBe(0);
    expect(last.next.at(-1)?.kind).toBe("edit_conditions");
  });

  it("まだ残りがあるときは次の手を出さない", () => {
    const response = searchFestivalsByConditions(festivals, {
      conditions: { kinds: [], season: null, prefectures: [] },
      sessionId: SESSION,
      today: TODAY,
    });
    expect(response.remaining).toBeGreaterThan(0);
    expect(response.next).toEqual([]);
    expect(response.nearMatches).toEqual([]);
  });
});

describe("見つからないとき", () => {
  const list = [
    // 条件（花火・夏・滋賀県）のうち1つだけ外れる祭り
    festival("wrong-season", { category: "fireworks", date: "2026-10-10", prefecture: "滋賀県" }),
    festival("wrong-area-near", {
      category: "fireworks",
      date: "2026-08-10",
      prefecture: "京都府",
    }),
    festival("wrong-area-far", { category: "fireworks", date: "2026-08-10", prefecture: "沖縄県" }),
    festival("wrong-kind", { category: "ritual", date: "2026-08-10", prefecture: "滋賀県" }),
    // 2つ外れる祭りは出さない
    festival("two-misses", { category: "ritual", date: "2026-10-10", prefecture: "沖縄県" }),
    festival("past-only", { category: "fireworks", date: "2026-06-01", prefecture: "滋賀県" }),
  ];
  const conditions: FestivalSearchConditions = {
    kinds: ["fireworks"],
    season: "summer",
    prefectures: ["滋賀県"],
  };

  it("外れている点つきの祭りと、数えた次の手を返す", () => {
    const response = searchFestivalsByConditions(list, {
      conditions,
      sessionId: SESSION,
      today: TODAY,
    });
    expect(response.results).toEqual([]);
    expect(response.remaining).toBe(0);
    const miss = Object.fromEntries(
      response.nearMatches.map((n) => [n.result.candidate.festivalId, n.miss]),
    );
    expect(Object.keys(miss).sort()).toEqual([
      "wrong-area-far",
      "wrong-area-near",
      "wrong-kind",
      "wrong-season",
    ]);
    expect(miss["wrong-season"]).toContain("夏ではなく");
    expect(miss["wrong-season"]).toContain("10月10日");
    expect(miss["wrong-area-near"]).toContain("京都府");
    expect(miss["wrong-kind"]).toContain("花火");
    expect(
      response.nearMatches.find((n) => n.result.candidate.festivalId === "wrong-season")?.result
        .candidate.date,
    ).toBe("2026-10-10");

    const found = Object.fromEntries(response.next.map((n) => [n.kind, n.found]));
    expect(found).toEqual({
      any_season: 1,
      any_kind: 1,
      neighbor_area: 1,
      nationwide: 2,
      edit_conditions: null,
    });
    expect(() => FestivalSearchResponseSchema.parse(response)).not.toThrow();
  });

  it("隣の県の手は、隣の県を足した条件を返し、隣の県を先に見せる", () => {
    const response = searchFestivalsByConditions(list, {
      conditions,
      sessionId: SESSION,
      today: TODAY,
    });
    const neighbor = response.next.find((n) => n.kind === "neighbor_area");
    expect(neighbor?.conditions?.prefectures).toEqual(["滋賀県", ...neighborsOf(["滋賀県"])]);
    const areaIds = response.nearMatches
      .map((n) => n.result.candidate.festivalId)
      .filter((id) => id.startsWith("wrong-area"));
    expect(areaIds).toEqual(["wrong-area-near", "wrong-area-far"]);
  });

  it("次の手の条件で探し直すと、数えたとおりの祭りが出る", () => {
    const response = searchFestivalsByConditions(list, {
      conditions,
      sessionId: SESSION,
      today: TODAY,
    });
    for (const step of response.next) {
      if (step.conditions === null) continue;
      const again = searchFestivalsByConditions(list, {
        conditions: step.conditions,
        sessionId: SESSION,
        today: TODAY,
      });
      expect(again.results.length + again.remaining).toBe(step.found);
    }
  });

  it("祭りの見つからない次の手は出さず、隣のない県では隣の手を出さない", () => {
    const response = searchFestivalsByConditions(
      [festival("only", { category: "ritual", date: "2026-10-10", prefecture: "滋賀県" })],
      {
        conditions: { kinds: ["fireworks"], season: "summer", prefectures: ["沖縄県"] },
        sessionId: SESSION,
        today: TODAY,
      },
    );
    expect(response.next.map((n) => n.kind)).toEqual(["edit_conditions"]);
  });

  it("条件のないときは1つだけ外す祭りがなく、選び直す手だけを返す", () => {
    const response = searchFestivalsByConditions([], {
      conditions: { kinds: [], season: null, prefectures: [] },
      sessionId: SESSION,
      today: TODAY,
    });
    expect(response).toEqual({
      results: [],
      remaining: 0,
      nearMatches: [],
      next: [{ kind: "edit_conditions", label: "条件を選び直す", conditions: null, found: null }],
      reading: null,
    });
  });

  it("見終えたあとの次の手は、見せた祭りを数えず、1つ外す祭りにも入れない", () => {
    const response = searchFestivalsByConditions(list, {
      conditions: { kinds: ["fireworks"], season: "summer", prefectures: [] },
      sessionId: SESSION,
      excludeIds: ["wrong-area-near", "wrong-area-far"],
      today: TODAY,
    });
    expect(response.results).toEqual([]);
    expect(response.next.find((n) => n.kind === "any_season")?.found).toBe(1);
    const ids = response.nearMatches.map((n) => n.result.candidate.festivalId);
    expect(ids).not.toContain("wrong-area-near");
    expect(ids).toContain("wrong-season");
  });

  it("掲載停止の祭りは、1つ外す祭りにも次の手の数にも入れない", () => {
    const response = searchFestivalsByConditions(
      [festival("hidden-away", { category: "fireworks", date: "2026-10-10", optOut: true })],
      {
        conditions: { kinds: ["fireworks"], season: "summer", prefectures: [] },
        sessionId: SESSION,
        today: TODAY,
      },
    );
    expect(response.nearMatches).toEqual([]);
    expect(response.next.map((n) => n.kind)).toEqual(["edit_conditions"]);
  });
});
