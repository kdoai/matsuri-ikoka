import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { testFestival } from "../domain/testFestivals";
import { CANDIDATE_CHECK_TIMEOUT_MS, createCandidateChecker } from "./candidateCheck";
import { TOOL_TIMEOUT_MS } from "./context";
import { type MatsuriTool, searchFestivals, searchNearby, ToolError } from "./matsuriTools";
import { createMatsuriMcpServer, MCP_TOOL_CALL_TIMEOUT_MS, runTool } from "./mcpServer";
import { testToolContext } from "./testContext";

const ctx = () => testToolContext([testFestival({ id: "suzunari-toro" })]);

function fakeTool(run: MatsuriTool["run"], timeoutMs = 50): MatsuriTool {
  return { name: "get_access", description: "テスト", input: {}, timeoutMs, run };
}

describe("runTool", () => {
  it("結果を JSON の文と structuredContent の両方で返す", async () => {
    const result = await runTool(
      searchNearby,
      { festivalId: "suzunari-toro", date: "2026-08-16" },
      ctx(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.festivalId).toBe("suzunari-toro");
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });

  it("ToolError と入力の誤りは、その文をエージェントに返す", async () => {
    const failed = await runTool(searchNearby, { festivalId: "no-such" }, ctx());
    const invalid = await runTool(searchNearby, { festivalId: "Not A Slug" }, ctx());

    expect(failed).toMatchObject({ isError: true });
    expect(failed.content[0]?.text).toContain("祭りのデータにありません");
    expect(invalid.content[0]?.text).toContain("入力の形が正しくありません");
  });

  it("予期しない例外は中身を出さずに返す", async () => {
    const result = await runTool(
      fakeTool(async () => {
        throw new Error("secret detail");
      }),
      {},
      ctx(),
    );

    expect(result.content[0]?.text).toBe("ツールの中でエラーが起きました");
  });

  it("時間の上限を超えたら打ち切り、signal で止めさせる", async () => {
    let aborted = false;
    const result = await runTool(
      fakeTool(
        (_args, _ctx, signal) =>
          new Promise((resolve) => {
            signal.addEventListener("abort", () => {
              aborted = true;
            });
            setTimeout(() => resolve({}), 1000);
          }),
        20,
      ),
      {},
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("時間の上限");
    expect(aborted).toBe(true);
  });

  it("発言が止められたら（時間切れ・接続の切断）、ツールの signal も止めて失敗にする", async () => {
    const turn = new AbortController();
    let aborted = false;
    const pending = runTool(
      fakeTool(
        (_args, _ctx, signal) =>
          new Promise((resolve) => {
            signal.addEventListener("abort", () => {
              aborted = true;
            });
            setTimeout(() => resolve({}), 1000);
          }),
        5_000,
      ),
      {},
      testToolContext([], { signal: turn.signal }),
    );
    turn.abort();
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("止められました");
    expect(aborted).toBe(true);
  });

  it("すでに止められた発言では、ツールを動かさずに失敗にする", async () => {
    const turn = new AbortController();
    turn.abort();
    let ran = false;

    const result = await runTool(
      fakeTool(async (_args, _ctx, signal) => {
        ran = !signal.aborted;
        return {};
      }),
      {},
      testToolContext([], { signal: turn.signal }),
    );

    expect(result.isError).toBe(true);
    expect(ran).toBe(false);
  });

  it("ToolError と ZodError は区別できる", () => {
    expect(new ToolError("x")).toBeInstanceOf(Error);
    expect(z.string().safeParse(1).success).toBe(false);
  });
});

describe("createMatsuriMcpServer", () => {
  it("プロセス内の MCP サーバーとして matsuri の名前で作る", () => {
    const server = createMatsuriMcpServer(ctx());

    expect(server).toMatchObject({ type: "sdk", name: "matsuri" });
  });

  it("外側の時間の上限は、どのツールの上限よりも長い", () => {
    const server = createMatsuriMcpServer(ctx());

    expect(server.timeout).toBe(MCP_TOOL_CALL_TIMEOUT_MS);
    for (const limit of Object.values(TOOL_TIMEOUT_MS)) {
      expect(MCP_TOOL_CALL_TIMEOUT_MS).toBeGreaterThan(limit);
    }
  });
});

describe("search_festivals の候補の確かめに時間がかかるとき", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("確かめが30秒近くかかっても、確かめた結果を付けた候補を返す", async () => {
    vi.useFakeTimers();
    const toolCtx = testToolContext([testFestival({ id: "suzunari-toro", status: "expected" })]);
    const delayMs = CANDIDATE_CHECK_TIMEOUT_MS - 1;
    toolCtx.candidateChecks = createCandidateChecker({
      verifier: {
        verify: () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  result: "as_planned",
                  sources: [{ url: "https://example.com/suzunari/2026" }],
                }),
              delayMs,
            ),
          ),
      },
      today: toolCtx.today,
      now: toolCtx.now,
    });

    const pending = runTool(
      searchFestivals,
      { when: { kind: "date", date: "2026-08-16" }, origin: "みなと中央駅", nights: 0 },
      toolCtx,
    );
    await vi.advanceTimersByTimeAsync(delayMs);
    const result = await pending;

    expect(delayMs).toBeLessThan(MCP_TOOL_CALL_TIMEOUT_MS);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.candidates).toEqual([
      expect.objectContaining({ festivalId: "suzunari-toro", confirmed: true }),
    ]);
  });
});
