import { classifyFailure } from "@matsuri-ikoka/agent-kit";
import { describe, expect, it } from "vitest";
import { failureFromResult, toAgentError } from "./failures";

describe("例外の分類（共通の部品）", () => {
  it("通信・混雑はやり直せる失敗にする", () => {
    expect(classifyFailure(new Error("ECONNRESET"))).toMatchObject({
      kind: "network",
      retryable: true,
    });
    expect(classifyFailure(new Error("API Error: 529 overloaded"))).toMatchObject({
      kind: "overloaded",
      retryable: true,
    });
  });

  it("ログインの期限切れも認証の失敗にし、やり直さない", () => {
    expect(
      classifyFailure(
        new Error("Failed to authenticate: OAuth session expired and could not be refreshed"),
      ),
    ).toMatchObject({ kind: "auth", retryable: false });
  });
});

describe("failureFromResult", () => {
  it("成功なら null", () => {
    expect(failureFromResult({ subtype: "success", is_error: false }, null)).toBeNull();
  });

  it("結果が届かなければ、通信の失敗", () => {
    expect(failureFromResult(null, null)).toMatchObject({ kind: "network", retryable: true });
  });

  it("回数と費用の上限は subtype で決める", () => {
    expect(failureFromResult({ subtype: "error_max_turns", is_error: true }, null)?.kind).toBe(
      "max_turns",
    );
    expect(failureFromResult({ subtype: "error_max_budget_usd", is_error: true }, null)?.kind).toBe(
      "budget",
    );
  });

  it("実行中の失敗は、assistant の error や理由の文で分ける", () => {
    expect(
      failureFromResult({ subtype: "error_during_execution", is_error: true }, "overloaded")?.kind,
    ).toBe("overloaded");
    expect(
      failureFromResult(
        { subtype: "success", is_error: true, result: "Failed to authenticate" },
        null,
      )?.kind,
    ).toBe("auth");
    expect(
      failureFromResult({ subtype: "error_during_execution", is_error: true, errors: [] }, null)
        ?.kind,
    ).toBe("process");
  });
});

describe("toAgentError", () => {
  it("利用者に見せる一文と、画面のエラーの種類にする", () => {
    const error = toAgentError(classifyFailure(new Error("rate limit exceeded")));

    expect(error).toMatchObject({ code: "upstream_unavailable", retryable: true });
    expect(error.message).toContain("混み合っています");
  });
});
