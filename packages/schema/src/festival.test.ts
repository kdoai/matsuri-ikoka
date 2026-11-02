import { describe, expect, it } from "vitest";
import {
  type Etiquette,
  EtiquetteSchema,
  FestivalSchema,
  isOccurrenceConfirmed,
  type Occurrence,
  OccurrenceSchema,
  unknownEtiquetteItems,
} from "./festival";
import { fictionalFestival, fictionalSource } from "./testing";

function allUnknownEtiquette(): Etiquette {
  return {
    participation: "unknown",
    howToJoin: null,
    rules: "unknown",
    dress: "unknown",
    bring: "unknown",
    risk: "unknown",
    photo: "unknown",
    sources: [],
  };
}

describe("FestivalSchema", () => {
  it("架空の祭りのデータを受け付ける", () => {
    expect(FestivalSchema.safeParse(fictionalFestival()).success).toBe(true);
  });

  it("optOut は省略すると false になる", () => {
    expect(FestivalSchema.parse(fictionalFestival()).optOut).toBe(false);
  });

  it("知らない項目があれば不正（綴りの誤りに気づけるように）", () => {
    expect(FestivalSchema.safeParse({ ...fictionalFestival(), popular: "local" }).success).toBe(
      false,
    );
  });

  describe("情報の壁：出典は必須", () => {
    it("出典のない祭りは不正", () => {
      expect(FestivalSchema.safeParse({ ...fictionalFestival(), sources: [] }).success).toBe(false);
    });

    it("出典のない開催回は不正", () => {
      const festival = fictionalFestival();
      festival.occurrences = [{ ...festival.occurrences[0]!, sources: [] }];
      expect(FestivalSchema.safeParse(festival).success).toBe(false);
    });

    it("出典のない小話は不正", () => {
      const festival = fictionalFestival();
      festival.trivia = [{ text: "出典のない話" } as never];
      expect(FestivalSchema.safeParse(festival).success).toBe(false);
    });

    it("分かっているアクセス情報に出典がなければ不正", () => {
      const festival = fictionalFestival();
      festival.access = { ...festival.access, sources: [] };
      expect(FestivalSchema.safeParse(festival).success).toBe(false);
    });

    it("アクセスがすべて分からないときは、出典なしでもよい", () => {
      const festival = fictionalFestival();
      festival.access = {
        stations: [],
        fromHubs: [],
        parking: "unknown",
        trafficRestrictions: [],
        sources: [],
      };
      festival.gaps = ["アクセス"];
      expect(FestivalSchema.safeParse(festival).success).toBe(true);
    });

    it("分からない開始時刻は推測で埋めず、null にできる", () => {
      const festival = fictionalFestival();
      festival.occurrences = [{ ...festival.occurrences[0]!, start: null, end: null }];
      festival.gaps = ["開始・終了の時刻"];
      expect(FestivalSchema.safeParse(festival).success).toBe(true);
    });
  });

  describe("作法の壁：作法は省略できない", () => {
    it("作法のない祭りは不正", () => {
      const { etiquette: _, ...rest } = fictionalFestival();
      expect(FestivalSchema.safeParse(rest).success).toBe(false);
    });

    it.each(["participation", "rules", "dress", "bring", "risk", "photo", "howToJoin"] as const)(
      "作法の項目 %s を省略すると不正",
      (item) => {
        const festival = fictionalFestival();
        const { [item]: _, ...rest } = festival.etiquette;
        expect(FestivalSchema.safeParse({ ...festival, etiquette: rest }).success).toBe(false);
      },
    );

    it("空の持ち物リストは不正（分からないなら unknown と書く）", () => {
      const festival = fictionalFestival();
      festival.etiquette = { ...festival.etiquette, bring: [] };
      expect(FestivalSchema.safeParse(festival).success).toBe(false);
    });
  });

  describe("祭りの範囲", () => {
    it("都道府県をまたぐ祭りを表せる", () => {
      const festival = fictionalFestival();
      festival.municipalities = [
        { prefecture: "滋賀県", name: "鈴鳴町" },
        { prefecture: "京都府", name: "川向町" },
      ];
      expect(FestivalSchema.safeParse(festival).success).toBe(true);
    });

    it("都道府県の名前は正式名だけ", () => {
      const festival = fictionalFestival();
      festival.municipalities = [{ prefecture: "滋賀" as never, name: "鈴鳴町" }];
      expect(FestivalSchema.safeParse(festival).success).toBe(false);
    });

    it("同じ日の開催回が重複していれば不正", () => {
      const festival = fictionalFestival();
      festival.occurrences = [festival.occurrences[0]!, festival.occurrences[0]!];
      expect(FestivalSchema.safeParse(festival).success).toBe(false);
    });

    it("周辺の場所の id が重複していれば不正", () => {
      const festival = fictionalFestival();
      festival.nearby = [festival.nearby[0]!, festival.nearby[0]!];
      expect(FestivalSchema.safeParse(festival).success).toBe(false);
    });

    it("61字以上の小話は不正", () => {
      const festival = fictionalFestival();
      festival.trivia = [{ text: "あ".repeat(61), source: fictionalSource("history") }];
      expect(FestivalSchema.safeParse(festival).success).toBe(false);
    });
  });
});

describe("EtiquetteSchema", () => {
  it("すべて unknown なら出典なしでもよい", () => {
    expect(EtiquetteSchema.safeParse(allUnknownEtiquette()).success).toBe(true);
  });

  it("1つでも分かっている項目があれば出典が必要", () => {
    const etiquette = { ...allUnknownEtiquette(), dress: ["上着"] };
    expect(EtiquetteSchema.safeParse(etiquette).success).toBe(false);
  });

  it("見学のみの祭りでは申し込み方法を書かない", () => {
    const etiquette = {
      ...fictionalFestival().etiquette,
      participation: "watch_only",
      howToJoin: "受付で申し込む",
    };
    expect(EtiquetteSchema.safeParse(etiquette).success).toBe(false);
  });

  it("申し込みが必要な祭りでは、申し込み方法か unknown を書く", () => {
    const base = fictionalFestival().etiquette;
    expect(EtiquetteSchema.safeParse({ ...base, howToJoin: null }).success).toBe(false);
    expect(EtiquetteSchema.safeParse({ ...base, howToJoin: "unknown" }).success).toBe(true);
  });
});

describe("unknownEtiquetteItems", () => {
  it("unknown の項目だけを返す", () => {
    const etiquette = { ...allUnknownEtiquette(), participation: "watch_only" as const };
    expect(unknownEtiquetteItems(etiquette)).toEqual(["rules", "dress", "bring", "risk", "photo"]);
  });

  it("すべて分かっていれば空", () => {
    expect(unknownEtiquetteItems(EtiquetteSchema.parse(fictionalFestival().etiquette))).toEqual([]);
  });
});

describe("OccurrenceSchema", () => {
  it("終わりの日は始まりの日以降", () => {
    const occurrence = { ...fictionalFestival().occurrences[0]!, endDate: "2026-08-15" };
    expect(OccurrenceSchema.safeParse(occurrence).success).toBe(false);
  });
});

describe("isOccurrenceConfirmed", () => {
  function occurrence(overrides: Partial<Occurrence>): Occurrence {
    return OccurrenceSchema.parse({ ...fictionalFestival().occurrences[0]!, ...overrides });
  }

  it("発表済みで公式の出典があれば確認済み", () => {
    expect(isOccurrenceConfirmed(occurrence({}))).toBe(true);
  });

  it("複数の情報源で一致していれば確認済み", () => {
    const sources = [fictionalSource("a", "corroborated")];
    expect(isOccurrenceConfirmed(occurrence({ sources }))).toBe(true);
  });

  it("1つの情報源だけなら未確認", () => {
    const sources = [fictionalSource("a", "single")];
    expect(isOccurrenceConfirmed(occurrence({ sources }))).toBe(false);
  });

  it("例年からの見込み（未発表）なら、公式の出典があっても未確認", () => {
    expect(isOccurrenceConfirmed(occurrence({ status: "expected" }))).toBe(false);
  });
});
