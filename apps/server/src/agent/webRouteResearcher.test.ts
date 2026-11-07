import type {
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  Options,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import type { QueryFn } from "./runner";
import {
  createWebRouteResearcher,
  ROUTE_RESEARCH_MS,
  ROUTE_RETRY_MIN_MS,
} from "./webRouteResearcher";

// Agent SDK の代わりに、フックを呼んで決まった返答を返す偽物の query で確かめる。駅と URL はすべて架空

type Script = (
  hook: (event: HookEvent, input: Record<string, unknown>) => Promise<unknown>,
) => Promise<string | null>;

function setup(scripts: Script[], clock?: () => number) {
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
    ...(clock ? { clock } : {}),
  });
  const research = () =>
    researcher.research({
      from: "こがね台",
      to: "鈴鳴駅",
      date: "2026-08-16",
      signal: new AbortController().signal,
    });
  return { calls, research, researcher };
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

  it("ページを読まずに答えたときや、分からないと答えたときは、調べ方を変えて1回だけ調べ直す", async () => {
    const unread = setup([async () => ANSWER, async () => ANSWER]);
    expect(await unread.research()).toBeNull();
    expect(unread.calls).toHaveLength(2);
    expect(unread.calls[1]?.prompt).toContain("調べ直しです");
    expect(unread.calls[1]?.options.tools).toEqual(["WebSearch", "WebFetch"]);

    const notFound = setup([
      async () => JSON.stringify({ found: false, sources: [] }),
      async (hook) => {
        await read(hook, "https://example.com/route");
        return ANSWER;
      },
    ]);
    expect(await notFound.research()).toMatchObject({ minutes: [55, 70] });
  });

  it("読まずに答えようとしたら、検索もしていなくても、読むまで続けさせる", async () => {
    const stops: unknown[] = [];
    const { calls, research } = setup([
      async () => {
        const hooks = calls[0]?.options.hooks?.Stop as HookCallbackMatcher[];
        const stop = hooks[0]?.hooks[0];
        if (stop === undefined) throw new Error("Stop のフックがありません");
        stops.push(
          await stop(
            { session_id: "r", transcript_path: "", cwd: "", hook_event_name: "Stop" } as HookInput,
            undefined,
            { signal: new AbortController().signal },
          ),
        );
        return JSON.stringify({ found: false, sources: [] });
      },
      async () => JSON.stringify({ found: false, sources: [] }),
    ]);

    await research();

    expect(stops[0]).toMatchObject({
      decision: "block",
      reason: expect.stringContaining("まだページを読んでいません"),
    });
  });

  it("時間の残りが少なければ、調べ直さない", async () => {
    let now = 1_000_000;
    const { calls, research } = setup(
      [
        async () => {
          now += ROUTE_RESEARCH_MS - ROUTE_RETRY_MIN_MS + 1;
          return JSON.stringify({ found: false, sources: [] });
        },
      ],
      () => now,
    );

    expect(await research()).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("途中で止まった調べは、見つからなかったものとして扱い、時間が残っていれば調べ直す", async () => {
    const { calls, research } = setup([
      async () => {
        const abort = calls[0]?.options.abortController;
        abort?.abort(new Error("timeout"));
        throw new Error("aborted");
      },
      async (hook) => {
        await read(hook, "https://example.com/route");
        return ANSWER;
      },
    ]);

    expect(await research()).toMatchObject({ minutes: [55, 70] });
    expect(calls).toHaveLength(2);
  });

  it("調べの進みを知らせる", async () => {
    let count = 0;
    const { researcher } = setup([
      async (hook) => {
        await read(hook, "https://example.com/route");
        return ANSWER;
      },
    ]);
    await researcher.research({
      from: "こがね台",
      to: "鈴鳴駅",
      date: "2026-08-16",
      signal: new AbortController().signal,
      onActivity: () => {
        count += 1;
      },
    });
    expect(count).toBeGreaterThan(0);
  });

  it("最終の時刻や要約の書き方が違っても、読めた行き方を捨てない", async () => {
    const { calls, researcher } = setup([
      async (hook) => {
        await read(hook, "https://example.com/route");
        return JSON.stringify({
          ...JSON.parse(ANSWER),
          lastDeparture: "翌0:10ごろ",
          summary: "長い要約".repeat(60),
          transfers: "不明",
        });
      },
    ]);

    const report = await researcher.research({
      from: "鈴鳴駅",
      to: "こがね台",
      date: "2026-08-16",
      direction: "return",
      signal: new AbortController().signal,
    });

    expect(report).toMatchObject({ minutes: [55, 70], lastDeparture: null, transfers: null });
    expect(report?.summary.length).toBe(160);
    // 差し戻さずに使う
    expect(calls).toHaveLength(1);
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

describe("乗り換えの区間と帰りの最終", () => {
  const legs = [
    { from: "こがね台", to: "川辺", line: "こがね線", minutes: [30, 40] },
    { from: "川辺", to: "鈴鳴駅", line: "鈴鳴線", minutes: [20, 25] },
  ];

  it("出発の駅から着く駅までつながった区間だけを使う。直せなければ区間なしで返す", async () => {
    const connected = setup([
      async (hook) => {
        await read(hook, "https://example.com/route");
        return JSON.stringify({ ...JSON.parse(ANSWER), legs });
      },
    ]);
    expect(await connected.research()).toMatchObject({ legs });

    const brokenLegs = [legs[0], { ...legs[1], from: "別の駅" }];
    const broken = setup([
      async (hook) => {
        await read(hook, "https://example.com/route");
        return JSON.stringify({ ...JSON.parse(ANSWER), legs: brokenLegs });
      },
      async () => JSON.stringify({ ...JSON.parse(ANSWER), legs: brokenLegs }),
    ]);
    const report = await broken.research();
    expect(report).not.toBeNull();
    expect(report).not.toHaveProperty("legs");
    expect(broken.calls[1]?.options.tools).toEqual([]);
    expect(broken.calls[1]?.prompt).toContain("鈴鳴駅");
  });

  it("区間がつながっていなければ、道具なしで1回だけ直してもらう", async () => {
    const { calls, research } = setup([
      async (hook) => {
        await read(hook, "https://example.com/route");
        return JSON.stringify({ ...JSON.parse(ANSWER), legs: legs.slice(0, 1) });
      },
      async () => JSON.stringify({ ...JSON.parse(ANSWER), legs }),
    ]);

    expect(await research()).toMatchObject({ legs });
    expect(calls).toHaveLength(2);
  });

  it("区間の所要時間や路線が読めなくても、行き方と区間を捨てない", async () => {
    const { calls, research } = setup([
      async (hook) => {
        await read(hook, "https://example.com/route");
        return JSON.stringify({
          ...JSON.parse(ANSWER),
          legs: [
            { from: "こがね台", to: "川辺", line: "こがね線", minutes: null },
            { means: "walk", from: "川辺", to: "鈴鳴駅", line: null, minutes: null },
          ],
        });
      },
    ]);

    expect(await research()).toMatchObject({
      minutes: [55, 70],
      legs: [
        { means: "train", from: "こがね台", to: "川辺", line: "こがね線", minutes: null },
        { means: "walk", from: "川辺", to: "鈴鳴駅", line: null, minutes: null },
      ],
    });
    expect(calls).toHaveLength(1);
  });

  it("区間の駅の名前の書き方が違っても使い、両端を頼んだ駅の名前にそろえる", async () => {
    const { research } = setup([
      async (hook) => {
        await read(hook, "https://example.com/route");
        return JSON.stringify({
          ...JSON.parse(ANSWER),
          legs: [{ ...legs[0], from: `${legs[0]?.from}駅` }, ...legs.slice(1)],
        });
      },
    ]);
    expect((await research())?.legs?.[0]?.from).toBe(legs[0]?.from);
  });

  it("帰りは最終の時刻も調べる。分からなければ null にし、行きとは別にとっておく", async () => {
    const { calls, researcher } = setup([
      async (hook) => {
        await read(hook, "https://example.com/route");
        return JSON.stringify({ ...JSON.parse(ANSWER), lastDeparture: "22:40" });
      },
      async (hook) => {
        await read(hook, "https://example.com/route");
        return ANSWER;
      },
    ]);
    const back = await researcher.research({
      from: "鈴鳴駅",
      to: "こがね台",
      date: "2026-08-16",
      direction: "return",
      signal: new AbortController().signal,
    });
    expect(back).toMatchObject({ lastDeparture: "22:40" });
    expect(calls[0]?.prompt).toContain("帰り");

    // 行きは最終を持たない。調べ直し（focus）は、とっておいた結果を使わない
    const go = await researcher.research({
      from: "鈴鳴駅",
      to: "こがね台",
      date: "2026-08-16",
      focus: "乗り換えの駅を確かめる",
      signal: new AbortController().signal,
    });
    expect(go).not.toHaveProperty("lastDeparture");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toContain("調べ直しで特に確かめること：乗り換えの駅を確かめる");
  });
});
