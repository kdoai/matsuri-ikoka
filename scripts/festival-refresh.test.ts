import { describe, expect, it } from "vitest";
import { type Festival, type FestivalInput, FestivalSchema } from "../packages/schema/src";
import { fictionalFestival, fictionalSource } from "../packages/schema/src/testing";
import {
  classifyFestivalChange,
  requestsFromIssues,
  selectRefreshTargets,
} from "./festival-refresh";

// 架空の祭りの出典は 2026-04-01 に確認、開催は 2026-08-16（announced）
function festivalOf(edit: (festival: FestivalInput) => void = () => {}): Festival {
  const festival = fictionalFestival();
  edit(festival);
  return FestivalSchema.parse(festival);
}

describe("selectRefreshTargets", () => {
  it("確認が新しく、開催が先で、発表済みなら選ばない", () => {
    expect(selectRefreshTargets([festivalOf()], { today: "2026-04-02" })).toEqual([]);
  });

  it("開催回が見込み（expected）のままなら選ぶ", () => {
    const festival = festivalOf((f) => {
      f.occurrences[0] = { ...f.occurrences[0]!, status: "expected" };
    });
    const [target] = selectRefreshTargets([festival], { today: "2026-04-02" });
    expect(target).toMatchObject({ id: "suzunari-toro", reasons: ["expected"] });
    expect(target?.nextDate).toBe("2026-08-16");
  });

  it("終わった開催回が見込みのままでも、それだけでは選ばない", () => {
    const festival = festivalOf((f) => {
      f.occurrences = [
        { ...f.occurrences[0]!, date: "2026-03-01", status: "expected" },
        f.occurrences[0]!,
      ];
    });
    expect(selectRefreshTargets([festival], { today: "2026-04-02" })).toEqual([]);
  });

  it("開催が近ければ選ぶ（日数は変えられる）", () => {
    // すべての出典を開催の直前に確かめ直した状態にする
    const festival = FestivalSchema.parse(
      JSON.parse(JSON.stringify(fictionalFestival()).replaceAll("2026-04-01", "2026-07-30")),
    );
    const options = { today: "2026-08-01" } as const;
    expect(selectRefreshTargets([festival], options)[0]?.reasons).toEqual(["upcoming"]);
    expect(selectRefreshTargets([festival], { ...options, upcomingWithinDays: 7 })).toEqual([]);
  });

  it("確認日が期限を過ぎた項目があれば、その項目を手がかりに付けて選ぶ", () => {
    // 周辺の場所の期限は30日
    const [target] = selectRefreshTargets([festivalOf()], { today: "2026-05-15" });
    expect(target?.reasons).toEqual(["stale"]);
    expect(target?.notes.some((note) => note.startsWith("nearby.0"))).toBe(true);
  });

  it("依頼のある祭りを選び、依頼の種類を手がかりに付ける", () => {
    const [target] = selectRefreshTargets([festivalOf()], {
      today: "2026-04-02",
      requests: [{ festivalId: "suzunari-toro", kind: "correction" }],
    });
    expect(target).toMatchObject({ reasons: ["request"], notes: ["依頼：訂正"] });
  });

  it("データにない祭りへの依頼は、対象を増やさない", () => {
    const targets = selectRefreshTargets([festivalOf()], {
      today: "2026-04-02",
      requests: [{ festivalId: "unknown-festival", kind: "discrepancy" }],
    });
    expect(targets).toEqual([]);
  });

  it("掲載停止の祭りは、依頼や見込みがあっても選ばない", () => {
    const festival = festivalOf((f) => {
      f.optOut = true;
      f.occurrences[0] = { ...f.occurrences[0]!, status: "expected" };
    });
    const targets = selectRefreshTargets([festival], {
      today: "2026-05-15",
      requests: [{ festivalId: "suzunari-toro", kind: "correction" }],
    });
    expect(targets).toEqual([]);
  });

  it("依頼のあるもの、開催が近いもの、id の順に並べる", () => {
    const at = (id: string, date: string) =>
      festivalOf((f) => {
        f.id = id;
        f.occurrences[0] = { ...f.occurrences[0]!, date, status: "expected" };
      });
    const targets = selectRefreshTargets(
      [at("b-matsuri", "2026-09-01"), at("c-matsuri", "2026-08-20"), at("a-matsuri", "2026-09-01")],
      { today: "2026-04-02", requests: [{ festivalId: "b-matsuri", kind: "listing" }] },
    );
    expect(targets.map((t) => t.id)).toEqual(["b-matsuri", "c-matsuri", "a-matsuri"]);
  });
});

describe("classifyFestivalChange", () => {
  const before = festivalOf();

  it("変わっていなければ種類はなく、自動の側に入る", () => {
    expect(classifyFestivalChange(before, festivalOf())).toEqual({
      id: "suzunari-toro",
      kinds: [],
      review: "auto",
      urgent: false,
    });
  });

  it("確認した日の更新だけなら自動", () => {
    const after = festivalOf((f) => {
      f.occurrences[0]!.sources[0] = { ...f.occurrences[0]!.sources[0]!, checkedAt: "2026-05-01" };
    });
    expect(classifyFestivalChange(before, after)).toMatchObject({
      kinds: ["checked_only"],
      review: "auto",
    });
  });

  it("出典の追加と確度が上がるのは自動", () => {
    const after = festivalOf((f) => {
      f.sources.push(fictionalSource("press", "single"));
      f.nearby[0]!.sources[0] = { ...f.nearby[0]!.sources[0]!, confidence: "official" };
    });
    expect(classifyFestivalChange(before, after)).toMatchObject({
      kinds: ["source_added", "confidence_up"],
      review: "auto",
    });
  });

  it("知名度の付け直しは自動", () => {
    const after = festivalOf((f) => {
      f.popularity = "regional";
      f.listedIn = ["example-guide"];
    });
    expect(classifyFestivalChange(before, after)).toMatchObject({
      kinds: ["popularity"],
      review: "auto",
    });
  });

  it("新しい祭りは人が確かめる", () => {
    expect(classifyFestivalChange(null, before)).toMatchObject({
      kinds: ["added"],
      review: "human",
    });
  });

  it("開催日・時間・会場の変更は人が確かめる", () => {
    for (const edit of [
      (f: FestivalInput) => {
        f.occurrences[0] = { ...f.occurrences[0]!, start: "19:00" };
      },
      (f: FestivalInput) => {
        f.venue = { ...f.venue, name: "鈴鳴川の中州" };
      },
    ]) {
      expect(classifyFestivalChange(before, festivalOf(edit))).toMatchObject({
        kinds: ["schedule"],
        review: "human",
      });
    }
  });

  it("日付が変われば、そこに付いた出典は消えて増えたとみなす", () => {
    const after = festivalOf((f) => {
      f.occurrences[0] = { ...f.occurrences[0]!, date: "2026-08-17" };
    });
    expect(classifyFestivalChange(before, after).kinds).toEqual([
      "schedule",
      "source_removed",
      "source_added",
    ]);
  });

  it("中止・延期は人が確かめ、優先して知らせる", () => {
    const after = festivalOf((f) => {
      f.occurrences[0] = { ...f.occurrences[0]!, status: "cancelled" };
    });
    expect(classifyFestivalChange(before, after)).toMatchObject({
      kinds: ["cancelled_or_postponed"],
      review: "human",
      urgent: true,
    });
  });

  it("見込みから発表への確定は、人が確かめる", () => {
    const expected = festivalOf((f) => {
      f.occurrences[0] = { ...f.occurrences[0]!, status: "expected" };
    });
    expect(classifyFestivalChange(expected, before)).toMatchObject({
      kinds: ["status_confirmed"],
      review: "human",
    });
  });

  it("確度が下がる・出典が消えるのは人が確かめる", () => {
    const after = festivalOf((f) => {
      f.etiquette.sources[0] = { ...f.etiquette.sources[0]!, confidence: "single" };
      f.access.sources = [fictionalSource("access-new")];
    });
    expect(classifyFestivalChange(before, after)).toMatchObject({
      kinds: ["confidence_down", "source_removed", "source_added"],
      review: "human",
    });
  });

  it("確認日の更新とほかの変更が一緒なら、確認日の更新は種類に数えない", () => {
    const after = festivalOf((f) => {
      f.sources[0] = { ...f.sources[0]!, checkedAt: "2026-05-01" };
      f.etiquette.bring = [...f.etiquette.bring, "うちわ"];
    });
    expect(classifyFestivalChange(before, after).kinds).toEqual(["etiquette"]);
  });

  it("作法・周辺の場所・掲載停止・そのほかの中身の変更は人が確かめる", () => {
    const after = festivalOf((f) => {
      f.etiquette.rules = ["灯籠は係の合図のあとに流す"];
      f.nearby[0] = { ...f.nearby[0]!, price: null };
      f.optOut = true;
      f.highlights = ["川面に浮かぶ千の灯籠"];
    });
    expect(classifyFestivalChange(before, after)).toMatchObject({
      kinds: ["opt_out", "etiquette", "nearby", "other"],
      review: "human",
    });
  });

  it("並びが変わっただけの周辺の場所の出典は、同じ出典とみなす", () => {
    const twoSpots = festivalOf((f) => {
      f.nearby.push({ ...f.nearby[0]!, id: "suzunari-tea-house", name: "鈴鳴茶屋" });
    });
    const swapped = festivalOf((f) => {
      f.nearby = [{ ...f.nearby[0]!, id: "suzunari-tea-house", name: "鈴鳴茶屋" }, f.nearby[0]!];
    });
    expect(classifyFestivalChange(twoSpots, swapped).kinds).toEqual(["nearby"]);
  });
});

describe("requestsFromIssues", () => {
  // Issue のフォームが本文に書く形
  const bodyOf = (festival: string) =>
    `### 祭りの名前\n\n${festival}\n\n### 正しい内容\n\n開催日が違います\n`;
  const other = () =>
    festivalOf((f) => {
      f.id = "kazane-odori";
      f.name = { ja: "風音踊り" };
    });

  it("欄に書かれた ID で祭りを決め、ラベルから依頼の種類を決める", () => {
    const issues = [
      { number: 1, body: bodyOf("鈴鳴の灯籠（suzunari-toro）"), labels: ["data-correction"] },
      { number: 2, body: bodyOf("kazane-odori"), labels: ["opt-out", "priority:high"] },
    ];
    expect(requestsFromIssues(issues, [festivalOf(), other()])).toEqual({
      requests: [
        { festivalId: "suzunari-toro", kind: "correction" },
        { festivalId: "kazane-odori", kind: "opt_out" },
      ],
      unresolved: [],
    });
  });

  it("ID がなければ名前で探す（全角・半角や大文字・小文字の違いはならす）", () => {
    const issues = [
      { number: 1, body: bodyOf("鈴鳴灯籠まつり"), labels: ["listing-request"] },
      { number: 2, body: bodyOf("ＳＵＺＵＮＡＲＩ Lantern Festival"), labels: ["data-correction"] },
    ];
    expect(requestsFromIssues(issues, [festivalOf(), other()]).requests).toEqual([
      { festivalId: "suzunari-toro", kind: "listing" },
      { festivalId: "suzunari-toro", kind: "correction" },
    ]);
  });

  it("決められない依頼は、理由をつけて人に回す", () => {
    const issues = [
      { number: 1, body: bodyOf("どこかの知らない祭り"), labels: ["data-correction"] },
      { number: 2, body: bodyOf("鈴鳴灯籠まつりと風音踊り"), labels: ["data-correction"] },
      { number: 3, body: "### 祭りの名前\n\n_No response_\n", labels: ["data-correction"] },
    ];
    expect(requestsFromIssues(issues, [festivalOf(), other()])).toEqual({
      requests: [],
      unresolved: [
        { number: 1, reason: "not_found" },
        { number: 2, reason: "ambiguous" },
        { number: 3, reason: "no_field" },
      ],
    });
  });

  it("ID の一部だけが一致しても、その祭りとはみなさない", () => {
    const issues = [{ number: 1, body: bodyOf("suzunari-toro-2"), labels: ["data-correction"] }];
    expect(requestsFromIssues(issues, [festivalOf()]).unresolved).toEqual([
      { number: 1, reason: "not_found" },
    ]);
  });

  it("依頼のラベルのない Issue は見ない", () => {
    const issues = [{ number: 1, body: bodyOf("suzunari-toro"), labels: ["bug"] }];
    expect(requestsFromIssues(issues, [festivalOf()])).toEqual({ requests: [], unresolved: [] });
  });

  it("決めた依頼は、調べ直す対象の先頭に並ぶ", () => {
    const issues = [{ number: 1, body: bodyOf("kazane-odori"), labels: ["data-correction"] }];
    const festivals = [festivalOf(), other()];
    const { requests } = requestsFromIssues(issues, festivals);
    const [first] = selectRefreshTargets(festivals, { today: "2026-05-15", requests });
    expect(first).toMatchObject({ id: "kazane-odori", reasons: ["request", "stale"] });
  });
});
