import { describe, expect, it } from "vitest";
import {
  type Festival,
  type FestivalInput,
  FestivalSchema,
  type ResearchLedger,
  ResearchLedgerSchema,
} from "../packages/schema/src";
import { fictionalFestival } from "../packages/schema/src/testing";
import { validateResearchLedger } from "./festival-validation";
import {
  currentOccurrence,
  EMPTY_RESEARCH_LEDGER,
  nextCheckpointOn,
  recordResearchResult,
  retireEndedOccurrences,
  selectRefreshTargets,
  serializeResearchLedger,
} from "./research-schedule";

const TODAY = "2026-06-01";

function festivalOf(edit: (festival: FestivalInput) => void = () => {}): Festival {
  const festival = fictionalFestival();
  edit(festival);
  return FestivalSchema.parse(festival);
}

/** 発表のない（見込みのままの）祭り */
function expectedAt(id: string, date: string, edit: (f: FestivalInput) => void = () => {}) {
  return festivalOf((f) => {
    f.id = id;
    f.occurrences[0] = { ...f.occurrences[0]!, date, status: "expected" };
    edit(f);
  });
}

function ledgerOf(id: string, entry: Partial<ResearchLedger["festivals"][string]>): ResearchLedger {
  return {
    festivals: {
      [id]: {
        occurrenceDate: "2026-06-20",
        lastResearchedAt: "2026-05-01",
        result: "not_found",
        nextResearchOn: null,
        failures: 0,
        ...entry,
      },
    },
    officialNotFound: [],
  };
}

describe("selectRefreshTargets", () => {
  it("開催まで14日以内で未確定の祭りは、最低の件数を超えても全部選ぶ", () => {
    const festivals = ["a", "b", "c"].map((id) => expectedAt(`${id}-matsuri`, "2026-06-10"));
    const targets = selectRefreshTargets(festivals, { today: TODAY, minimum: 1 });
    expect(targets.map((t) => t.id)).toEqual(["a-matsuri", "b-matsuri", "c-matsuri"]);
    expect(targets.every((t) => t.reasons[0] === "due_soon")).toBe(true);
  });

  it("確定した開催回は、開催が近くても選ばない", () => {
    const festival = festivalOf((f) => {
      f.occurrences[0] = { ...f.occurrences[0]!, date: "2026-06-05", status: "announced" };
    });
    expect(selectRefreshTargets([festival], { today: TODAY })).toEqual([]);
  });

  it("中止と決まった開催回は選ばない", () => {
    const festival = expectedAt("a-matsuri", "2026-06-05", (f) => {
      f.occurrences[0]!.status = "cancelled";
    });
    expect(selectRefreshTargets([festival], { today: TODAY })).toEqual([]);
  });

  it("確定した回の次の回が見込みでも、確定した回が終わるまでは選ばない", () => {
    const festival = festivalOf((f) => {
      f.occurrences = [
        { ...f.occurrences[0]!, date: "2026-06-05", status: "announced" },
        { ...f.occurrences[0]!, date: "2026-06-12", status: "expected" },
      ];
    });
    expect(selectRefreshTargets([festival], { today: TODAY })).toEqual([]);
    expect(selectRefreshTargets([festival], { today: "2026-06-06" })[0]?.nextDate).toBe(
      "2026-06-12",
    );
  });

  it("最低の件数に満たなければ、まだ調べていない祭りを近い順に足す", () => {
    const festivals = [
      expectedAt("soon-matsuri", "2026-06-10"),
      expectedAt("far-matsuri", "2026-08-01"),
      expectedAt("near-matsuri", "2026-07-01"),
    ];
    const targets = selectRefreshTargets(festivals, { today: TODAY, minimum: 2 });
    expect(targets.map((t) => [t.id, t.reasons])).toEqual([
      ["soon-matsuri", ["due_soon"]],
      ["near-matsuri", ["fill"]],
    ]);
  });

  it("最低の件数を満たしていれば、足さない", () => {
    const festivals = [
      expectedAt("soon-matsuri", "2026-06-10"),
      expectedAt("far-matsuri", "2026-07-01"),
    ];
    const targets = selectRefreshTargets(festivals, { today: TODAY, minimum: 1 });
    expect(targets.map((t) => t.id)).toEqual(["soon-matsuri"]);
  });

  it("先読みの上限より先の祭りは、足さない", () => {
    const festivals = [expectedAt("edge-matsuri", "2026-09-29"), expectedAt("over", "2026-09-30")];
    const targets = selectRefreshTargets(festivals, { today: TODAY });
    expect(targets.map((t) => t.id)).toEqual(["edge-matsuri"]);
  });

  it("待ちのフラグが立っている祭りは、最低の件数に満たなくても足さない", () => {
    const festival = expectedAt("a-matsuri", "2026-07-20");
    const ledger = ledgerOf("a-matsuri", {
      occurrenceDate: "2026-07-20",
      nextResearchOn: "2026-06-20",
    });
    expect(selectRefreshTargets([festival], { today: TODAY, ledger })).toEqual([]);
  });

  it("節目の日が来たら、また選ぶ", () => {
    const festival = expectedAt("a-matsuri", "2026-07-20");
    const ledger = ledgerOf("a-matsuri", {
      occurrenceDate: "2026-07-20",
      nextResearchOn: "2026-06-20",
    });
    const [target] = selectRefreshTargets([festival], { today: "2026-06-20", ledger });
    expect(target?.reasons).toEqual(["checkpoint"]);
  });

  it("節目が尽きた祭りは、開催が近くても選ばない", () => {
    const festival = expectedAt("a-matsuri", "2026-06-05");
    const ledger = ledgerOf("a-matsuri", { occurrenceDate: "2026-06-05", nextResearchOn: null });
    expect(selectRefreshTargets([festival], { today: TODAY, ledger })).toEqual([]);
  });

  it("前回失敗した祭りは、理由を分けて選ぶ", () => {
    const festival = expectedAt("a-matsuri", "2026-06-20");
    const ledger = ledgerOf("a-matsuri", {
      result: "failed",
      nextResearchOn: TODAY,
      failures: 1,
    });
    expect(selectRefreshTargets([festival], { today: TODAY, ledger })[0]?.reasons).toEqual([
      "retry",
    ]);
  });

  it("別の開催回の記録は効かない", () => {
    const festival = expectedAt("a-matsuri", "2026-06-10");
    const ledger = ledgerOf("a-matsuri", { occurrenceDate: "2025-06-10", nextResearchOn: null });
    expect(selectRefreshTargets([festival], { today: TODAY, ledger })[0]?.reasons).toEqual([
      "due_soon",
    ]);
  });

  it("対象がなければ空を返す（その週は調べない）", () => {
    expect(selectRefreshTargets([], { today: TODAY })).toEqual([]);
  });

  it("依頼のある祭りは、確定済みや待ちのフラグがあっても選び、先頭に並べる", () => {
    const confirmed = festivalOf((f) => {
      f.id = "confirmed-matsuri";
      f.occurrences[0] = { ...f.occurrences[0]!, date: "2026-12-01", status: "announced" };
    });
    const targets = selectRefreshTargets([expectedAt("soon", "2026-06-03"), confirmed], {
      today: TODAY,
      requests: [{ festivalId: "confirmed-matsuri", kind: "correction" }],
    });
    expect(targets[0]).toMatchObject({
      id: "confirmed-matsuri",
      reasons: ["request"],
      notes: ["依頼：訂正"],
    });
    expect(targets.map((t) => t.id)).toEqual(["confirmed-matsuri", "soon"]);
  });

  it("データにない祭りへの依頼は、対象を増やさない", () => {
    const targets = selectRefreshTargets([], {
      today: TODAY,
      requests: [{ festivalId: "unknown-festival", kind: "discrepancy" }],
    });
    expect(targets).toEqual([]);
  });

  it("掲載停止の祭りは、依頼があっても選ばない", () => {
    const festival = expectedAt("a-matsuri", "2026-06-05", (f) => {
      f.optOut = true;
    });
    const targets = selectRefreshTargets([festival], {
      today: TODAY,
      requests: [{ festivalId: "a-matsuri", kind: "correction" }],
    });
    expect(targets).toEqual([]);
  });

  it("確認待ちの PR にある祭りは選ばない", () => {
    const festival = expectedAt("a-matsuri", "2026-06-05");
    expect(selectRefreshTargets([festival], { today: TODAY, underReview: ["a-matsuri"] })).toEqual(
      [],
    );
  });

  it("次の開催回がなければ、前回の1年後の仮の日付で選び、手がかりに書く", () => {
    const festival = expectedAt("a-matsuri", "2025-06-10");
    const [target] = selectRefreshTargets([festival], { today: TODAY });
    expect(target).toMatchObject({ nextDate: "2026-06-10", reasons: ["due_soon"] });
    expect(target?.notes[0]).toContain("仮の日付");
  });

  it("開催が始まった祭りは選ばない", () => {
    const festival = expectedAt("a-matsuri", "2026-05-31", (f) => {
      f.occurrences[0]!.endDate = "2026-06-02";
    });
    expect(selectRefreshTargets([festival], { today: TODAY })).toEqual([]);
  });
});

describe("currentOccurrence", () => {
  it("2月29日の前回からは、2月28日を仮の日付にする", () => {
    const festival = expectedAt("a-matsuri", "2024-02-29");
    expect(currentOccurrence(festival, "2024-03-01")).toMatchObject({
      date: "2025-02-28",
      occurrence: null,
    });
  });

  it("開催中の回は、まだいまの開催回とする", () => {
    const festival = expectedAt("a-matsuri", "2026-05-31", (f) => {
      f.occurrences[0]!.endDate = "2026-06-02";
    });
    expect(currentOccurrence(festival, TODAY).date).toBe("2026-05-31");
  });
});

describe("nextCheckpointOn", () => {
  it.each([
    // 残りの日数 → 次の節目（開催の何日前か）
    ["2026-08-01", "2026-07-02"], // 61日前 → 30日前
    ["2026-07-01", "2026-06-17"], // 30日前 → 14日前（同じ日の節目には戻らない）
    ["2026-06-22", "2026-06-08"], // 21日前 → 14日前
    ["2026-06-15", "2026-06-08"], // 14日前 → 7日前
    ["2026-06-10", "2026-06-03"], // 9日前 → 7日前
  ])("開催が %s なら、次は %s", (occurrence, expected) => {
    expect(nextCheckpointOn(occurrence, TODAY)).toBe(expected);
  });

  it("7日前より後に調べたら、節目は尽きる", () => {
    expect(nextCheckpointOn("2026-06-08", TODAY)).toBeNull();
    expect(nextCheckpointOn("2026-06-03", TODAY)).toBeNull();
  });
});

describe("recordResearchResult", () => {
  const outcome = {
    festivalId: "a-matsuri",
    occurrenceDate: "2026-08-01",
    today: TODAY,
  } as const;

  it("見つからなければ、調べた日と次の節目を残す", () => {
    const ledger = recordResearchResult(EMPTY_RESEARCH_LEDGER, {
      ...outcome,
      result: "not_found",
    });
    expect(ledger.festivals["a-matsuri"]).toEqual({
      occurrenceDate: "2026-08-01",
      lastResearchedAt: TODAY,
      result: "not_found",
      nextResearchOn: "2026-07-02",
      failures: 0,
    });
  });

  it("見つかっても次の節目を残す（確認待ちの PR が却下されたら、また調べられる）", () => {
    const ledger = recordResearchResult(EMPTY_RESEARCH_LEDGER, { ...outcome, result: "found" });
    expect(ledger.festivals["a-matsuri"]?.nextResearchOn).toBe("2026-07-02");
  });

  it("失敗は節目を進めず翌週に調べ直し、2回続けば節目を進める", () => {
    const once = recordResearchResult(EMPTY_RESEARCH_LEDGER, { ...outcome, result: "failed" });
    expect(once.festivals["a-matsuri"]).toMatchObject({
      nextResearchOn: "2026-06-08",
      failures: 1,
    });
    const twice = recordResearchResult(once, { ...outcome, today: "2026-06-08", result: "failed" });
    expect(twice.festivals["a-matsuri"]).toMatchObject({
      nextResearchOn: "2026-07-02",
      failures: 2,
    });
  });

  it("開催の翌週に当たる調べ直しはしない", () => {
    const ledger = recordResearchResult(EMPTY_RESEARCH_LEDGER, {
      ...outcome,
      occurrenceDate: "2026-06-05",
      result: "failed",
    });
    expect(ledger.festivals["a-matsuri"]?.nextResearchOn).toBeNull();
  });

  it("別の開催回の失敗は数えない", () => {
    const old = ledgerOf("a-matsuri", { occurrenceDate: "2025-08-01", failures: 1 });
    const ledger = recordResearchResult(old, { ...outcome, result: "failed" });
    expect(ledger.festivals["a-matsuri"]?.failures).toBe(1);
  });

  it("節目を順に進むと、1つの開催回を調べるのは最大4回で終わる", () => {
    const occurrenceDate = "2026-08-31";
    let ledger = EMPTY_RESEARCH_LEDGER;
    const festival = expectedAt("a-matsuri", occurrenceDate);
    const days: string[] = [];
    for (let time = Date.parse("2026-06-01"); time <= Date.parse(occurrenceDate); ) {
      const today = new Date(time).toISOString().slice(0, 10);
      if (selectRefreshTargets([festival], { today, ledger }).length > 0) {
        days.push(today);
        ledger = recordResearchResult(ledger, {
          festivalId: "a-matsuri",
          occurrenceDate,
          result: "not_found",
          today,
        });
      }
      time += 7 * 86_400_000;
    }
    expect(days).toEqual(["2026-06-01", "2026-08-03", "2026-08-17", "2026-08-24"]);
  });
});

describe("retireEndedOccurrences", () => {
  it("開催が終わるまでは、記録を残す", () => {
    const festival = expectedAt("a-matsuri", "2026-06-20");
    const ledger = ledgerOf("a-matsuri", {});
    expect(retireEndedOccurrences([festival], ledger, "2026-06-20")).toEqual(ledger);
  });

  it("確定しないまま終わったら、別の記録に移す", () => {
    const festival = expectedAt("a-matsuri", "2026-06-20");
    const ledger = retireEndedOccurrences([festival], ledgerOf("a-matsuri", {}), "2026-06-21");
    expect(ledger).toEqual({
      festivals: {},
      officialNotFound: [
        { festivalId: "a-matsuri", occurrenceDate: "2026-06-20", lastResearchedAt: "2026-05-01" },
      ],
    });
  });

  it("確定して終わった回は、別の記録に移さない", () => {
    const festival = festivalOf((f) => {
      f.id = "a-matsuri";
      f.occurrences[0] = { ...f.occurrences[0]!, date: "2026-06-20", status: "announced" };
    });
    const ledger = retireEndedOccurrences([festival], ledgerOf("a-matsuri", {}), "2026-06-21");
    expect(ledger).toEqual(EMPTY_RESEARCH_LEDGER);
  });

  it("複数日の祭りは、最終日が過ぎてから外す", () => {
    const festival = expectedAt("a-matsuri", "2026-06-20", (f) => {
      f.occurrences[0]!.endDate = "2026-06-22";
    });
    const ledger = ledgerOf("a-matsuri", {});
    expect(retireEndedOccurrences([festival], ledger, "2026-06-22").festivals).toHaveProperty(
      "a-matsuri",
    );
    expect(retireEndedOccurrences([festival], ledger, "2026-06-23").festivals).toEqual({});
  });

  it("日付が直された回は、別の記録に移さない", () => {
    const festival = expectedAt("a-matsuri", "2026-06-27");
    const ledger = retireEndedOccurrences([festival], ledgerOf("a-matsuri", {}), "2026-06-21");
    expect(ledger).toEqual(EMPTY_RESEARCH_LEDGER);
  });

  it("仮の日付で調べて見つからなかった回は、別の記録に移す", () => {
    const festival = expectedAt("a-matsuri", "2025-06-20");
    const ledger = retireEndedOccurrences([festival], ledgerOf("a-matsuri", {}), "2026-06-21");
    expect(ledger.officialNotFound).toHaveLength(1);
  });

  it("データから消えた祭りは、外すだけにする", () => {
    const ledger = retireEndedOccurrences([], ledgerOf("a-matsuri", {}), "2026-06-21");
    expect(ledger).toEqual(EMPTY_RESEARCH_LEDGER);
  });

  it("同じ回を二重に記録しない", () => {
    const festival = expectedAt("a-matsuri", "2026-06-20");
    const item = {
      festivalId: "a-matsuri",
      occurrenceDate: "2026-06-20",
      lastResearchedAt: "2026-05-01",
    };
    const ledger = { ...ledgerOf("a-matsuri", {}), officialNotFound: [item] };
    expect(retireEndedOccurrences([festival], ledger, "2026-06-21").officialNotFound).toEqual([
      item,
    ]);
  });
});

describe("serializeResearchLedger", () => {
  it("祭りの ID の順に並べ、スキーマで読み戻せる", () => {
    let ledger = EMPTY_RESEARCH_LEDGER;
    for (const festivalId of ["b-matsuri", "a-matsuri"]) {
      ledger = recordResearchResult(ledger, {
        festivalId,
        occurrenceDate: "2026-08-01",
        result: "not_found",
        today: TODAY,
      });
    }
    const text = serializeResearchLedger(ledger);
    expect(Object.keys(ResearchLedgerSchema.parse(JSON.parse(text)).festivals)).toEqual([
      "a-matsuri",
      "b-matsuri",
    ]);
    expect(text.endsWith("}\n")).toBe(true);
  });
});

describe("validateResearchLedger", () => {
  it("正しい台帳は何も出さない", () => {
    expect(
      validateResearchLedger(serializeResearchLedger(EMPTY_RESEARCH_LEDGER), new Set()),
    ).toEqual([]);
  });

  it("JSON として読めなければエラーにする", () => {
    expect(validateResearchLedger("{", new Set())[0]?.level).toBe("error");
  });

  it("形が崩れていればエラーにする", () => {
    const findings = validateResearchLedger(
      JSON.stringify({ festivals: {}, officialNotFound: [], extra: true }),
      new Set(),
    );
    expect(findings[0]?.level).toBe("error");
  });

  it("データにない祭りの記録は警告にする", () => {
    const content = serializeResearchLedger(ledgerOf("a-matsuri", {}));
    expect(validateResearchLedger(content, new Set())[0]).toMatchObject({
      level: "warning",
      file: "research-ledger.json",
    });
    expect(validateResearchLedger(content, new Set(["a-matsuri"]))).toEqual([]);
  });
});
