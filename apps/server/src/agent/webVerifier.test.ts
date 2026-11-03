import type {
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  Options,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { testFestival } from "../domain/testFestivals";
import type { QueryFn } from "./runner";
import { createWebVerifier } from "./webVerifier";

// Agent SDK の代わりに、フックを呼んで決まった返答を返す偽物の query で確かめる。URL はすべて架空

const festival = testFestival({ id: "suzunari-toro" });

type Script = (
  hook: (event: HookEvent, input: Record<string, unknown>) => Promise<unknown>,
) => Promise<string | null>;

function setup(scripts: Script[]) {
  const calls: { prompt: string; options: Options }[] = [];
  const query: QueryFn = (params) => {
    calls.push(params);
    const script = scripts[calls.length - 1];
    if (script === undefined) throw new Error("台本がありません");
    const hook = async (event: HookEvent, input: Record<string, unknown>) => {
      let output: unknown = {};
      for (const matcher of (params.options.hooks?.[event] ?? []) as HookCallbackMatcher[]) {
        const tool = input.tool_name as string | undefined;
        if (matcher.matcher && tool && !new RegExp(`^(?:${matcher.matcher})$`).test(tool)) continue;
        for (const fn of matcher.hooks) {
          output = await fn(
            {
              session_id: "v",
              transcript_path: "",
              cwd: "",
              hook_event_name: event,
              ...input,
            } as HookInput,
            undefined,
            {
              signal: new AbortController().signal,
            },
          );
        }
      }
      return output;
    };
    return (async function* () {
      const text = await script(hook);
      yield (text === null
        ? { type: "result", subtype: "error_during_execution", is_error: true, errors: [] }
        : {
            type: "result",
            subtype: "success",
            is_error: false,
            result: text,
          }) as unknown as SDKMessage;
    })();
  };
  const verifier = createWebVerifier({
    prompt: "再確認",
    cwd: "/tmp/matsuri-agent-test",
    env: {},
    query,
    // 名前の解決はネットワークに出ない。nip.io の形の名前は、名前に書いたアドレスを指す
    resolveHost: async (host) => {
      const ip = host.match(/^(\d+\.\d+\.\d+\.\d+)\.nip\.io$/)?.[1];
      return [ip ?? "8.8.8.8"];
    },
  });
  const verify = () =>
    verifier.verify({ festival, date: "2026-08-16", signal: new AbortController().signal });
  return { calls, verify };
}

const read = (hook: Parameters<Script>[0], url: string) =>
  hook("PostToolUse", {
    tool_name: "WebFetch",
    tool_input: { url, prompt: "開催日" },
    tool_response: "",
  });

describe("createWebVerifier", () => {
  it("返答の JSON を取り出し、実際に読んだページだけを出典に残す", async () => {
    const { verify } = setup([
      async (hook) => {
        await hook("PostToolUse", {
          tool_name: "WebSearch",
          tool_input: { query: "鈴鳴灯籠まつり 2026" },
          tool_response: "",
        });
        await read(hook, "https://example.com/suzunari/2026/");
        return [
          "確認しました。",
          "```json",
          JSON.stringify({
            result: "as_planned",
            sources: [
              { url: "http://example.com/suzunari/2026", title: "開催のお知らせ" },
              { url: "https://example.net/not-read" },
            ],
            yearStated: true,
            note: "8月16日18時30分から開催",
          }),
          "```",
        ].join("\n");
      },
    ]);

    expect(await verify()).toEqual({
      result: "as_planned",
      sources: [{ url: "http://example.com/suzunari/2026", title: "開催のお知らせ" }],
      yearStated: true,
      note: "8月16日18時30分から開催",
    });
  });

  it("公開の Web でない宛先の WebFetch は止める", async () => {
    let decision: unknown;
    const { verify } = setup([
      async (hook) => {
        decision = await hook("PreToolUse", {
          tool_name: "WebFetch",
          tool_input: { url: "http://localhost:8787/api" },
          tool_use_id: "f1",
        });
        return JSON.stringify({ result: "not_found", sources: [], yearStated: false });
      },
    ]);

    await verify();

    expect(decision).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });

  it("公開の名前でも、解決した先が内側のアドレスなら WebFetch を止める", async () => {
    const decisions: unknown[] = [];
    const { verify } = setup([
      async (hook) => {
        for (const url of [
          "https://169.254.169.254.nip.io/latest",
          "https://example.com/suzunari/2026",
        ]) {
          decisions.push(
            await hook("PreToolUse", {
              tool_name: "WebFetch",
              tool_input: { url },
              tool_use_id: url,
            }),
          );
        }
        return JSON.stringify({ result: "not_found", sources: [], yearStated: false });
      },
    ]);

    await verify();

    expect(decisions[0]).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("内側のネットワーク"),
      },
    });
    expect(decisions[1]).toEqual({});
  });

  it("検索だけで答えようとしたら、1回だけ続けさせる", async () => {
    const stops: unknown[] = [];
    const { verify } = setup([
      async (hook) => {
        await hook("PostToolUse", {
          tool_name: "WebSearch",
          tool_input: { query: "鈴鳴" },
          tool_response: "",
        });
        stops.push(await hook("Stop", { stop_hook_active: false }));
        stops.push(await hook("Stop", { stop_hook_active: true }));
        return JSON.stringify({ result: "not_found", sources: [], yearStated: false });
      },
    ]);

    await verify();

    expect(stops[0]).toMatchObject({ decision: "block" });
    expect(stops[1]).toEqual({});
  });

  it("JSON が崩れていれば、道具なしで1回だけ差し戻す", async () => {
    const { calls, verify } = setup([
      async (hook) => {
        await read(hook, "https://example.com/suzunari/2026");
        return "結果は予定どおりです（JSON を書き忘れた）";
      },
      async () =>
        JSON.stringify({
          result: "as_planned",
          sources: [{ url: "https://example.com/suzunari/2026" }],
          yearStated: true,
        }),
    ]);

    const report = await verify();

    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toContain("前の返答");
    expect(calls[1]?.options.tools).toEqual([]);
    expect(report).toMatchObject({
      result: "as_planned",
      sources: [{ url: "https://example.com/suzunari/2026" }],
    });
  });

  it("差し戻しても取り出せないとき、失敗したときは「確認できず」", async () => {
    const broken = setup([async () => "読めない返答", async () => "まだ読めない"]);
    const failed = setup([async () => null]);

    expect((await broken.verify()).result).toBe("not_found");
    expect((await failed.verify()).result).toBe("not_found");
  });
});
