import type {
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  Options,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { lodgingSearchPlans } from "../domain/lodgingResearch";
import type { QueryFn } from "./runner";
import { initMessage, MAX_TURNS, resultMessage, type ScriptResult } from "./testSdkMessages";
import { createWebLodgingResearcher, LODGING_MAX_TURNS, parseHotels } from "./webLodgingResearcher";

// Agent SDK の代わりに、フックを呼んで決まった返答を返す偽物の query で確かめる。祭り・宿・URL はすべて架空

type Hook = (event: HookEvent, input: Record<string, unknown>) => Promise<unknown>;
/** 依頼文（観点の見出しを含む）から、その観点の調べ役の動きを決める */
type Script = (prompt: string, hook: Hook) => Promise<ScriptResult>;

function setup(script: Script, forgotten: string[] = []) {
  const calls: { prompt: string; options: Options }[] = [];
  const query: QueryFn = (params) => {
    calls.push(params);
    const hook: Hook = async (event, input) => {
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
    const sessionId = `session-${calls.length}`;
    return (async function* () {
      yield initMessage(sessionId);
      yield resultMessage(await script(params.prompt as string, hook));
    })();
  };
  const researcher = createWebLodgingResearcher({
    prompt: "宿の調べ",
    cwd: "/tmp/matsuri-agent-test",
    env: {},
    query,
    resolveHost: async () => ["8.8.8.8"],
    forgetTranscript: (id) => {
      forgotten.push(id);
    },
  });
  const party = { adults: 2, children: 1 };
  const plans = lodgingSearchPlans({
    festival: { name: "鈴鳴灯籠まつり", place: "鈴鳴町", venueName: "鈴鳴川の河原" },
    stations: ["鈴鳴駅"],
    checkIn: "2026-08-16",
    nights: 1,
    party,
    perPersonNightLimitYen: 12_000,
  });
  const research = () =>
    researcher.research({
      festival: {
        id: "suzunari-toro",
        name: "鈴鳴灯籠まつり",
        place: "滋賀県鈴鳴町",
        venue: { name: "鈴鳴川の河原", lat: 35.12, lng: 136.08 },
      },
      checkIn: "2026-08-16",
      nights: 1,
      party,
      perPersonNightLimitYen: 12_000,
      plans,
      signal: new AbortController().signal,
    });
  return { calls, research, plans };
}

const read = (hook: Hook, url: string) =>
  hook("PostToolUse", {
    tool_name: "WebFetch",
    tool_input: { url, prompt: "宿の場所と料金" },
    tool_response: { bytes: 0, code: 200, codeText: "OK", result: "", url },
  });

const INN = {
  name: "鈴鳴川の宿",
  summary: "河原まで歩いてすぐの和室のある宿",
  lat: 35.121,
  lng: 136.081,
  perPersonNightYen: [8000, 11000],
  price: "1泊朝食つき 1人8,000円から",
  familyFriendly: true,
  pageUrl: "https://example.com/inn/kawa",
  sources: [{ url: "https://example.com/inn/kawa", title: "鈴鳴川の宿" }],
};

describe("createWebLodgingResearcher", () => {
  it("観点ごとに1つの調べ役を並べて動かし、観点ごとの報告を返す", async () => {
    const { calls, research, plans } = setup(async (_prompt, hook) => {
      await read(hook, INN.pageUrl);
      return JSON.stringify({ hotels: [INN] });
    });
    const result = await research();
    expect(calls).toHaveLength(plans.length);
    expect(plans.map((p) => p.perspective)).toEqual(["venue", "station", "budget", "family"]);
    expect(result?.reports.map((r) => r.perspective)).toEqual(plans.map((p) => p.perspective));
    expect(result?.reports[0]?.hotels[0]).toMatchObject({
      name: "鈴鳴川の宿",
      location: { lat: 35.121, lng: 136.081 },
      pageUrl: "https://example.com/inn/kawa",
    });
    // 調べ役は Web の検索と取得だけを使い、依頼文に観点と検索の言葉が入る
    expect(calls[0]?.options.allowedTools).toEqual(["WebSearch", "WebFetch"]);
    expect(calls[0]?.options.maxTurns).toBe(LODGING_MAX_TURNS);
    expect(calls[0]?.prompt).toContain("観点：会場の近くの宿");
    expect(calls[0]?.prompt).toContain("鈴鳴川の河原 近く ホテル");
    expect(calls[3]?.prompt).toContain("観点：家族で泊まりやすい宿");
  });

  it("1つの観点が失敗しても、ほかの観点の報告を使う", async () => {
    const { research } = setup(async (prompt, hook) => {
      if (prompt.includes("観点：会場の近くの宿")) return null;
      await read(hook, INN.pageUrl);
      return JSON.stringify({ hotels: [INN] });
    });
    const result = await research();
    expect(result?.reports.map((r) => r.perspective)).toEqual(["station", "budget", "family"]);
  });

  it("ターンの上限で終わった観点は、同じセッションを道具なしで続けて宿を救う", async () => {
    const forgotten: string[] = [];
    const { calls, research } = setup(async (prompt, hook) => {
      // 救いの頼み（道具なし）には、読んだ宿で答える
      if (prompt.includes("ターンの上限に達した")) return JSON.stringify({ hotels: [INN] });
      await read(hook, INN.pageUrl);
      return prompt.includes("観点：会場の近くの宿")
        ? MAX_TURNS
        : JSON.stringify({ hotels: [INN] });
    }, forgotten);

    const result = await research();

    expect(result?.reports.map((r) => r.perspective)).toEqual([
      "venue",
      "station",
      "budget",
      "family",
    ]);
    expect(result?.reports[0]?.hotels[0]?.name).toBe("鈴鳴川の宿");
    expect(calls).toHaveLength(5);
    const salvage = calls.find((call) => call.prompt.includes("ターンの上限に達した"));
    expect(salvage?.options).toMatchObject({ tools: [], maxTurns: 1 });
    expect(typeof salvage?.options.resume).toBe("string");
    // 観点ごとの会話の記録を、調べが終わるたびに消す
    expect(forgotten).toHaveLength(4);
  });

  it("ページを1つも読んでいなければ、調べたことにしない", async () => {
    const { research } = setup(async () => JSON.stringify({ hotels: [INN] }));
    expect(await research()).toBeNull();
  });
});

describe("parseHotels", () => {
  it("読んでいないページを出典から外し、出典が残らない宿は入れない", () => {
    const hotels = parseHotels(
      [
        INN,
        {
          ...INN,
          name: "読んでいない宿",
          pageUrl: "https://example.com/inn/unread",
          sources: [{ url: "https://example.com/inn/unread" }],
        },
      ],
      ["https://example.com/inn/kawa"],
    );
    expect(hotels.map((h) => h.name)).toEqual(["鈴鳴川の宿"]);
  });

  it("宿のページを読んでいなければ、読んだ最初のページを宿のページにする", () => {
    const [hotel] = parseHotels(
      [
        {
          ...INN,
          pageUrl: "https://example.com/inn/other",
          sources: [{ url: "https://example.com/list/suzunari" }],
        },
      ],
      ["https://example.com/list/suzunari"],
    );
    expect(hotel?.pageUrl).toBe("https://example.com/list/suzunari");
  });

  it("形の合わない宿と、外の Web でない URL は捨てる", () => {
    const hotels = parseHotels(
      [
        { ...INN, lat: "北のほう" },
        {
          ...INN,
          pageUrl: "http://127.0.0.1/inn",
          sources: [{ url: "http://127.0.0.1/inn" }],
        },
      ],
      ["http://127.0.0.1/inn", INN.pageUrl],
    );
    expect(hotels).toEqual([]);
  });
});
