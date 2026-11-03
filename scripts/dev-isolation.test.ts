import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildVerifierOptions } from "../apps/server/src/agent/webVerifier";

// 開発用のもの（.claude/ のスキル・エージェント・フック、CLAUDE.md、.mcp.json）とアプリを分ける。
// 接客エージェントと再確認のエージェントがこれらを読まないこと、コンテナに入らないことを守る。

const root = path.join(import.meta.dirname, "..");
const DEV_ONLY = new Set([".claude", "CLAUDE.md", "CLAUDE.local.md", ".mcp.json"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", "test-results", ".vite"]);

function walk(dir: string, visit: (file: string, name: string) => void) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    visit(full, name);
    if (statSync(full).isDirectory() && !DEV_ONLY.has(name)) walk(full, visit);
  }
}

/** アプリのソース（テストを除く）。apps/*\/src・apps/*\/scripts・packages/*\/src */
function appSources(): string[] {
  const files: string[] = [];
  for (const group of ["apps", "packages"]) {
    for (const pkg of readdirSync(path.join(root, group))) {
      for (const sub of ["src", "scripts"]) {
        const dir = path.join(root, group, pkg, sub);
        if (!existsSync(dir)) continue;
        walk(dir, (file) => {
          if (/\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file)) files.push(file);
        });
      }
    }
  }
  return files;
}

const rel = (file: string) => path.relative(root, file).replaceAll(path.sep, "/");

describe("開発用のものは、リポジトリの根の .claude/ にだけ置く", () => {
  it("apps・packages・data・assets に .claude・CLAUDE.md・.mcp.json がない", () => {
    const found: string[] = [];
    for (const dir of ["apps", "packages", "data", "assets"]) {
      walk(path.join(root, dir), (file, name) => {
        if (DEV_ONLY.has(name)) found.push(rel(file));
      });
    }
    expect(found).toEqual([]);
  });

  it("アプリのソースは .claude/ や CLAUDE.md を参照しない", () => {
    const found = appSources().filter((file) =>
      /\.claude[/\\]|CLAUDE(\.local)?\.md|\.mcp\.json/.test(readFileSync(file, "utf8")),
    );
    expect(found.map(rel)).toEqual([]);
  });
});

describe("エージェントはファイルの設定を読まない（settingSources: []）", () => {
  const sources = appSources().map((file) => ({ file, text: readFileSync(file, "utf8") }));

  it("settingSources は、どこでも空の配列", () => {
    const found = sources.flatMap(({ file, text }) =>
      [...text.matchAll(/settingSources\s*:\s*([^,\n}]+)/g)]
        .filter((m) => m[1]?.trim() !== "[]")
        .map((m) => `${rel(file)}: ${m[0]}`),
    );
    expect(found).toEqual([]);
  });

  it("Agent SDK のオプション（systemPrompt を持つもの）には、必ず settingSources: [] がある", () => {
    const literals = sources.flatMap(({ file, text }) => {
      // 型の宣言（systemPrompt: string;）は数えない
      const prompts = text.match(/^\s*systemPrompt\s*:[^;\n]*$/gm)?.length ?? 0;
      const empty = text.match(/settingSources\s*:\s*\[\]/g)?.length ?? 0;
      return prompts > 0 ? [{ file: rel(file), prompts, empty }] : [];
    });
    // 接客エージェント（options.ts）と再確認のエージェント（webVerifier.ts）の2か所はある
    expect(literals.length).toBeGreaterThanOrEqual(2);
    for (const literal of literals) {
      expect(literal.empty, literal.file).toBeGreaterThanOrEqual(literal.prompts);
    }
  });

  it("再確認のエージェントは、道具の有無にかかわらず設定・プラグイン・MCP を読まない", () => {
    for (const withTools of [true, false]) {
      const options = buildVerifierOptions({
        systemPrompt: "架空の祭りを確かめる",
        cwd: root,
        env: {},
        abortController: new AbortController(),
        withTools,
      });
      expect(options).toMatchObject({
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: {},
        plugins: [],
      });
    }
  });
});

describe("コンテナに開発用のものを入れない", () => {
  const ignore = readFileSync(path.join(root, ".dockerignore"), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim());

  it(".dockerignore が .claude・CLAUDE.md・.mcp.json を外す", () => {
    for (const pattern of ["**/.claude", "**/CLAUDE.md", "**/CLAUDE.local.md", "**/.mcp.json"]) {
      expect(ignore).toContain(pattern);
    }
  });

  it("Dockerfile はビルドの文脈を丸ごと写さない", () => {
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
    expect(dockerfile).not.toMatch(/^\s*(COPY|ADD)\s+(--\S+\s+)*\.\s/m);
  });
});
