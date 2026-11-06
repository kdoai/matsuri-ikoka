import { describe, expect, it } from "vitest";
import { type Festival, type FestivalInput, FestivalSchema } from "../packages/schema/src";
import { fictionalFestival, fictionalSource } from "../packages/schema/src/testing";
import {
  changedSources,
  classifyFestivalChange,
  type FestivalChange,
  refreshPullRequestBody,
  refreshReview,
  requestsFromIssues,
} from "./festival-refresh";

// 架空の祭りの出典は 2026-04-01 に確認、開催は 2026-08-16（announced）
function festivalOf(edit: (festival: FestivalInput) => void = () => {}): Festival {
  const festival = fictionalFestival();
  edit(festival);
  return FestivalSchema.parse(festival);
}

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
});

describe("changedSources", () => {
  const before = festivalOf();

  it("追加・更新・消えた出典を、その順に URL ごとに1つずつ出す", () => {
    const after = festivalOf((f) => {
      f.access.sources = [fictionalSource("access-new", "single")];
      f.sources[0] = { ...f.sources[0]!, checkedAt: "2026-05-01" };
    });
    const changes = changedSources(before, after);
    expect(changes[0]).toEqual({
      status: "added",
      url: "https://example.com/suzunari/access-new",
      confidence: "single",
      checkedAt: "2026-04-01",
    });
    expect(changes.map((c) => c.status)).toEqual(["added", "updated", "removed"]);
    expect(changes[1]).toMatchObject({ url: before.sources[0]!.url, checkedAt: "2026-05-01" });
    expect(changes[2]).toMatchObject({ url: before.access.sources[0]!.url });
  });

  it("新しい祭りは、すべての出典を追加として出す", () => {
    const changes = changedSources(null, before);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((c) => c.status === "added")).toBe(true);
    expect(new Set(changes.map((c) => c.url)).size).toBe(changes.length);
  });

  it("変わっていなければ空", () => {
    expect(changedSources(before, festivalOf())).toEqual([]);
  });
});

describe("refreshReview", () => {
  const auto: FestivalChange = { id: "a", kinds: [], review: "auto", urgent: false };
  const human: FestivalChange = { ...auto, review: "human" };

  it("すべて自動でよく、取り込まなかったものがなければ自動", () => {
    expect(refreshReview([auto, auto])).toBe("auto");
  });

  it("人が確かめるものか、取り込まなかったものが1つでもあれば人", () => {
    expect(refreshReview([auto, human])).toBe("human");
    expect(refreshReview([auto], [{ id: "b", reason: "スキーマに合わない" }])).toBe("human");
  });
});

describe("refreshPullRequestBody", () => {
  const before = festivalOf();
  const other = (edit: (festival: FestivalInput) => void = () => {}) =>
    festivalOf((f) => {
      f.id = "kazane-odori";
      f.name = { ja: "風音踊り" };
      edit(f);
    });

  it("中止・延期、人が確かめる、自動でよい、の順に、種類と変わった出典を書く", () => {
    const cancelled = festivalOf((f) => {
      f.occurrences[0] = { ...f.occurrences[0]!, status: "cancelled" };
    });
    const checked = other((f) => {
      f.sources.push(fictionalSource("press", "single"));
    });
    const unchanged = festivalOf((f) => {
      f.id = "hoshizora-taiko";
    });
    const body = refreshPullRequestBody([
      { before: other(), after: checked },
      { before, after: cancelled },
      { before: unchanged, after: unchanged },
    ]);
    expect(body).toContain("- マージ：人が確かめる");
    expect(body).toContain("- 変わった祭り：2 件（人が確かめる 1 件、自動でよい 1 件）");
    expect(body).toContain("- 変わらなかった祭り：1 件");
    expect(body.indexOf("### 優先して知らせる")).toBeLessThan(body.indexOf("### 自動でよい"));
    expect(body).not.toContain("### 人が確かめる");
    expect(body).toContain("- `suzunari-toro` 鈴鳴灯籠まつり：中止・延期");
    expect(body).toContain(
      "  - 出典の追加：<https://example.com/suzunari/press>（single、2026-04-01 に確認）",
    );
    expect(body).not.toContain("hoshizora-taiko");
  });

  it("すべて自動でよければ、そう書く", () => {
    const after = festivalOf((f) => {
      f.popularity = "regional";
    });
    expect(refreshPullRequestBody([{ before, after }])).toContain(
      "- マージ：CI が通れば自動でよい",
    );
  });

  it("取り込まなかった祭りを理由とともに書き、人が確かめる側にする", () => {
    const body = refreshPullRequestBody(
      [],
      [{ id: "kazane-odori", reason: "開催回の日付が読めない" }],
    );
    expect(body).toContain("- マージ：人が確かめる");
    expect(body).toContain("### 取り込まなかった祭り");
    expect(body).toContain("- `kazane-odori`：開催回の日付が読めない");
  });

  it("集めた文字列の Markdown の記号・通知・改行を打ち消す", () => {
    const after = other((f) => {
      f.name = { ja: "風音[踊り](https://example.com) @someone\n## 見出し" };
    });
    const body = refreshPullRequestBody(
      [{ before: other(), after }],
      [{ id: "`x`", reason: "<b>読めない</b>\n- 項目" }],
    );
    expect(body).toContain(String.raw`風音\[踊り\]\(https://example\.com\) \@someone \#\# 見出し`);
    expect(body).toContain(String.raw`- \`x\`：\<b\>読めない\</b\> \- 項目`);
    expect(body).not.toMatch(/^## 見出し/m);
  });
});
