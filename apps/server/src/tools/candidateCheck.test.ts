import { describe, expect, it } from "vitest";
import { testFestival } from "../domain/testFestivals";
import type { VerificationReport } from "../domain/verification";
import {
  type CandidateCheck,
  type CandidateCheckOutcome,
  createCandidateChecker,
} from "./candidateCheck";
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

/** 確かめた結果だけを取り出す（確かめなかったときは null） */
const checked = (outcome: CandidateCheckOutcome): CandidateCheck | null =>
  "skipped" in outcome ? null : outcome;

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
    expect(checked(first)?.sources[0]?.confidence).toBe("official");

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
    expect(checked(check)?.result).toBe("not_found");
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

  it("時間の上限を超えたら「確認できず」にし、短い時間だけとっておく", async () => {
    let clock = 0;
    const verifier = verifierOf(() => new Promise(() => {}));
    const checker = createCandidateChecker({
      verifier,
      today,
      now,
      timeoutMs: 20,
      clock: () => clock,
      failureTtlMs: 1000,
    });
    const festival = testFestival({ id: "suzunari-toro" });

    const check = await checker.check({ festival, date: "2026-08-16", session: {}, signal });
    expect(check).toMatchObject({ result: "not_found", cached: false });
    const again = await checker.check({ festival, date: "2026-08-16", session: {}, signal });
    expect(again).toMatchObject({ result: "not_found", cached: true });
    expect(verifier.calls).toHaveLength(1);
    // 失敗の結果は、確定の前の再確認には引き継がない
    expect(checker.peek?.("suzunari-toro", "2026-08-16")).toBeNull();

    clock = 2000;
    await checker.check({ festival, date: "2026-08-16", session: {}, signal });
    expect(verifier.calls).toHaveLength(2);
  });

  it("失敗や時間切れは、1つの相談で新しく確かめる数の上限を消費しない", async () => {
    const verifier = verifierOf(async (id) => {
      if (id === "slow-matsuri") throw Object.assign(new Error("unauthorized"), { status: 401 });
      return official;
    });
    const checker = createCandidateChecker({ verifier, today, now, maxPerSession: 1 });
    const session = {};
    const failed = await checker.check({
      festival: testFestival({ id: "slow-matsuri", confidence: "single" }),
      date: "2026-08-16",
      session,
      signal,
    });
    expect(checked(failed)?.result).not.toBe("as_planned");
    const next = await checker.check({
      festival: testFestival({ id: "suzunari-toro" }),
      date: "2026-08-16",
      session,
      signal,
    });
    expect(next).toMatchObject({ result: "as_planned", cached: false });
  });

  it("時間切れでも、祭りのデータの公式の出典で確かめてあれば予定どおりにする", async () => {
    const verifier = verifierOf(() => new Promise(() => {}));
    const checker = createCandidateChecker({ verifier, today, now, timeoutMs: 20 });
    const festival = testFestival({
      id: "kogane-matsuri",
      edit: (f) => {
        for (const o of f.occurrences) {
          o.sources = [{ ...o.sources[0]!, checkedAt: "2026-07-30", confidence: "official" }];
        }
      },
    });

    const check = await checker.check({ festival, date: "2026-08-16", session: {}, signal });
    expect(check).toMatchObject({ result: "as_planned", cached: false });
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
    expect(results.map((r) => checked(r)?.result ?? r)).toEqual([
      "as_planned",
      "as_planned",
      { skipped: "limit" },
    ]);
    // とってある結果は、上限に達しても使う
    const cached = await checker.check({
      festival: testFestival({ id: "suzunari-toro" }),
      date: "2026-08-14",
      session,
      signal,
    });
    expect(cached).toMatchObject({ result: "as_planned", cached: true });
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
    expect(check).toEqual({ skipped: "aborted" });
    expect(verifier.calls).toEqual([]);
  });
});

describe("createCandidateChecker の、一時的な失敗のやり直し", () => {
  it("混雑や通信の失敗は1回だけやり直し、直れば結果をとっておく", async () => {
    let calls = 0;
    const verifier = verifierOf(async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("overloaded"), { status: 529 });
      return official;
    });
    const checker = createCandidateChecker({ verifier, today, now, retryDelayMs: () => 0 });
    const festival = testFestival({ id: "suzunari-toro" });

    const result = await checker.check({ festival, date: "2026-08-16", session: {}, signal });
    expect(result).toMatchObject({ result: "as_planned", cached: false });
    expect(verifier.calls).toHaveLength(2);
  });

  it("やり直しても直らない失敗（認証など）はやり直さず、確認できずとして返す", async () => {
    const verifier = verifierOf(async () => {
      throw Object.assign(new Error("unauthorized"), { status: 401 });
    });
    const checker = createCandidateChecker({ verifier, today, now, retryDelayMs: () => 0 });
    const festival = testFestival({ id: "suzunari-toro", confidence: "single" });

    const result = await checker.check({ festival, date: "2026-08-16", session: {}, signal });
    expect(verifier.calls).toHaveLength(1);
    expect(checked(result)?.result).not.toBe("as_planned");
  });

  it("2回目も失敗したら、それ以上はやり直さない", async () => {
    const verifier = verifierOf(async () => {
      throw new Error("fetch failed");
    });
    const checker = createCandidateChecker({ verifier, today, now, retryDelayMs: () => 0 });
    const festival = testFestival({ id: "suzunari-toro", confidence: "single" });

    await checker.check({ festival, date: "2026-08-16", session: {}, signal });
    expect(verifier.calls).toHaveLength(2);
  });
});
