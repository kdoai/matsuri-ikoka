import type {
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  Options,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import type { QueryFn } from "./runner";
import { createWebNearbyResearcher } from "./webNearbyResearcher";

// Agent SDK の代わりに、フックを呼んで決まった返答を返す偽物の query で確かめる。祭り・店・URL はすべて架空

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
  const researcher = createWebNearbyResearcher({
    prompt: "寄り道の調べ",
    cwd: "/tmp/matsuri-agent-test",
    env: {},
    query,
    resolveHost: async () => ["8.8.8.8"],
  });
  const research = (foodWishes: ("meat" | "noodles")[] = ["meat"]) =>
    researcher.research({
      festival: {
        id: "suzunari-toro",
        name: "鈴鳴灯籠まつり",
        place: "滋賀県鈴鳴町",
        venue: { name: "鈴鳴川の河原", lat: 35.12, lng: 136.08 },
      },
      date: "2026-08-16",
      foodWishes,
      dietary: [],
      perPersonBudgetYen: 20_000,
      party: { adults: 2, children: 1 },
      references: [{ name: "鈴鳴和紙の館", kind: "sightseeing", summary: "和紙すきの工房" }],
      signal: new AbortController().signal,
    });
  return { calls, research };
}

const read = (hook: Parameters<Script>[0], url: string) =>
  hook("PostToolUse", {
    tool_name: "WebFetch",
    tool_input: { url, prompt: "営業時間と定休日" },
    tool_response: { bytes: 0, code: 200, codeText: "OK", result: "", url },
  });

const GRILL = {
  name: "鈴鳴グリル",
  kind: "food",
  summary: "炭火焼きの肉料理の店",
  lat: 35.122,
  lng: 136.082,
  foods: ["meat"],
  dietaryOk: [],
  adultsOnly: false,
  pricePerPersonYen: [1500, 3000],
  price: "ランチ 1,500円から",
  hours: { open: "11:00", close: "21:00" },
  closedDays: ["wed"],
  openOnDate: "open",
  sources: [
    { url: "https://example.com/grill", title: "鈴鳴グリル" },
    { url: "https://example.com/not-read", title: "読んでいないページ" },
  ],
};

const ANSWER = JSON.stringify({
  spots: [
    GRILL,
    // 形の合わない場所と、読んだページのない場所は捨てる
    { name: "形の合わない店", kind: "bar" },
    { ...GRILL, name: "読んでいない店", sources: [{ url: "https://example.com/not-read" }] },
  ],
});

describe("createWebNearbyResearcher", () => {
  it("調べた場所を返し、実際に読んだページだけを出典に残す。同じ条件はとっておいた結果を使う", async () => {
    const { calls, research } = setup([
      async (hook) => {
        await read(hook, "https://example.com/grill");
        return ANSWER;
      },
    ]);

    const report = await research();
    expect(report?.spots).toEqual([
      {
        name: "鈴鳴グリル",
        kind: "food",
        summary: "炭火焼きの肉料理の店",
        location: { lat: 35.122, lng: 136.082 },
        foods: ["meat"],
        dietaryOk: [],
        adultsOnly: false,
        pricePerPersonYen: [1500, 3000],
        price: "ランチ 1,500円から",
        hours: { open: "11:00", close: "21:00" },
        closedDays: ["wed"],
        openOnDate: "open",
        sources: [{ url: "https://example.com/grill", title: "鈴鳴グリル" }],
      },
    ]);
    expect(calls[0]?.options.tools).toEqual(["WebSearch", "WebFetch"]);
    expect(calls[0]?.prompt).toContain("食べたいもの：meat（肉料理）");
    expect(calls[0]?.prompt).toContain("同行者：子ども連れ");
    expect(calls[0]?.prompt).toContain("鈴鳴和紙の館");

    expect(await research()).toEqual(report);
    expect(calls).toHaveLength(1);
    // 食べたいものが変われば、調べ直す
    await expect(research(["noodles"])).rejects.toThrow("台本がありません");
  });

  it("ページを1つも読まずに答えたときや、失敗したときは null", async () => {
    const unread = setup([async () => ANSWER]);
    expect(await unread.research()).toBeNull();

    const failed = setup([async () => null]);
    expect(await failed.research()).toBeNull();
  });

  it("見つからなければ、空の場所の並びを返す（合わない店で埋めない）", async () => {
    const { research } = setup([
      async (hook) => {
        await read(hook, "https://example.com/search");
        return JSON.stringify({ spots: [] });
      },
    ]);
    expect(await research()).toEqual({ spots: [] });
  });

  it("JSON を取り出せなければ、道具なしで1回だけ差し戻す", async () => {
    const { calls, research } = setup([
      async (hook) => {
        await read(hook, "https://example.com/grill");
        return "鈴鳴グリルがおすすめです";
      },
      async () => ANSWER,
    ]);

    expect((await research())?.spots).toHaveLength(1);
    expect(calls[1]?.options.tools).toEqual([]);
  });
});
