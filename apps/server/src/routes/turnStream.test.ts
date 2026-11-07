import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openEventStream } from "./turnStream";

// SSE を流す処理の、失敗の扱い。done を作れなくても、相談を返事の途中のままにせず、例外の文をログに残さない。

const SECRET = "ひみつの入力3d9a";

afterEach(() => {
  vi.restoreAllMocks();
});

type TestEvent = { type: "done" } | { type: "error"; message: string };

describe("openEventStream", () => {
  it("done を作れなくても、終わりの処理を呼び、例外の文を残さない", async () => {
    const logged: string[] = [];
    for (const method of ["error", "info"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }
    const finished = vi.fn();
    const app = new Hono();
    app.get("/stream", (c) =>
      openEventStream<TestEvent>(
        c,
        async () => {},
        {},
        {
          encode: (event) => ({ event: event.type, data: JSON.stringify(event) }),
          error: (body) => ({ type: "error", message: body.message }),
          done: () => {
            throw new Error(`done を作れません：${SECRET}`);
          },
          finished,
        },
      ),
    );

    const res = await app.request("/stream");
    const text = await res.text();

    expect(finished).toHaveBeenCalledTimes(1);
    expect(text).not.toContain(SECRET);
    expect(logged.some((line) => line.includes("sse_done_failed"))).toBe(true);
    expect(logged.some((line) => line.includes('"doneSent":false'))).toBe(true);
    expect(logged.filter((line) => line.includes(SECRET))).toEqual([]);
  });
});
