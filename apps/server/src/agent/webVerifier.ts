import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { VerificationResultSchema } from "@matsuri-ikoka/schema";
import { z } from "zod";
import { formatMonthDayWithWeekday } from "../domain/calendar";
import { placeLabel } from "../domain/dateWindow";
import { occurrenceOn } from "../domain/planCheck";
import type { VerificationReport } from "../domain/verification";
import type { FestivalVerifier } from "../tools/verifier";
import type { QueryFn } from "./runner";

// verify_festival の中で、Web 検索だけを使うエージェントに開催予定を確かめさせる。
// 接客エージェントと同じく開発環境から切り離し、道具は WebSearch と WebFetch だけにする。
// 報告は決まった JSON で受け取り、結果と確度は domain/verification.ts のルールで決め直す。

const ReportSchema = z.object({
  result: VerificationResultSchema,
  sources: z.array(z.object({ url: z.string(), title: z.string().optional() })).max(5),
  note: z.string().max(200).optional(),
});

const WEB_TOOLS = ["WebSearch", "WebFetch"];

export function buildVerifierOptions(input: {
  prompt: string;
  model?: string | undefined;
  cwd: string;
  env: Record<string, string>;
  abortController: AbortController;
}): Options {
  return {
    systemPrompt: input.prompt,
    ...(input.model ? { model: input.model } : {}),
    tools: WEB_TOOLS,
    allowedTools: WEB_TOOLS,
    permissionMode: "dontAsk",
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    plugins: [],
    cwd: input.cwd,
    env: input.env,
    maxTurns: 6,
    persistSession: false,
    outputFormat: { type: "json_schema", schema: z.toJSONSchema(ReportSchema) },
    abortController: input.abortController,
  };
}

export function createWebVerifier(deps: {
  prompt: string;
  model?: string | undefined;
  cwd: string;
  env: Record<string, string>;
  query: QueryFn;
}): FestivalVerifier {
  return {
    async verify({ festival, date, signal }): Promise<VerificationReport> {
      const occurrence = occurrenceOn(festival, date);
      const request = [
        `祭り：${festival.name.ja}${festival.name.en ? `（${festival.name.en}）` : ""}`,
        `開催地：${placeLabel(festival)}、会場：${festival.venue.name}`,
        `確かめる日：${formatMonthDayWithWeekday(date)}（${date}）`,
        `データの時刻：${occurrence?.start ?? "不明"}〜${occurrence?.end ?? "不明"}`,
        `データの出典：${[...festival.sources, ...(occurrence?.sources ?? [])].map((s) => s.url).join(" ")}`,
      ].join("\n");

      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      try {
        const options = buildVerifierOptions({ ...deps, abortController: controller });
        for await (const message of deps.query({ prompt: request, options })) {
          if (message.type !== "result") continue;
          if (message.subtype !== "success") break;
          const report = ReportSchema.safeParse(message.structured_output);
          if (report.success) {
            const { result, sources, note } = report.data;
            return { result, sources, ...(note ? { note } : {}) };
          }
        }
        return { result: "not_found", sources: [], note: "確認の結果を受け取れませんでした" };
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}
