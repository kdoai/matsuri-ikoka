import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// エージェントの指示は prompts/ に Markdown で置き、Git で版を管理する。
// ビルドでは dist/prompts/ にコピーする（build.ts）。

/** common は3人のスタッフに共通の前置き。一字一句同じ文字列にして、プロンプトキャッシュに乗せる */
export const PROMPT_NAMES = [
  "concierge",
  "common",
  "researcher",
  "scout",
  "planner",
  "verifier",
  "route",
  "nearby",
  "lodging",
  "evaluator",
  "wish-reader",
] as const;
export type PromptName = (typeof PROMPT_NAMES)[number];
export type AgentPrompts = Record<PromptName, string>;

export function defaultPromptDir(): string {
  return fileURLToPath(new URL("./prompts/", import.meta.url));
}

export async function loadPrompts(dir: string = defaultPromptDir()): Promise<AgentPrompts> {
  const entries = await Promise.all(
    PROMPT_NAMES.map(async (name) => {
      const text = (await readFile(`${dir}/${name}.md`, "utf8")).trim();
      if (text === "") throw new Error(`指示が空です：${name}.md`);
      return [name, text] as const;
    }),
  );
  return Object.fromEntries(entries) as AgentPrompts;
}
