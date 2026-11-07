import { describe, expect, it } from "vitest";
import { isFetchParserAssertion } from "./log";

function assertion(stack: string): Error {
  const error = Object.assign(new Error("false == true"), { code: "ERR_ASSERTION" });
  error.stack = stack;
  return error;
}

describe("isFetchParserAssertion", () => {
  it("通信のライブラリの内部の確認の例外だけを見分ける", () => {
    expect(
      isFetchParserAssertion(
        assertion(
          "AssertionError\n  at Parser.finish (node:internal/deps/undici/undici:6229:9)\n  at Socket.<anonymous> (node:internal/deps/undici/undici:6563:36)",
        ),
      ),
    ).toBe(true);
  });

  it("ほかの例外は止める側に残す", () => {
    expect(isFetchParserAssertion(assertion("AssertionError\n  at check (src/app.ts:1:1)"))).toBe(
      false,
    );
    expect(isFetchParserAssertion(new Error("at Parser.finish undici"))).toBe(false);
    expect(isFetchParserAssertion("文字列")).toBe(false);
    expect(isFetchParserAssertion(undefined)).toBe(false);
  });
});
