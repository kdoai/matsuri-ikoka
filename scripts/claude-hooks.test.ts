import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error 開発用のフックは JavaScript のまま置く（型の宣言を持たない）
import { festivalDataRoot } from "../.claude/hooks/validate-festivals.mjs";

// Claude Code のフック（.claude/settings.json）が、存在するスクリプトを指し、
// 祭りのデータを変えたときだけ検証を走らせることを確かめる。

const root = path.join(import.meta.dirname, "..");
const script = path.join(root, ".claude", "hooks", "validate-festivals.mjs");
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
  it("PostToolUse の command が指すスクリプトがリポジトリにある", () => {
    const settings = JSON.parse(readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));
    const groups = settings.hooks?.PostToolUse ?? [];
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      for (const hook of group.hooks) {
        expect(hook.type).toBe("command");
        const match = /\$\{CLAUDE_PROJECT_DIR\}\/([^"']+)/.exec(hook.command);
        expect(match, hook.command).not.toBeNull();
        expect(existsSync(path.join(root, match?.[1] ?? ""))).toBe(true);
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
