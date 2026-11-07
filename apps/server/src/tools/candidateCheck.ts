import { backoffMs, classifyFailure } from "@matsuri-ikoka/agent-kit";
import type { Festival, IsoDate } from "@matsuri-ikoka/schema";
import { decideVerification, type VerificationDecision } from "../domain/verification";
import type { FestivalVerifier } from "./verifier";

// 候補を出す前の、開催の確かめ（docs/spec/agent-runtime.md の「候補を出す前の確かめ」）。
// - 確定前の再確認と同じ口（FestivalVerifier、live では Web だけを使う1回きりのエージェント）を使い、
//   結果は domain/verification.ts のルールで決め直す
// - 候補の3件は並べて動かし、祭りと日付ごとの結果を数時間とっておく
// - 1件の時間と、1つの相談で新しく確かめる数に上限を置く（費用は1件ごとの上限を verifier に渡す）。
//   上限に達したときは「確かめていない」（skipped: "limit"）と返し、呼ぶ側が要事前確認として出せるようにする
// - 失敗や時間切れは上限を消費しない。同じ祭りで何度も試さないよう、短い時間だけ別にとっておく
// - 混雑・通信のような一時的な失敗（@matsuri-ikoka/agent-kit の分類で retryable）は、1件の時間の中で1回だけやり直す

/** 1件の確かめの時間の上限 */
export const CANDIDATE_CHECK_TIMEOUT_MS = 50_000;
/** 結果をとっておく時間 */
export const CANDIDATE_CHECK_TTL_MS = 6 * 60 * 60 * 1000;
/** 1つの相談で、新しく確かめる数の上限（とってある結果を使うぶんは数えない） */
export const MAX_CANDIDATE_CHECKS_PER_SESSION = 18;
/** 失敗や時間切れの結果をとっておく時間（この間は同じ祭りと日付を確かめ直さない） */
export const CANDIDATE_CHECK_FAILURE_TTL_MS = 10 * 60 * 1000;

export interface CandidateCheck extends VerificationDecision {
  festivalId: string;
  date: IsoDate;
  checkedAt: string;
  /** とってあった結果か */
  cached: boolean;
}

/** 確かめなかったこと：limit 1つの相談で新しく確かめる数の上限に達した / aborted 相談が止められた */
export interface CandidateCheckSkipped {
  skipped: "limit" | "aborted";
}

export type CandidateCheckOutcome = CandidateCheck | CandidateCheckSkipped;

/** 確かめなかった結果か */
export function isSkippedCheck(outcome: CandidateCheckOutcome): outcome is CandidateCheckSkipped {
  return "skipped" in outcome;
}

export interface CandidateChecker {
  /**
   * 祭りと日付ごとに確かめる。上限に達したとき・止められたときは確かめず、その理由（skipped）を返す。
   * 失敗や時間切れは「確認できず」として返す（上限を消費せず、短い時間だけ別にとっておく）
   */
  check(input: {
    festival: Festival;
    date: IsoDate;
    /** 相談（新しく確かめた数を、相談ごとに数える） */
    session: object;
    signal: AbortSignal;
  }): Promise<CandidateCheckOutcome>;
  /**
   * とってある結果だけを返す（新しく確かめない）。旅程を保存するとき、候補を出す前の確かめの結果を引き継ぐのに使う
   */
  peek?(festivalId: string, date: IsoDate): CandidateCheck | null;
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
  failureTtlMs?: number;
  maxPerSession?: number;
  /** やり直す前に待つ時間（ミリ秒）。省略すると backoffMs(1) */
  retryDelayMs?: () => number;
}): CandidateChecker {
  const clock = deps.clock ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? CANDIDATE_CHECK_TIMEOUT_MS;
  const ttlMs = deps.ttlMs ?? CANDIDATE_CHECK_TTL_MS;
  const failureTtlMs = deps.failureTtlMs ?? CANDIDATE_CHECK_FAILURE_TTL_MS;
  const maxPerSession = deps.maxPerSession ?? MAX_CANDIDATE_CHECKS_PER_SESSION;
  const retryDelayMs = deps.retryDelayMs ?? (() => backoffMs(1));
  const cache = new Map<string, Entry>();
  /** 失敗や時間切れの結果。peek には出さない（確定の前には Web で確かめ直せるように） */
  const failed = new Map<string, Entry>();
  /** 同じ祭りと日付を、同時に2回確かめない */
  const inFlight = new Map<string, Promise<CandidateCheckOutcome>>();
  const used = new WeakMap<object, number>();

  const prune = (at: number) => {
    for (const store of [cache, failed]) {
      for (const [key, entry] of store) if (entry.expiresAt <= at) store.delete(key);
    }
  };

  const run = async (festival: Festival, date: IsoDate, signal: AbortSignal) => {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    const aborted = new Promise<never>((_, reject) =>
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
        once: true,
      }),
    );
    // 止められたときに、待っている Promise の失敗を拾われないままにしない
    aborted.catch(() => {});
    const verifyOnce = () =>
      Promise.race([deps.verifier.verify({ festival, date, signal: controller.signal }), aborted]);
    try {
      let report: Awaited<ReturnType<FestivalVerifier["verify"]>>;
      try {
        report = await verifyOnce();
      } catch (error) {
        // 時間切れ・止められたとき・やり直しても直らない失敗は、やり直さない
        if (controller.signal.aborted || !classifyFailure(error).retryable) throw error;
        await Promise.race([
          new Promise((resolve) => setTimeout(resolve, retryDelayMs())),
          aborted,
        ]);
        report = await verifyOnce();
      }
      return { decision: decideVerification(festival, report, deps.today(), date), ok: true };
    } catch {
      // 時間切れでも、祭りのデータの公式の出典で確かめてあれば、それを使う
      const fallback = decideVerification(
        festival,
        { result: "not_found", sources: [], note: "時間内に確かめられませんでした" },
        deps.today(),
        date,
      );
      return { decision: fallback, ok: false };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  };

  return {
    peek(festivalId, date) {
      prune(clock());
      const hit = cache.get(`${festivalId}@${date}`);
      return hit === undefined ? null : { ...hit.value, cached: true };
    },
    async check({ festival, date, session, signal }) {
      const key = `${festival.id}@${date}`;
      const at = clock();
      prune(at);
      const hit = cache.get(key) ?? failed.get(key);
      if (hit !== undefined) return { ...hit.value, cached: true };
      const pending = inFlight.get(key);
      if (pending !== undefined) return pending;
      if (signal.aborted) return { skipped: "aborted" };
      const count = used.get(session) ?? 0;
      if (count >= maxPerSession) return { skipped: "limit" };
      used.set(session, count + 1);

      const task = run(festival, date, signal).then(({ decision, ok }): CandidateCheckOutcome => {
        if (!ok) {
          // 失敗や時間切れは上限を消費しない
          used.set(session, Math.max(0, (used.get(session) ?? 1) - 1));
        }
        if (signal.aborted) return { skipped: "aborted" };
        const value: CandidateCheck = {
          ...decision,
          festivalId: festival.id,
          date,
          checkedAt: deps.now(),
          cached: false,
        };
        // 失敗や時間切れは、短い時間だけ別にとっておき、そのあとはまた確かめられるようにする
        if (ok) cache.set(key, { value, expiresAt: clock() + ttlMs });
        else failed.set(key, { value, expiresAt: clock() + failureTtlMs });
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
