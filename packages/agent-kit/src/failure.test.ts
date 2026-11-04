import { ERROR_CODES } from "@matsuri-ikoka/schema";
import { describe, expect, it } from "vitest";
import { backoffMs, classifyFailure, classifyResultSubtype, retryOnce } from "./failure";

function httpError(status: number): Error {
  return Object.assign(new Error(`request failed with status ${status}`), { status });
}

describe("classifyFailure", () => {
  it.each([
    [429, "rate_limited", true],
    [529, "overloaded", true],
    [503, "overloaded", true],
    [408, "timeout", true],
    [401, "auth", false],
    [403, "auth", false],
  ] as const)("状態コード %i は %s（もう一度試す：%s）", (status, kind, retryable) => {
    expect(classifyFailure(httpError(status))).toMatchObject({ kind, retryable });
  });

  it("中断と時間切れは timeout", () => {
    const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    expect(classifyFailure(abort)).toMatchObject({ kind: "timeout", errorCode: "timeout" });
  });

  it.each([
    ["Overloaded", "overloaded"],
    ["rate_limit_error: too many requests", "rate_limited"],
    ["Request timed out", "timeout"],
    ["read ECONNRESET", "network"],
    ["fetch failed", "network"],
    ["Claude Code process exited with code 1", "process"],
    ["Invalid API key", "auth"],
    ["Failed to authenticate: OAuth session expired and could not be refreshed", "auth"],
    ["想定していない誤り", "unknown"],
  ] as const)("本文「%s」は %s", (message, kind) => {
    expect(classifyFailure(new Error(message)).kind).toBe(kind);
  });

  it("Claude 側の混雑は、利用者の回数の上限としてではなく外のサービスの不調として出す", () => {
    expect(classifyFailure(httpError(429)).errorCode).toBe("upstream_unavailable");
  });

  it("画面に出す種類は、SSE の error イベントの code のどれか", () => {
    const samples = [httpError(429), httpError(401), new Error("x"), new Error("timed out")];
    for (const sample of samples) {
      expect(ERROR_CODES).toContain(classifyFailure(sample).errorCode);
    }
  });

  it("Error でない値も分類できる", () => {
    expect(classifyFailure("socket hang up").kind).toBe("network");
    expect(classifyFailure(undefined).kind).toBe("unknown");
  });
});

describe("classifyResultSubtype", () => {
  it("成功なら null", () => {
    expect(classifyResultSubtype("success")).toBeNull();
  });

  it.each([
    ["error_max_turns", "max_turns", false],
    ["error_max_budget_usd", "budget", false],
    ["error_during_execution", "process", true],
    ["error_unknown_future_kind", "unknown", false],
  ] as const)("%s は %s", (subtype, kind, retryable) => {
    expect(classifyResultSubtype(subtype)).toMatchObject({ kind, retryable });
  });
});

describe("backoffMs", () => {
  it("1秒から倍々に増やし、半分をランダムにずらす", () => {
    expect(backoffMs(1, { random: () => 0 })).toBe(500);
    expect(backoffMs(1, { random: () => 1 })).toBe(1_000);
    expect(backoffMs(3, { random: () => 1 })).toBe(4_000);
  });

  it("上限で止める", () => {
    expect(backoffMs(10, { random: () => 1 })).toBe(30_000);
    expect(backoffMs(10, { random: () => 0 })).toBe(15_000);
  });
});

describe("retryOnce", () => {
  const noWait = async () => {};

  it("一時的な失敗なら、1回だけやり直す", async () => {
    let calls = 0;
    const kinds: string[] = [];
    const value = await retryOnce(
      async () => {
        calls += 1;
        if (calls === 1) throw httpError(529);
        return "ok";
      },
      { wait: noWait, onRetry: (failure) => kinds.push(failure.kind) },
    );
    expect(value).toBe("ok");
    expect(calls).toBe(2);
    expect(kinds).toEqual(["overloaded"]);
  });

  it("やり直しても失敗したら、その失敗を投げる（2回で止める）", async () => {
    let calls = 0;
    await expect(
      retryOnce(
        async () => {
          calls += 1;
          throw httpError(503);
        },
        { wait: noWait },
      ),
    ).rejects.toThrow("503");
    expect(calls).toBe(2);
  });

  it("やり直しても直らない失敗（認証など）は、やり直さない", async () => {
    let calls = 0;
    await expect(
      retryOnce(
        async () => {
          calls += 1;
          throw httpError(401);
        },
        { wait: noWait },
      ),
    ).rejects.toThrow("401");
    expect(calls).toBe(1);
  });

  it("止められたあとは、やり直さない", async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(
      retryOnce(
        async () => {
          calls += 1;
          controller.abort();
          throw httpError(529);
        },
        { wait: noWait, signal: controller.signal },
      ),
    ).rejects.toThrow("529");
    expect(calls).toBe(1);
  });
});
