import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// GitHub の設定のファイル（ラベル・Issue テンプレート・CI・setup-github.sh）が互いに食い違わないことを確かめる。

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

interface Label {
  name: string;
  color: string;
  description: string;
}

const labels = JSON.parse(read(".github/labels.json")) as Label[];
const labelNames = labels.map((l) => l.name);

const templatesDir = ".github/ISSUE_TEMPLATE";
const templates = readdirSync(path.join(root, templatesDir))
  .filter((f) => f.endsWith(".yml") && f !== "config.yml")
  .map((f) => ({ file: f, text: read(`${templatesDir}/${f}`) }));

/** テンプレートの labels: ["a", "b"] を読む */
function templateLabels(text: string): string[] {
  const line = text.match(/^labels:\s*\[(.*)\]\s*$/m)?.[1] ?? "";
  return [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

describe("ラベル", () => {
  it("名前が重ならず、色は6桁の16進数で、説明がある", () => {
    expect(new Set(labelNames).size).toBe(labelNames.length);
    for (const label of labels) {
      expect(label.color, label.name).toMatch(/^[0-9a-f]{6}$/);
      expect(label.description.length, label.name).toBeGreaterThan(0);
      // GitHub のラベルの説明は 100 文字まで
      expect(label.description.length, label.name).toBeLessThanOrEqual(100);
    }
  });

  it("type・area・priority・status の体系か、テンプレートが前から使う名前", () => {
    const legacy = new Set(["bug", "data-correction", "listing-request", "opt-out"]);
    for (const name of labelNames) {
      expect(legacy.has(name) || /^(type|area|priority|status):[a-z0-9-]+$/.test(name), name).toBe(
        true,
      );
    }
  });

  it("どの Issue テンプレートも、type:* と status:triage を付け、一覧にあるラベルだけを使う", () => {
    expect(templates.length).toBeGreaterThanOrEqual(6);
    for (const { file, text } of templates) {
      const used = templateLabels(text);
      expect(
        used.filter((name) => !labelNames.includes(name)),
        file,
      ).toEqual([]);
      expect(
        used.some((name) => name.startsWith("type:")),
        file,
      ).toBe(true);
      expect(used, file).toContain("status:triage");
    }
  });

  it("作業のテンプレートの場所の選択肢は、area:* のラベルと同じ", () => {
    const task = templates.find((t) => t.file === "task.yml")?.text ?? "";
    const options = task
      .split(/^ {2}- type:/m)
      .find((block) => block.includes("id: area"))
      ?.match(/^ {8}- (\S+)$/gm)
      ?.map((line) => line.trim().slice(2));
    const areas = labelNames.filter((n) => n.startsWith("area:")).map((n) => n.slice(5));
    expect(options).toEqual(areas);
  });
});

describe("ワークフロー", () => {
  const workflows = readdirSync(path.join(root, ".github/workflows"))
    .filter((f) => f.endsWith(".yml"))
    .map((f) => ({ file: f, text: read(`.github/workflows/${f}`) }));

  it("外部のアクションは、コミットの SHA で指定する", () => {
    for (const { file, text } of workflows) {
      for (const [, ref] of text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)) {
        if (ref?.startsWith("./")) continue;
        expect(ref, file).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      }
    }
  });

  it("週次の調査は、準備と回収のジョブに書き込みの権限を、PR のジョブに Anthropic の認証を渡さない", () => {
    const text = read(".github/workflows/update-festivals.yml");
    const [research, pullRequest] = text.split(/^ {2}pull-request:$/m);
    const researchJob = research?.split(/^ {2}research:$/m)[1] ?? "";
    expect(researchJob).toContain("id-token: write");
    expect(researchJob).not.toMatch(/(contents|pull-requests|issues|actions): write/);
    expect(pullRequest).toBeDefined();
    expect(pullRequest).not.toMatch(/id-token|ANTHROPIC_/);
    // GITHUB_TOKEN で開いた PR の CI は承認待ちで止まるので、PR のジョブが承認する
    expect(pullRequest).toContain("/approve");
    expect(pullRequest).toContain("status=action_required");
    // 調査の結果の JSON は、PR の lint に通るように整形してから渡す
    expect(researchJob).toContain("biome format --stdin-file-path");
  });
});

describe("main の必須の検査", () => {
  it("setup-github.sh の REQUIRED_CHECKS は、ci.yml のジョブの name と同じ", () => {
    const required = read("scripts/setup-github.sh")
      .match(/^REQUIRED_CHECKS=\((.*)\)$/m)?.[1]
      ?.split(/\s+/)
      .filter(Boolean);
    const jobs = [
      ...read(".github/workflows/ci.yml").matchAll(/^ {2}[\w-]+:\n {4}name: (.+)$/gm),
    ].map((m) => m[1]?.trim());
    expect(required).toBeDefined();
    expect([...(required ?? [])].sort()).toEqual([...jobs].sort());
  });
});
