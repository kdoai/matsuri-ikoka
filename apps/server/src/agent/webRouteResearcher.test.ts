import type {
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  Options,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import type { QueryFn } from "./runner";
import { createWebRouteResearcher } from "./webRouteResearcher";

// Agent SDK の代わりに、フックを呼んで決まった返答を返す偽物の query で確かめる。駅と URL はすべて架空

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
      for (const matcher of (params.options.hooks?.[event] ?? []) as HookCallbackMatcher[]) {
        const tool = input.tool_name as string | undefined;
        if (matcher.matcher && tool && !new RegExp(`^(?:${matcher.matcher})$`).test(tool)) continue;
        for (const fn of matcher.hooks) {
          await fn(
            {
              session_id: "r",
              transcript_path: "",
              cwd: "",
              hook_event_name: event,
              ...input,
            } as HookInput,
            undefined,
            { signal: new AbortController().signal },
          );
        }
      }
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
  const researcher = createWebRouteResearcher({
    prompt: "行き方の調べ",
    cwd: "/tmp/matsuri-agent-test",
    env: {},
    query,
    resolveHost: async () => ["8.8.8.8"],
  });
  const research = () =>
    researcher.research({
      from: "こがね台",
      to: "鈴鳴駅",
      date: "2026-08-16",
      signal: new AbortController().signal,
    });
  return { calls, research };
}

const read = (hook: Parameters<Script>[0], url: string) =>
  hook("PostToolUse", {
    tool_name: "WebFetch",
    tool_input: { url, prompt: "所要時間" },
    tool_response: { bytes: 0, code: 200, codeText: "OK", result: "", url },
  });

const ANSWER = JSON.stringify({
  found: true,
  minutes: [55, 70],
  summary: "みなと鉄道本線で鈴鳴へ、乗り換えなし",
  transfers: 0,
  sources: [
    { url: "https://example.com/route", title: "乗り換え案内" },
    { url: "https://example.com/not-read", title: "読んでいないページ" },
  ],
});

describe("createWebRouteResearcher", () => {
  it("調べた行き方を返し、実際に読んだページだけを出典に残す。同じ駅の組はとっておいた結果を使う", async () => {
    const { calls, research } = setup([
      async (hook) => {
        await read(hook, "https://example.com/route");
        return ANSWER;
      },
    ]);

    const report = await research();
    expect(report).toEqual({
      minutes: [55, 70],
      summary: "みなと鉄道本線で鈴鳴へ、乗り換えなし",
      transfers: 0,
      sources: [{ url: "https://example.com/route", title: "乗り換え案内" }],
    });
    expect(calls[0]?.options.tools).toEqual(["WebSearch", "WebFetch"]);
    expect(calls[0]?.prompt).toContain("出発の駅：こがね台");

    expect(await research()).toEqual(report);
    expect(calls).toHaveLength(1);
  });

  it("ページを読まずに答えたときや、分からないと答えたときは null", async () => {
    const unread = setup([async () => ANSWER]);
    expect(await unread.research()).toBeNull();

    const notFound = setup([async () => JSON.stringify({ found: false, sources: [] })]);
    expect(await notFound.research()).toBeNull();
  });

  it("JSON を取り出せなければ、道具なしで1回だけ差し戻す", async () => {
    const { calls, research } = setup([
      async (hook) => {
        await read(hook, "https://example.com/route");
        return "乗り換えなしで55分ほどです";
      },
      async () => ANSWER,
    ]);

    expect(await research()).toMatchObject({ minutes: [55, 70] });
    expect(calls[1]?.options.tools).toEqual([]);
  });
});
