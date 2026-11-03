import type { Festival, IsoDate, VerificationResult } from "@matsuri-ikoka/schema";
import { decideVerification, type VerificationDecision } from "../domain/verification";
import type { FestivalVerifier } from "./verifier";

// 候補を出す前の、開催の確かめ（docs/spec/agent-runtime.md の「候補を出す前の確かめ」）。
// - 確定前の再確認と同じ口（FestivalVerifier、live では Web だけを使う1回きりのエージェント）を使い、
//   結果は domain/verification.ts のルールで決め直す
// - 候補の3件は並べて動かし、祭りと日付ごとの結果を数時間とっておく
// - 1件の時間と、1つの相談で新しく確かめる数に上限を置く（費用は1件ごとの上限を verifier に渡す）

/** 1件の確かめの時間の上限 */
export const CANDIDATE_CHECK_TIMEOUT_MS = 30_000;
/** 結果をとっておく時間 */
export const CANDIDATE_CHECK_TTL_MS = 6 * 60 * 60 * 1000;
/** 1つの相談で、新しく確かめる数の上限（とってある結果を使うぶんは数えない） */
export const MAX_CANDIDATE_CHECKS_PER_SESSION = 9;

export interface CandidateCheck extends VerificationDecision {
  festivalId: string;
  date: IsoDate;
  checkedAt: string;
  /** とってあった結果か */
  cached: boolean;
}

export interface CandidateChecker {
  /**
   * 祭りと日付ごとに確かめる。上限に達したとき・止められたときは null（確かめていない）。
   * 失敗や時間切れは「確認できず」として返す（とっておかない）
   */
  check(input: {
    festival: Festival;
    date: IsoDate;
    /** 相談（新しく確かめた数を、相談ごとに数える） */
    session: object;
    signal: AbortSignal;
  }): Promise<CandidateCheck | null>;
}

interface Entry {
  value: CandidateCheck;
  expiresAt: number;
}

export function createCandidateChecker(deps: {
  verifier: FestivalVerifier;
  today: () => IsoDate;
  now: () => string;
  clock?: () => number;
  timeoutMs?: number;
  ttlMs?: number;
  maxPerSession?: number;
}): CandidateChecker {
  const clock = deps.clock ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? CANDIDATE_CHECK_TIMEOUT_MS;
  const ttlMs = deps.ttlMs ?? CANDIDATE_CHECK_TTL_MS;
  const maxPerSession = deps.maxPerSession ?? MAX_CANDIDATE_CHECKS_PER_SESSION;
  const cache = new Map<string, Entry>();
  /** 同じ祭りと日付を、同時に2回確かめない */
  const inFlight = new Map<string, Promise<CandidateCheck | null>>();
  const used = new WeakMap<object, number>();

  const prune = (at: number) => {
    for (const [key, entry] of cache) if (entry.expiresAt <= at) cache.delete(key);
  };

  const run = async (festival: Festival, date: IsoDate, signal: AbortSignal) => {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    try {
      const report = await Promise.race([
        deps.verifier.verify({ festival, date, signal: controller.signal }),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
            once: true,
          }),
        ),
      ]);
      return { decision: decideVerification(festival, report, deps.today()), ok: true };
    } catch {
      return {
        decision: {
          result: "not_found" as VerificationResult,
          sources: [],
          note: "時間内に確かめられませんでした",
        },
        ok: false,
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  };

  return {
    async check({ festival, date, session, signal }) {
      const key = `${festival.id}@${date}`;
      const at = clock();
      prune(at);
      const hit = cache.get(key);
      if (hit !== undefined) return { ...hit.value, cached: true };
      const pending = inFlight.get(key);
      if (pending !== undefined) return pending;
      const count = used.get(session) ?? 0;
      if (count >= maxPerSession || signal.aborted) return null;
      used.set(session, count + 1);

      const task = run(festival, date, signal).then(({ decision, ok }) => {
        if (signal.aborted) return null;
        const value: CandidateCheck = {
          ...decision,
          festivalId: festival.id,
          date,
          checkedAt: deps.now(),
          cached: false,
        };
        // 失敗や時間切れは、次にまた確かめられるように、とっておかない
        if (ok) cache.set(key, { value, expiresAt: clock() + ttlMs });
        return value;
      });
      inFlight.set(key, task);
      try {
        return await task;
      } finally {
        inFlight.delete(key);
      }
    },
  };
}
