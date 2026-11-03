import { describe, expect, it } from "vitest";
import { testFestival } from "../domain/testFestivals";
import type { VerificationReport } from "../domain/verification";
import { createCandidateChecker } from "./candidateCheck";
import type { FestivalVerifier } from "./verifier";

// 架空の祭りの公式の出典は example.com（fictionalSource）
const official: VerificationReport = {
  result: "as_planned",
  sources: [{ url: "https://example.com/suzunari-toro/2026" }],
  yearStated: true,
};

function verifierOf(
  answer: (festivalId: string) => Promise<VerificationReport>,
): FestivalVerifier & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async verify({ festival, date }) {
      calls.push(`${festival.id}@${date}`);
      return answer(festival.id);
    },
  };
}

const today = () => "2026-08-03";
const now = () => "2026-08-03T10:15:00+09:00";
const signal = new AbortController().signal;

describe("createCandidateChecker", () => {
  it("結果をコードのルールで決め直し、祭りと日付ごとにとっておく", async () => {
    let clock = 0;
    const verifier = verifierOf(async () => official);
    const checker = createCandidateChecker({
      verifier,
      today,
      now,
      clock: () => clock,
      ttlMs: 1000,
    });
    const festival = testFestival({ id: "suzunari-toro" });
    const session = {};

    const first = await checker.check({ festival, date: "2026-08-16", session, signal });
    expect(first).toMatchObject({ result: "as_planned", cached: false, date: "2026-08-16" });
    expect(first?.sources[0]?.confidence).toBe("official");

    const again = await checker.check({ festival, date: "2026-08-16", session: {}, signal });
    expect(again).toMatchObject({ result: "as_planned", cached: true });
    expect(verifier.calls).toHaveLength(1);

    clock = 2000;
    await checker.check({ festival, date: "2026-08-16", session, signal });
    expect(verifier.calls).toHaveLength(2);
  });

  it("公式でない出典だけなら、予定どおりとは言わない", async () => {
    const verifier = verifierOf(async () => ({
      result: "as_planned",
      sources: [{ url: "https://blog.example.net/matsuri" }],
    }));
    const checker = createCandidateChecker({ verifier, today, now });
    const check = await checker.check({
      festival: testFestival({ id: "suzunari-toro" }),
      date: "2026-08-16",
      session: {},
      signal,
    });
    expect(check?.result).toBe("not_found");
  });

  it("3件を並べて動かす", async () => {
    let running = 0;
    let most = 0;
    const verifier = verifierOf(async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
      return { result: "not_found", sources: [] };
    });
    const checker = createCandidateChecker({ verifier, today, now });
    const session = {};
    await Promise.all(
      ["a-matsuri", "b-matsuri", "c-matsuri"].map((id) =>
        checker.check({ festival: testFestival({ id }), date: "2026-08-16", session, signal }),
      ),
    );
    expect(most).toBe(3);
  });

  it("時間の上限を超えたら「確認できず」にし、とっておかない", async () => {
    const verifier = verifierOf(() => new Promise(() => {}));
    const checker = createCandidateChecker({ verifier, today, now, timeoutMs: 20 });
    const festival = testFestival({ id: "suzunari-toro" });

    const check = await checker.check({ festival, date: "2026-08-16", session: {}, signal });
    expect(check).toMatchObject({ result: "not_found", cached: false });
    await checker.check({ festival, date: "2026-08-16", session: {}, signal });
    expect(verifier.calls).toHaveLength(2);
  });

  it("1つの相談で新しく確かめる数に上限を置く", async () => {
    const verifier = verifierOf(async () => official);
    const checker = createCandidateChecker({ verifier, today, now, maxPerSession: 2 });
    const session = {};
    const results = [];
    for (const date of ["2026-08-14", "2026-08-15", "2026-08-16"]) {
      results.push(
        await checker.check({
          festival: testFestival({ id: "suzunari-toro" }),
          date,
          session,
          signal,
        }),
      );
    }
    expect(results.map((r) => r?.result ?? null)).toEqual(["as_planned", "as_planned", null]);
  });

  it("止められた相談では確かめない", async () => {
    const controller = new AbortController();
    controller.abort();
    const verifier = verifierOf(async () => official);
    const checker = createCandidateChecker({ verifier, today, now });
    const check = await checker.check({
      festival: testFestival({ id: "suzunari-toro" }),
      date: "2026-08-16",
      session: {},
      signal: controller.signal,
    });
    expect(check).toBeNull();
    expect(verifier.calls).toEqual([]);
  });
});
