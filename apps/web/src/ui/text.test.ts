import { fictionalSource } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { MESSAGES } from "../i18n";
import type { ChatEntry } from "../state/types";
import { resolveShioriUrl, shioriShareUrl } from "./links";
import {
  errorText,
  guideToolText,
  printedUrl,
  shortLine,
  staffDetailText,
  staffLineText,
} from "./text";

const fromServer: Extract<ChatEntry, { kind: "error" }> = {
  kind: "error",
  id: "e-1",
  code: "rate_limited",
  message: "今日の相談の受付は終わりました。",
  retryable: false,
  resolved: false,
};

describe("エラーの一文", () => {
  it("日本語の画面では、サーバーの一文を出す", () => {
    expect(errorText(fromServer, "ja", MESSAGES.ja)).toBe("今日の相談の受付は終わりました。");
  });

  it("英語の画面では、サーバーの日本語ではなく辞書の文言を出す", () => {
    expect(errorText(fromServer, "en", MESSAGES.en)).toBe(MESSAGES.en.chat.errors.rate_limited);
  });

  it("サーバーの一文がなければ、辞書の文言を出す", () => {
    expect(errorText({ ...fromServer, message: null }, "ja", MESSAGES.ja)).toBe(
      MESSAGES.ja.chat.errors.rate_limited,
    );
  });
});

describe("送り直せる bad_request の一文", () => {
  const busy = {
    code: "bad_request" as const,
    message: "前の返事を作っています。",
    retryable: true,
  };

  it("英語の画面では、前の返事を作っている途中だと言う", () => {
    expect(errorText(busy, "en", MESSAGES.en)).toBe(MESSAGES.en.chat.busy);
    expect(errorText({ ...busy, retryable: false }, "en", MESSAGES.en)).toBe(
      MESSAGES.en.chat.errors.bad_request,
    );
  });

  it("日本語の画面では、サーバーの一文を出す", () => {
    expect(errorText(busy, "ja", MESSAGES.ja)).toBe("前の返事を作っています。");
  });
});

describe("スタッフの吹き出し", () => {
  const search = {
    kind: "tool_end",
    tool: "search_festivals",
    ok: true,
    count: 2,
    top: "架空の灯籠まつり",
  } as const;

  it("日本語の画面では、サーバーが決まった型で作った文をそのまま出す", () => {
    expect(staffLineText("2件見つかりました", search, MESSAGES.ja)).toBe("2件見つかりました");
    expect(
      staffDetailText(
        { bubble: "2件見つかりました", detail: "希望の日に2件", cue: search },
        MESSAGES.ja,
      ),
    ).toBe("希望の日に2件");
  });

  it("英語の画面では、イベントの型から辞書で言い直す", () => {
    expect(staffLineText("2件見つかりました", search, MESSAGES.en)).toBe("Found 2 festivals");
    expect(
      staffDetailText(
        { bubble: "2件見つかりました", detail: "希望の日に2件", cue: search },
        MESSAGES.en,
      ),
    ).toBe("Found 2 festivals. The top one is 架空の灯籠まつり");
    // くわしい文を持たない型は、辞書の吹き出しを出す（サーバーの日本語には戻らない）
    expect(
      staffDetailText(
        {
          bubble: "天気を確かめています",
          detail: "8月16日の天気",
          cue: { kind: "tool_start", tool: "get_weather" },
        },
        MESSAGES.en,
      ),
    ).toBe("Checking the weather for the day");
  });

  it("英語の辞書は、すべての作業・ツール・調べ直しに文を持つ", () => {
    const t = MESSAGES.en;
    const texts = [
      ...(["find_festivals", "find_nearby", "plan_route"] as const).flatMap((task) => [
        t.lines.bubble({ kind: "start", task, replan: false }),
        t.lines.bubble({ kind: "start", task, replan: true }),
      ]),
      ...(Object.keys(t.staff.tools) as (keyof typeof t.staff.tools)[]).flatMap((tool) => [
        t.lines.bubble({ kind: "tool_start", tool }),
        t.lines.bubble({ kind: "tool_end", tool, ok: true, count: 1, top: null }),
        t.lines.bubble({ kind: "tool_end", tool, ok: true, count: 0, top: null }),
        t.lines.bubble({ kind: "tool_end", tool, ok: false, count: null, top: null }),
      ]),
      ...(Object.keys(t.relay.redoSubjects) as (keyof typeof t.relay.redoSubjects)[]).flatMap(
        (subject) =>
          (["request", "accept"] as const).flatMap((redo) => [
            t.lines.bubble({ kind: "redo", redo, to: "scout", subject }),
            t.lines.detail({ kind: "redo", redo, to: "scout", subject }),
          ]),
      ),
    ];
    for (const text of texts) {
      expect(text).toMatch(/^[\x20-\x7e“”’]+$/);
    }
  });

  it("吹き出しがなければ、くわしい文もない", () => {
    expect(staffDetailText({ bubble: null, detail: null, cue: null }, MESSAGES.en)).toBeNull();
  });

  it("ガイドの調べものは、ツールと進みから辞書で言い直す", () => {
    const entry = {
      tool: "get_weather",
      bubble: "天気を確かめました",
      running: false,
      ok: true,
    } as const;
    expect(guideToolText(entry, MESSAGES.ja)).toBe("天気を確かめました");
    expect(guideToolText(entry, MESSAGES.en)).toBe("Checked the weather");
    expect(
      guideToolText({ tool: "get_weather", bubble: "天気を確かめています" }, MESSAGES.en),
    ).toBe("Checking the weather");
  });
});

describe("印刷したときの出典", () => {
  it("タイトルのある出典にだけ、URL を文字で添える", () => {
    const source = fictionalSource("2026");
    expect(printedUrl(source)).toBeNull();
    expect(printedUrl({ ...source, title: "開催のお知らせ" })).toBe(source.url);
  });
});

describe("しおりの共有の URL", () => {
  const origin = "https://example.com";
  const direct = "https://example.com/shiori/trip%201";

  it("接客サーバーのしおりの経路を指す", () => {
    expect(shioriShareUrl("trip 1", origin)).toBe(direct);
  });

  it("自分の旅程は共有の ID で開く", async () => {
    const ownShioriPath = async (id: string) => (id === "trip 1" ? "/shiori/sh-abc" : null);

    expect(await resolveShioriUrl({ ownShioriPath }, "trip 1", origin)).toBe(
      "https://example.com/shiori/sh-abc",
    );
  });

  it("ログインしていない・自分の旅程でないときは、旅程の ID で開く", async () => {
    expect(await resolveShioriUrl(null, "trip 1", origin)).toBe(direct);
    expect(await resolveShioriUrl({ ownShioriPath: async () => null }, "trip 1", origin)).toBe(
      direct,
    );
  });

  it("共有を作れないときは、例外にする", async () => {
    const ownShioriPath = () => Promise.reject(new Error("つながらない"));

    await expect(resolveShioriUrl({ ownShioriPath }, "trip 1", origin)).rejects.toThrow();
  });

  it("時間の上限を超えたら、例外にする", async () => {
    const ownShioriPath = () => new Promise<string | null>(() => {});

    await expect(resolveShioriUrl({ ownShioriPath }, "trip 1", origin, 5)).rejects.toThrow(
      "timeout",
    );
  });
});

describe("shortLine", () => {
  it("短いセリフはそのまま出す", () => {
    expect(shortLine("いらっしゃいませ！ 旅の相談ですね。")).toEqual({
      head: "いらっしゃいませ！ 旅の相談ですね。",
      rest: null,
    });
  });

  it("3文以上は2文に縮め、全文も残す", () => {
    const text = "候補を3つ見つけました。どれも川沿いの祭りです。会場までは電車で1時間ほどです。";
    expect(shortLine(text)).toEqual({
      head: "候補を3つ見つけました。どれも川沿いの祭りです。",
      rest: text,
    });
  });

  it("改行の段落で切る", () => {
    expect(shortLine("旅程を組みました！\n\n1. 会場へ向かう\n2. 屋台を回る").head).toBe(
      "旅程を組みました！",
    );
  });

  it("1文が長すぎるときは文字数で切る", () => {
    const line = shortLine("あ".repeat(120));
    expect(line.head).toBe(`${"あ".repeat(80)}…`);
    expect(line.rest).toBe("あ".repeat(120));
  });
});
