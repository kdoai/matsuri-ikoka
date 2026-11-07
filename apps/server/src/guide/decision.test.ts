import type { GuideProposal } from "@matsuri-ikoka/schema";
import { fictionalItinerary, fictionalProposal } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import {
  planApproval,
  remindersWatch,
  revertedItinerary,
  settleProposal,
  startedWatch,
  stoppedWatch,
  watchEndsOn,
} from "./decision";
import { proposalContentHash } from "./proposal";

const NOW = "2026-08-11T09:00:00+09:00";

/** ハッシュを中身に合わせた、承認を待っている提案 */
function proposal(over: Partial<GuideProposal> = {}): GuideProposal {
  const base = fictionalProposal();
  const merged = { ...base, ...over };
  return { ...merged, contentHash: proposalContentHash(merged.itinerary) };
}

const seenOf = (p: GuideProposal) => ({ baseVersion: p.baseVersion, contentHash: p.contentHash });

describe("planApproval", () => {
  it("版とハッシュが合い、期限の前なら当てる", () => {
    const p = proposal();
    expect(planApproval(p, seenOf(p), fictionalItinerary(), NOW)).toEqual({ kind: "apply" });
  });

  it("提案のあとに旅程が変わっていたら当てず、提案を stale にする", () => {
    const p = proposal();
    const current = { ...fictionalItinerary(), version: 3 };
    expect(planApproval(p, seenOf(p), current, NOW)).toEqual({ kind: "stale", mark: true });
  });

  it("見た提案と版かハッシュが違えば当てず、提案の状態は変えない", () => {
    const p = proposal();
    const seen = { baseVersion: p.baseVersion, contentHash: "f".repeat(64) };
    expect(planApproval(p, seen, fictionalItinerary(), NOW)).toEqual({
      kind: "stale",
      mark: false,
    });
  });

  it("保存した中身がハッシュと合わなければ当てない", () => {
    const p = { ...proposal(), contentHash: "0".repeat(64) };
    expect(planApproval(p, seenOf(p), fictionalItinerary(), NOW)).toEqual({
      kind: "stale",
      mark: true,
    });
  });

  it("期限を過ぎていたら当てず、提案を expired にする", () => {
    const p = proposal();
    expect(planApproval(p, seenOf(p), fictionalItinerary(), p.expiresAt)).toEqual({
      kind: "expired",
      mark: true,
    });
  });

  it("もう承認した提案は、当て直さずに同じ結果を返す", () => {
    const p = proposal({ status: "approved", decidedAt: NOW });
    const current = p.itinerary;
    expect(planApproval(p, seenOf(p), current, NOW)).toEqual({ kind: "applied", mark: false });
  });

  it("当てたあとに状態を書けなかった提案は、今の旅程がその提案なら当ててあるとみなす", () => {
    const p = proposal();
    expect(planApproval(p, seenOf(p), p.itinerary, NOW)).toEqual({ kind: "applied", mark: true });
  });

  it("ほかの旅の提案は当てず、stale にする", () => {
    const p = proposal();
    const other = { ...fictionalItinerary(), id: "trip-other" };
    expect(planApproval(p, seenOf(p), other, NOW)).toEqual({ kind: "stale", mark: true });
  });

  it("断った提案は当てない", () => {
    const p = proposal({ status: "rejected", decidedAt: NOW });
    expect(planApproval(p, seenOf(p), fictionalItinerary(), NOW)).toEqual({ kind: "rejected" });
  });
});

describe("settleProposal", () => {
  it("承認と却下のときだけ、決めた時刻を書く", () => {
    const p = proposal();
    expect(settleProposal(p, "approved", NOW).decidedAt).toBe(NOW);
    expect(settleProposal(p, "rejected", NOW).decidedAt).toBe(NOW);
    expect(settleProposal(p, "stale", NOW)).toMatchObject({ status: "stale", decidedAt: null });
  });
});

describe("revertedItinerary", () => {
  it("前の版の中身を、次の版として作り、今の旅程からの差分を付ける", () => {
    const first = fictionalItinerary();
    const second = proposal().itinerary;

    const { itinerary, diff } = revertedItinerary(second, first);

    expect(itinerary.version).toBe(3);
    expect(diff).toEqual({
      fromVersion: 2,
      toVersion: 3,
      added: [],
      changed: ["festival"],
      removed: [],
    });
    const festival = itinerary.days[0]?.items.find((item) => item.id === "festival");
    expect(festival?.start).toBe(first.days[0]?.items.find((i) => i.id === "festival")?.start);
    expect(festival?.changedInVersion).toBe(3);
    expect(itinerary.days[0]?.weather).toEqual(first.days[0]?.weather);
  });
});

describe("見回りの開始と停止", () => {
  const itinerary = fictionalItinerary();

  it("始めると、旅の最終日の翌日に止まる依頼になる", () => {
    const watch = startedWatch(null, itinerary, NOW);
    expect(watch).toEqual({
      tripId: itinerary.id,
      status: "active",
      startedAt: NOW,
      endsOn: watchEndsOn(itinerary),
      stoppedAt: null,
      lastCheckedAt: null,
    });
    expect(watchEndsOn(itinerary)).toBe("2026-08-17");
  });

  it("見回り中に始めても、そのまま返す", () => {
    const watch = startedWatch(null, itinerary, NOW);
    expect(startedWatch(watch, itinerary, "2026-08-12T09:00:00+09:00")).toBe(watch);
  });

  it("止めると時刻を書き、始め直すと調べた時刻を引き継ぐ", () => {
    const watch = { ...startedWatch(null, itinerary, NOW), lastCheckedAt: NOW };
    const stopped = stoppedWatch(watch, "2026-08-12T09:00:00+09:00");
    expect(stopped).toMatchObject({ status: "stopped", stoppedAt: "2026-08-12T09:00:00+09:00" });
    expect(stoppedWatch(stopped, "2026-08-13T09:00:00+09:00")).toBe(stopped);
    expect(startedWatch(stopped, itinerary, "2026-08-13T09:00:00+09:00")).toMatchObject({
      status: "active",
      lastCheckedAt: NOW,
    });
  });

  it("声かけを止めても見回りは続き、始め直しても止めたままにする", () => {
    const watch = startedWatch(null, itinerary, NOW);
    const quiet = remindersWatch(watch, false);
    expect(quiet).toMatchObject({ status: "active", reminders: false });
    expect(remindersWatch(quiet, false)).toBe(quiet);
    const restarted = startedWatch(
      stoppedWatch(quiet, "2026-08-12T09:00:00+09:00"),
      itinerary,
      "2026-08-13T09:00:00+09:00",
    );
    expect(restarted.reminders).toBe(false);
    expect(remindersWatch(restarted, true).reminders).toBe(true);
    // 項目がなければ声をかける
    expect(remindersWatch(watch, true)).toBe(watch);
  });
});
