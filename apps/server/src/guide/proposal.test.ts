import { createHash } from "node:crypto";
import type { PlanEvaluation } from "@matsuri-ikoka/schema";
import {
  fictionalItinerary,
  fictionalNotice,
  fictionalProposal,
} from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { draftFromItinerary } from "../domain/itinerary";
import { testFestival } from "../domain/testFestivals";
import {
  acceptableEvaluation,
  applyGuideEdits,
  carryConsidered,
  festivalWithNotices,
  isLivePendingProposal,
  NOT_USED_REASON,
  proposalContentHash,
  proposalExpiresAt,
  REMOVED_REASON,
  samePlan,
} from "./proposal";

const draft = () => draftFromItinerary(fictionalItinerary());
const itemIds = () => draft().days[0]?.items.map((item) => item.id) ?? [];

describe("proposalContentHash", () => {
  it("旅程の JSON の SHA-256 を返す", () => {
    const itinerary = fictionalItinerary();
    expect(proposalContentHash(itinerary)).toBe(
      createHash("sha256").update(JSON.stringify(itinerary)).digest("hex"),
    );
  });
});

describe("proposalExpiresAt", () => {
  it("作ってから3日か、旅の最後の日の終わりの、早いほう", () => {
    const itinerary = fictionalItinerary();
    const lastDay = itinerary.days.at(-1)?.date;

    expect(proposalExpiresAt(itinerary, "2026-01-01T09:00:00+09:00")).toBe(
      "2026-01-04T09:00:00+09:00",
    );
    expect(proposalExpiresAt(itinerary, `${lastDay}T09:00:00+09:00`)).toBe(
      `${lastDay}T23:59:59+09:00`,
    );
  });
});

describe("isLivePendingProposal", () => {
  const proposal = fictionalProposal();
  const now = "2026-08-11T00:00:00+09:00";

  it("承認待ちで、版が同じで、期限の前なら待てる", () => {
    expect(isLivePendingProposal(proposal, 1, now)).toBe(true);
  });

  it("決まった案、旅程が変わったあとの案、期限を過ぎた案は待てない", () => {
    expect(isLivePendingProposal({ ...proposal, status: "rejected" }, 1, now)).toBe(false);
    expect(isLivePendingProposal(proposal, 2, now)).toBe(false);
    expect(isLivePendingProposal(proposal, 1, "2026-08-16T00:00:00+09:00")).toBe(false);
  });
});

describe("applyGuideEdits", () => {
  it("指した予定の時刻だけを変え、ほかの予定には触れない", () => {
    const [first, second] = itemIds();
    const before = draft();

    const result = applyGuideEdits(before, [
      { op: "retime", itemId: second as string, start: "10:15", end: "10:45" },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [day] = result.draft.days;
    expect(day?.items.find((item) => item.id === second)?.start).toBe("10:15");
    expect(day?.items.find((item) => item.id === first)).toEqual(
      before.days[0]?.items.find((item) => item.id === first),
    );
  });

  it("もとの下書きを書き換えない", () => {
    const before = draft();
    const snapshot = JSON.stringify(before);
    const [first] = itemIds();

    applyGuideEdits(before, [{ op: "remove", itemId: first as string }]);

    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("予定を外し、足すと、始まる時刻の順に並ぶ", () => {
    const before = draft();
    const [first] = before.days[0]?.items ?? [];
    if (first === undefined) throw new Error("予定がありません");
    const result = applyGuideEdits(before, [
      { op: "remove", itemId: first.id },
      {
        op: "add",
        date: before.days[0]?.date ?? "",
        item: { ...first, id: "added", start: "00:05", end: "00:10" },
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const items = result.draft.days[0]?.items ?? [];
    expect(items[0]?.id).toBe("added");
    expect(items.some((item) => item.id === first.id)).toBe(false);
  });

  it("ない予定、ない日、もう使われている ID は断る", () => {
    const before = draft();
    const [first] = before.days[0]?.items ?? [];
    if (first === undefined) throw new Error("予定がありません");

    const result = applyGuideEdits(before, [
      { op: "retime", itemId: "no-such-item", start: "10:00", end: "11:00" },
      { op: "add", date: "2030-01-01", item: { ...first, id: "new-one" } },
      { op: "add", date: before.days[0]?.date ?? "", item: first },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.code)).toEqual([
      "unknown_item",
      "unknown_day",
      "duplicate_item",
    ]);
  });

  it("その日の予定がなくなる直しは断る", () => {
    const edits = itemIds().map((itemId) => ({ op: "remove" as const, itemId }));

    const result = applyGuideEdits(draft(), edits);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.code)).toEqual(["empty_day"]);
  });

  it("その日の帰りの最終を直せる", () => {
    const before = draft();
    const date = before.days[0]?.date ?? "";

    const result = applyGuideEdits(before, [{ op: "set_day", date, lastReturn: null }]);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.draft.days[0]?.lastReturn).toBeNull();
  });
});

describe("festivalWithNotices", () => {
  const festival = testFestival({ id: "suzunari-toro", date: "2026-08-16" });
  const notice = {
    ...fictionalNotice(),
    content: {
      kind: "schedule_change" as const,
      festivalId: "suzunari-toro",
      date: "2026-08-16",
      changes: [
        { field: "start" as const, before: "18:30", after: "19:30" },
        { field: "end" as const, before: "21:00", after: "21:30" },
      ],
    },
  };

  it("通知の変更を開催回に重ねる", () => {
    const patched = festivalWithNotices(festival, [notice]);

    expect(patched.occurrences[0]?.start).toBe("19:30");
    expect(patched.occurrences[0]?.end).toBe("21:30");
    expect(festival.occurrences[0]?.start).toBe("18:30");
  });

  it("ほかの祭りの通知と、通知がないときは変えない", () => {
    const other = { ...notice, content: { ...notice.content, festivalId: "kazami-bon-odori" } };

    expect(festivalWithNotices(festival, [other])).toBe(festival);
    expect(festivalWithNotices(festival, [])).toBe(festival);
  });
});

describe("carryConsidered", () => {
  const place = (id: string, adopted: boolean, reason: string) => ({
    id,
    name: id,
    from: "nearby" as const,
    adopted,
    reason,
  });

  it("新しい相談でも前の版の採否を引き継ぎ、調べただけの場所の理由をコードで補う", () => {
    const previous = {
      ...fictionalItinerary(),
      considered: [place("web-a", false, "遠いので入れなかった")],
    };

    const { draft: next, researched } = carryConsidered(draft(), previous, [
      { id: "web-b", name: "web-b", from: "nearby" },
    ]);

    expect(researched.map((entry) => entry.id)).toEqual(["web-a", "web-b"]);
    expect(next.considered).toEqual([
      { id: "web-a", reason: "遠いので入れなかった" },
      { id: "web-b", reason: NOT_USED_REASON },
    ]);
  });

  it("前の版で採っていて案から外した場所は、外したと書き、案に入っている場所は前の理由を保つ", () => {
    const base = draft();
    const craft = base.days[0]?.items.find((item) => item.spotId !== undefined);
    if (craft?.spotId === undefined) throw new Error("場所のある予定がありません");
    const previous = {
      ...fictionalItinerary(),
      considered: [place(craft.spotId, true, "和紙が見られる"), place("web-gone", true, "近い")],
    };

    const { draft: next } = carryConsidered(base, previous, []);

    expect(next.considered).toEqual([
      { id: craft.spotId, reason: "和紙が見られる" },
      { id: "web-gone", reason: REMOVED_REASON },
    ]);
  });

  it("上限を超えたら、案に入っている場所を残す", () => {
    const base = draft();
    const spotId = base.days[0]?.items.find((item) => item.spotId !== undefined)?.spotId;
    if (spotId === undefined) throw new Error("場所のある予定がありません");
    const found = Array.from({ length: 45 }, (_, index) => ({
      id: `web-${index}`,
      name: `店${index}`,
      from: "nearby" as const,
    }));

    const { researched, draft: next } = carryConsidered(base, fictionalItinerary(), [
      ...found,
      { id: spotId, name: "和紙の館", from: "nearby" },
    ]);

    expect(researched).toHaveLength(40);
    expect(researched[0]?.id).toBe(spotId);
    expect(next.considered?.length).toBe(39);
  });
});

describe("samePlan", () => {
  it("採否の理由・不足・評価・天気だけの違いは、同じ計画とする", () => {
    const base = fictionalItinerary();
    const other = {
      ...base,
      version: 9,
      considered: [
        { id: "web-a", name: "店", from: "nearby" as const, adopted: false, reason: "遠い" },
      ],
      days: base.days.map((day) => ({
        ...day,
        weather: { status: "unavailable" as const },
        items: day.items.map((item) => ({ ...item, changedInVersion: 9 })),
      })),
    };

    expect(samePlan(base, other)).toBe(true);
  });

  it("予定と、帰りの最終の違いは、別の計画とする", () => {
    const base = fictionalItinerary();
    const retimed = {
      ...base,
      days: base.days.map((day) => ({
        ...day,
        items: day.items.map((item, index) => (index === 0 ? { ...item, start: "14:00" } : item)),
      })),
    };
    const lastReturn = {
      ...base,
      days: base.days.map((day) => ({ ...day, lastReturn: null })),
    };

    expect(samePlan(base, retimed)).toBe(false);
    expect(samePlan(base, lastReturn)).toBe(false);
  });
});

describe("acceptableEvaluation", () => {
  const evaluation = (passed: boolean, score: number): PlanEvaluation =>
    ({
      passed,
      scores: [{ criterion: "coverage", score }],
    }) as unknown as PlanEvaluation;

  it("基準に届いていれば見せる。今の旅程に評価がなければ、点検だけで決める", () => {
    expect(acceptableEvaluation(evaluation(true, 90), evaluation(true, 95))).toBe(true);
    expect(acceptableEvaluation(evaluation(false, 10), undefined)).toBe(true);
  });

  it("基準に届いていなくても、今の旅程より悪くなければ見せ、悪くなる案は見せない", () => {
    expect(acceptableEvaluation(evaluation(false, 60), evaluation(false, 60))).toBe(true);
    expect(acceptableEvaluation(evaluation(false, 50), evaluation(false, 60))).toBe(false);
  });
});
