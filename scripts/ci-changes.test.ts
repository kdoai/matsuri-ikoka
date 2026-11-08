import { describe, expect, it } from "vitest";
import { affectedJobs, isDocument, toOutput } from "./ci-changes";

const none = {
  code: false,
  build: false,
  e2e: false,
  docker: false,
  data: false,
  workflows: false,
};
const everything = {
  code: true,
  build: true,
  e2e: true,
  docker: true,
  data: true,
  workflows: true,
};

describe("文書の見分け", () => {
  it.each([
    "README.md",
    "CONTRIBUTING.md",
    "CLAUDE.md",
    "docs/spec/api.md",
    "docs/adr/0001-example.svg",
    ".claude/skills/commit/SKILL.md",
    ".github/pull_request_template.md",
    "apps/web/README.md",
    "data/samples/README.md",
    "LICENSE",
  ])("%s は文書", (file) => {
    expect(isDocument(file)).toBe(true);
  });

  it.each([
    // 接客エージェントの指示はコード
    "apps/server/src/agent/prompts/concierge.md",
    "packages/schema/src/notes.md",
    // 根の外の CLAUDE.md は、置いてはいけないものなので test に見せる
    "apps/web/CLAUDE.md",
    "apps/server/src/index.ts",
    ".github/labels.json",
  ])("%s は文書ではない", (file) => {
    expect(isDocument(file)).toBe(false);
  });
});

describe("走らせるジョブ", () => {
  it("文書だけなら、どれも走らせない", () => {
    expect(affectedJobs(["README.md", "docs/spec/testing.md", ".claude/agents/x.md"])).toEqual(
      none,
    );
  });

  it("何も変わっていなければ、どれも走らせない", () => {
    expect(affectedJobs(["", "  "])).toEqual(none);
  });

  it("画面のソースなら、データの検証とワークフローの確認のほかを走らせる", () => {
    expect(affectedJobs(["apps/web/src/ui/Example.tsx"])).toEqual({
      ...everything,
      data: false,
      workflows: false,
    });
  });

  it("接客エージェントの指示（.md）は、画面と同じくコードとして扱う", () => {
    expect(affectedJobs(["apps/server/src/agent/prompts/concierge.md"]).e2e).toBe(true);
  });

  it("単体テストだけなら、型とテストだけ", () => {
    expect(affectedJobs(["apps/server/src/domain/example.test.ts"])).toEqual({
      ...none,
      code: true,
    });
  });

  it("通しテストだけなら、成果物は作らず e2e を走らせる", () => {
    expect(affectedJobs(["apps/web/e2e/example.spec.ts"])).toEqual({
      ...none,
      code: true,
      e2e: true,
    });
  });

  it("開発のスクリプトだけなら、型とテストだけ", () => {
    expect(affectedJobs(["scripts/evaluate-data.ts"])).toEqual({ ...none, code: true });
  });

  it("データの検証のスクリプトなら、データの検証も走らせる", () => {
    expect(affectedJobs(["scripts/festival-validation.ts"])).toEqual({
      ...none,
      code: true,
      data: true,
    });
  });

  it("祭りのデータなら、データの検証と、データを読む画面とサーバーの確かめを走らせる", () => {
    expect(affectedJobs(["data/festivals/example.json"])).toEqual({
      ...everything,
      workflows: false,
    });
  });

  it("Dockerfile とイメージを確かめるスクリプトなら、docker を走らせる", () => {
    for (const file of ["Dockerfile", ".dockerignore", "scripts/smoke-mock.mjs"]) {
      expect(affectedJobs([file]), file).toEqual({ ...none, code: true, docker: true });
    }
  });

  it("ci.yml 以外のワークフローなら、型とテスト（設定の突き合わせ）と actionlint", () => {
    expect(affectedJobs([".github/workflows/deploy.yml"])).toEqual({
      ...none,
      code: true,
      workflows: true,
    });
  });

  it.each([
    "package.json",
    "apps/web/package.json",
    "pnpm-lock.yaml",
    ".node-version",
    "tsconfig.base.json",
    ".github/workflows/ci.yml",
    ".github/actions/setup/action.yml",
    "scripts/ci-changes.ts",
  ])("%s が変わったら、すべて走らせる", (file) => {
    expect(affectedJobs(["README.md", file])).toEqual(everything);
  });

  it("Windows の区切りでも同じに読む", () => {
    expect(affectedJobs(["docs\\spec\\api.md"])).toEqual(none);
  });
});

describe("出力", () => {
  it("GITHUB_OUTPUT に足せる key=value の行にする", () => {
    expect(toOutput({ ...none, e2e: true })).toBe(
      "code=false\nbuild=false\ne2e=true\ndocker=false\ndata=false\nworkflows=false",
    );
  });
});
