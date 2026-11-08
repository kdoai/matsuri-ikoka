// PR で変わったファイルから、CI のどのジョブを走らせるかを決める（.github/workflows/ci.yml の changes ジョブ）。
// 迷うものは走らせる側に倒す：各ジョブは「関係ないと分かっているファイル」だけのときに飛ばす。
// 使い方：git diff --name-only HEAD^1 HEAD | node scripts/ci-changes.ts   （すべて走らせるときは --all）
// 出力は GITHUB_OUTPUT にそのまま足せる key=value の行。
// Node が型を外して直接動かすので、型の注釈のほかに TypeScript だけの書き方（enum など）を使わず、import も node: だけにする。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface AffectedJobs {
  /** typecheck・test：コードやテストが読むファイル */
  code: boolean;
  /** build：画面と接客サーバーの成果物に入るファイル */
  build: boolean;
  /** e2e：画面と接客サーバーの動き、または通しテストそのもの */
  e2e: boolean;
  /** docker：イメージに入るファイル、またはイメージを確かめるスクリプト */
  docker: boolean;
  /** validate-data：祭りのデータ・スキーマ・検証のスクリプト */
  data: boolean;
  /** actionlint：ワークフローと共通のアクション */
  workflows: boolean;
}

const JOBS = ["code", "build", "e2e", "docker", "data", "workflows"] as const;

const all = (value: boolean): AffectedJobs =>
  Object.fromEntries(JOBS.map((job) => [job, value])) as unknown as AffectedJobs;

const matches = (file: string, patterns: readonly RegExp[]) => patterns.some((p) => p.test(file));

/** 依存・Node・TypeScript の設定と、CI の仕組みそのもの。変わったらすべて走らせる */
const TOOLING = [
  /(^|\/)package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^\.node-version$/,
  /^tsconfig\.base\.json$/,
  /^\.github\/workflows\/ci\.yml$/,
  /^\.github\/actions\//,
  /^scripts\/ci-changes\.ts$/,
];

/**
 * 読む人のための文書。どのジョブも読まない。
 * ただし接客エージェントの指示（apps/server/src/agent/prompts/*.md）のように、ソースの下の .md はコード。
 * CLAUDE.md と .claude/ は根にあるものだけ（ほかの場所に置いていないことは test が確かめる）
 */
export function isDocument(file: string): boolean {
  if (/^(docs|\.claude)\//.test(file) || file === "LICENSE") return true;
  if (!file.endsWith(".md")) return false;
  if (/^(apps|packages)\/[^/]+\/src\//.test(file)) return false;
  if (/(^|\/)CLAUDE(\.local)?\.md$/.test(file)) return !file.includes("/");
  return true;
}

/** 画面と接客サーバーの成果物にも動きにも入らないもの（開発の道具・単体テスト・CI・イメージの定義） */
const NOT_IN_APP = [
  /\.test\.tsx?$/,
  /^scripts\//,
  /^\.github\//,
  /^Dockerfile$/,
  /^\.dockerignore$/,
  /^biome\.json$/,
  /^vitest\.config\.ts$/,
  /^apps\/[^/]+\/vitest\.config\.ts$/,
  /^firebase\.json$/,
  /^firestore\.rules$/,
  /^\.editorconfig$/,
  /^assets\/3d\/(scripts|out)\//,
];

/** 通しテストそのもの。成果物には入らない */
const E2E_ONLY = [/^apps\/web\/e2e\//, /^apps\/web\/playwright\.config\.ts$/];

/** イメージの定義と、イメージをモックで動かして確かめるスクリプト */
const DOCKER_ONLY = [
  /^Dockerfile$/,
  /^\.dockerignore$/,
  /^scripts\/check-health\.sh$/,
  /^scripts\/smoke-mock\.mjs$/,
  /^scripts\/lib\/served-files\.mjs$/,
];

const DATA = [
  /^data\//,
  /^packages\/schema\//,
  /^scripts\/(validate-festivals|festival-validation)\.ts$/,
];

const WORKFLOWS = [/^\.github\/(workflows|actions)\//];

export function affectedJobs(files: readonly string[]): AffectedJobs {
  const changed = files.map((f) => f.trim().replaceAll("\\", "/")).filter(Boolean);
  if (changed.some((f) => matches(f, TOOLING))) return all(true);

  const code = changed.filter((f) => !isDocument(f));
  const inApp = (f: string) => !matches(f, NOT_IN_APP);
  const inBuild = (f: string) => inApp(f) && !matches(f, E2E_ONLY);
  return {
    code: code.length > 0,
    build: code.some(inBuild),
    e2e: code.some((f) => inApp(f) || matches(f, E2E_ONLY)),
    docker: code.some((f) => inBuild(f) || matches(f, DOCKER_ONLY)),
    data: code.some((f) => matches(f, DATA)),
    workflows: code.some((f) => matches(f, WORKFLOWS)),
  };
}

export function toOutput(jobs: AffectedJobs): string {
  return JOBS.map((job) => `${job}=${jobs[job]}`).join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = process.argv.includes("--all") ? null : readFileSync(0, "utf8").split("\n");
  const jobs = files ? affectedJobs(files) : all(true);
  // 何を見て決めたかを、ログに残す
  console.error(
    files ? `変わったファイル：\n${files.filter(Boolean).join("\n")}` : "すべて走らせる",
  );
  console.log(toOutput(jobs));
}
