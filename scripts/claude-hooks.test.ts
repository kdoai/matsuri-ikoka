import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  englishLines,
  isTooEnglish,
  REPLY_IN_JAPANESE,
  stripNonProse,
  textOfLastTurn,
  // @ts-expect-error 開発用のフックは JavaScript のまま置く（型の宣言を持たない）
} from "../.claude/hooks/japanese-reply.mjs";
// @ts-expect-error 開発用のフックは JavaScript のまま置く（型の宣言を持たない）
import { festivalDataRoot } from "../.claude/hooks/validate-festivals.mjs";

// Claude Code のフック（.claude/settings.json）が、存在するスクリプトを指し、
// 祭りのデータを変えたときだけ検証を走らせること、回答を日本語に保つことを確かめる。

const root = path.join(import.meta.dirname, "..");
const script = path.join(root, ".claude", "hooks", "validate-festivals.mjs");
const japaneseScript = path.join(root, ".claude", "hooks", "japanese-reply.mjs");
/** Windows の区切り（バックスラッシュ）でつないだパス */
const windowsPath = (...parts: string[]) => parts.join(String.fromCharCode(92));

function runHook(toolInput: Record<string, unknown>, cwd = root) {
  return spawnSync(process.execPath, [script], {
    cwd,
    encoding: "utf8",
    input: JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: toolInput,
      cwd,
    }),
  });
}

describe("共有の設定のフック", () => {
  it("どのフックの command も、リポジトリにあるスクリプトを指す", () => {
    const settings = JSON.parse(readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));
    const events = Object.keys(settings.hooks ?? {});
    expect(events).toEqual(expect.arrayContaining(["PostToolUse", "UserPromptSubmit", "Stop"]));
    for (const event of events) {
      const groups: { hooks: { type: string; command: string }[] }[] = settings.hooks[event];
      expect(groups.length).toBeGreaterThan(0);
      for (const group of groups) {
        for (const hook of group.hooks) {
          expect(hook.type).toBe("command");
          const match = /\$\{CLAUDE_PROJECT_DIR\}\/([^"']+)/.exec(hook.command);
          expect(match, hook.command).not.toBeNull();
          expect(existsSync(path.join(root, match?.[1] ?? ""))).toBe(true);
        }
      }
    }
  });
});

describe("festivalDataRoot", () => {
  it("祭りのデータと調査の台帳のパスから、リポジトリの根を返す", () => {
    expect(festivalDataRoot("/repo/data/festivals/example-matsuri.json")).toBe("/repo");
    expect(
      festivalDataRoot(
        windowsPath("C:", "work", "repo", "data", "festivals", "example-matsuri.json"),
      ),
    ).toBe(windowsPath("C:", "work", "repo"));
    expect(festivalDataRoot("/repo/data/research-ledger.json")).toBe("/repo");
  });

  it("祭りのデータ以外は null", () => {
    expect(festivalDataRoot("/repo/data/samples/example.json")).toBeNull();
    expect(festivalDataRoot("/repo/data/festivals/README.md")).toBeNull();
    expect(festivalDataRoot("/repo/apps/server/src/index.ts")).toBeNull();
    expect(festivalDataRoot(undefined)).toBeNull();
  });
});

describe("フックの実行", () => {
  it("祭りのデータ以外の編集では何もせず 0 で終わる", () => {
    const result = runHook({ file_path: path.join(root, "README.md") });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("祭りのデータの編集では検証を走らせ、いまのデータでは 0 で終わる", () => {
    const result = runHook({
      file_path: path.join(root, "data", "festivals", "example-matsuri.json"),
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  }, 60_000);

  it("検証がエラーなら、結果を標準エラーに出して 2 で終わる", () => {
    // validate:data が失敗する小さなパッケージを用意し、その中の祭りのデータを変えたことにする
    const dir = mkdtempSync(path.join(tmpdir(), "matsuri-hook-"));
    mkdirSync(path.join(dir, "data", "festivals"), { recursive: true });
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "hook-fixture",
        private: true,
        scripts: {
          "validate:data":
            "node -e \"console.log('example.json: エラー 出典がない'); process.exit(1)\"",
        },
      }),
    );
    const file = path.join(dir, "data", "festivals", "example.json");
    writeFileSync(file, "{}");
    const result = runHook({ file_path: file }, dir);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("祭りのデータの検証でエラーがありました");
    expect(result.stderr).toContain("出典がない");
  }, 60_000);
});

function runJapaneseHook(input: Record<string, unknown>) {
  return spawnSync(process.execPath, [japaneseScript], {
    cwd: root,
    encoding: "utf8",
    input: JSON.stringify(input),
  });
}

/** 会話の記録（JSONL）の1行 */
const userLine = (text: string) =>
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text }] } });
const assistantLine = (text: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
const lines = (...parts: string[]) => parts.join("\n");

const ENGLISH = "The festival data was updated and the checks passed without any problems.";
const ENGLISH_2 = "Next we will open a pull request and wait for the review to finish.";
const LONG_JAPANESE = "日本語の前置きです。十分に長い日本語の文をここに書きます。";

function writeTranscript(name: string, answer: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "matsuri-hook-"));
  const file = path.join(dir, name);
  writeFileSync(file, lines(userLine("確かめて"), assistantLine(answer)));
  return file;
}

describe("日本語に保つフックの判定", () => {
  it("コードの塊・インラインのコード・URL・パスは英語として数えない", () => {
    const text = lines(
      "検証を走らせました。",
      "```bash",
      "pnpm --filter @matsuri-ikoka/web test:e2e and then run the build again",
      "```",
      "`pnpm lint and pnpm typecheck and pnpm test`",
      "https://example.com/this/is/a/long/english/path",
    );
    expect(englishLines(text).lines).toEqual([]);
    expect(isTooEnglish(text)).toBe(false);
    expect(stripNonProse("`a b c`")).not.toContain("a b c");
  });

  it("日本語の文に英単語が混ざるだけなら通す", () => {
    const text = "Claude Code の skills と hooks と MCP を使い分けて開発しています。";
    expect(isTooEnglish(text)).toBe(false);
  });

  it("英語の文が2行あれば書き直させる", () => {
    expect(isTooEnglish(lines(LONG_JAPANESE, ENGLISH, ENGLISH_2))).toBe(true);
  });

  it("日本語がほとんどなく英語の文があれば、1行でも書き直させる", () => {
    expect(isTooEnglish(lines("はい。", ENGLISH))).toBe(true);
    expect(isTooEnglish(lines(LONG_JAPANESE, ENGLISH))).toBe(false);
  });

  it("最後の人の発言より後の、アシスタントの文章だけを集める", () => {
    const transcript = lines(
      userLine("前の発言"),
      assistantLine("前の回答"),
      userLine("今の発言"),
      assistantLine("今の回答その1"),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result" }] } }),
      assistantLine("今の回答その2"),
      "壊れた行",
    );
    expect(textOfLastTurn(transcript)).toBe(lines("今の回答その1", "今の回答その2"));
  });
});

describe("日本語に保つフックの実行", () => {
  it("UserPromptSubmit では、日本語で答えることを文脈に足す", () => {
    const result = runJapaneseHook({ hook_event_name: "UserPromptSubmit", prompt: "テスト" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput).toEqual({
      hookEventName: "UserPromptSubmit",
      additionalContext: REPLY_IN_JAPANESE,
    });
  });

  it("Stop で英語の回答なら止めて書き直させる", () => {
    const transcript = writeTranscript("english.jsonl", lines(ENGLISH, ENGLISH_2));
    const result = runJapaneseHook({ hook_event_name: "Stop", transcript_path: transcript });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.decision).toBe("block");
    expect(output.reason).toContain("日本語で書き直して");
  });

  it("Stop で日本語の回答なら何もしない", () => {
    const transcript = writeTranscript("japanese.jsonl", "検証はすべて通りました。");
    const result = runJapaneseHook({ hook_event_name: "Stop", transcript_path: transcript });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("書き直しのあと（stop_hook_active）と、記録が読めないときは止めない", () => {
    const transcript = writeTranscript("english.jsonl", lines(ENGLISH, ENGLISH_2));
    const again = runJapaneseHook({
      hook_event_name: "Stop",
      transcript_path: transcript,
      stop_hook_active: true,
    });
    expect(again.stdout).toBe("");
    const missing = runJapaneseHook({
      hook_event_name: "Stop",
      transcript_path: path.join(path.dirname(transcript), "missing.jsonl"),
    });
    expect(missing.status).toBe(0);
    expect(missing.stdout).toBe("");
  });
});
