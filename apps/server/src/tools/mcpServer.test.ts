import { describe, expect, it } from "vitest";
import { z } from "zod";
import { testFestival } from "../domain/testFestivals";
import { type MatsuriTool, searchNearby, ToolError } from "./matsuriTools";
import { createMatsuriMcpServer, runTool } from "./mcpServer";
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
});
