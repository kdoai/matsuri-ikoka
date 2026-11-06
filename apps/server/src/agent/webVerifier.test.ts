import type {
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  Options,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { createWebActivityLog } from "@matsuri-ikoka/agent-kit";
import { describe, expect, it } from "vitest";
import { testFestival } from "../domain/testFestivals";
import type { RobotsChecker } from "./robots";
import type { QueryFn } from "./runner";
import { createVerifierHooks, createWebVerifier, isRestrictedSite } from "./webVerifier";

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

/** WebFetch で読んだことにする。text はエージェントが受け取る本文（SDK の WebFetchOutput の result） */
const read = (hook: Parameters<Script>[0], url: string, text = "") =>
  hook("PostToolUse", {
    tool_name: "WebFetch",
    tool_input: { url, prompt: "開催日" },
    tool_response: { bytes: text.length, code: 200, codeText: "OK", result: text, url },
  });

/** 架空の祭りの、年の書かれた開催の知らせ */
const NOTICE_2026 = "鈴鳴灯籠まつり　２０２６年８月１６日（日）18時30分から。雨天決行。";

describe("isRestrictedSite", () => {
  it("読まないサイトは、サブドメインも止め、似た名前のサイトは止めない", () => {
    expect(isRestrictedSite("tabelog.com")).toBe(true);
    expect(isRestrictedSite("s.tabelog.com")).toBe(true);
    expect(isRestrictedSite("WWW.HOTPEPPER.JP")).toBe(true);
    expect(isRestrictedSite("example.com")).toBe(false);
    expect(isRestrictedSite("nottabelog.com")).toBe(false);
  });
});

describe("createVerifierHooks と robots.txt", () => {
  const preFetch = async (robots: RobotsChecker) => {
    const hooks = createVerifierHooks(
      createWebActivityLog(),
      async () => ["8.8.8.8"],
      [],
      "読んでください",
      robots,
    );
    const hook = hooks.PreToolUse?.[0]?.hooks[0];
    return hook?.(
      {
        hook_event_name: "PreToolUse",
        tool_name: "WebFetch",
        tool_input: { url: "https://example.com/shop" },
      } as unknown as HookInput,
      undefined,
      { signal: new AbortController().signal },
    );
  };

  it("robots.txt が断るページは読まず、許すページは読む", async () => {
    expect(JSON.stringify(await preFetch({ allowed: async () => false }))).toContain("robots.txt");
    expect(await preFetch({ allowed: async () => true })).toEqual({});
  });
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
        await read(hook, "https://example.com/suzunari/2026/", NOTICE_2026);
        return [
          "確認しました。",
          "```json",
          JSON.stringify({
            result: "as_planned",
            sources: [
              { url: "http://example.com/suzunari/2026", title: "開催のお知らせ" },
              { url: "https://example.net/not-read" },
            ],
            dateText: "2026年8月16日（日）",
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
        return JSON.stringify({ result: "not_found", sources: [] });
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
        return JSON.stringify({ result: "not_found", sources: [] });
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
        return JSON.stringify({ result: "not_found", sources: [] });
      },
    ]);

    await verify();

    expect(stops[0]).toMatchObject({ decision: "block" });
    expect(stops[1]).toEqual({});
  });

  it("JSON が崩れていれば、道具なしで1回だけ差し戻す", async () => {
    const { calls, verify } = setup([
      async (hook) => {
        await read(hook, "https://example.com/suzunari/2026", NOTICE_2026);
        return "結果は予定どおりです（JSON を書き忘れた）";
      },
      async () =>
        JSON.stringify({
          result: "as_planned",
          sources: [{ url: "https://example.com/suzunari/2026" }],
          dateText: "2026年8月16日",
        }),
    ]);

    const report = await verify();

    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toContain("前の返答");
    expect(calls[1]?.options.tools).toEqual([]);
    expect(report).toMatchObject({
      result: "as_planned",
      sources: [{ url: "https://example.com/suzunari/2026" }],
      yearStated: true,
    });
  });

  describe("今年の開催と書かれていたかは、写した日付の文と読んだページの本文からコードで決める", () => {
    const answer = (dateText: string | undefined, url = "https://example.com/suzunari/") =>
      JSON.stringify({
        result: "as_planned",
        sources: [{ url }],
        ...(dateText === undefined ? {} : { dateText }),
        yearStated: true, // 自己申告は読まない
      });

    it("ページに年がなく、例年の日付だけなら false", async () => {
      const { verify } = setup([
        async (hook) => {
          await read(
            hook,
            "https://example.com/suzunari/",
            "鈴鳴灯籠まつりは毎年8月16日に開かれます。",
          );
          return answer("毎年8月16日");
        },
      ]);

      expect((await verify()).yearStated).toBe(false);
    });

    it("写した文がページの本文にない（年を補った）なら false", async () => {
      const { verify } = setup([
        async (hook) => {
          await read(
            hook,
            "https://example.com/suzunari/",
            "鈴鳴灯籠まつりは毎年8月16日に開かれます。",
          );
          return answer("2026年8月16日");
        },
      ]);

      expect((await verify()).yearStated).toBe(false);
    });

    it("年の書かれた文が、出典に残していないページにしかないなら false", async () => {
      const { verify } = setup([
        async (hook) => {
          await read(
            hook,
            "https://example.com/suzunari/",
            "鈴鳴灯籠まつりは毎年8月16日に開かれます。",
          );
          await read(hook, "https://example.net/blog", NOTICE_2026);
          return answer("2026年8月16日（日）");
        },
      ]);

      expect((await verify()).yearStated).toBe(false);
    });

    it("日付の文を返さなければ false", async () => {
      const { verify } = setup([
        async (hook) => {
          await read(hook, "https://example.com/suzunari/2026", NOTICE_2026);
          return answer(undefined, "https://example.com/suzunari/2026");
        },
      ]);

      expect((await verify()).yearStated).toBe(false);
    });
  });

  it("差し戻しても取り出せないとき、失敗したときは「確認できず」", async () => {
    const broken = setup([async () => "読めない返答", async () => "まだ読めない"]);
    const failed = setup([async () => null]);

    expect((await broken.verify()).result).toBe("not_found");
    expect((await failed.verify()).result).toBe("not_found");
  });
});
