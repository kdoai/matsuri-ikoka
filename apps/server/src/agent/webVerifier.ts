import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  Options,
} from "@anthropic-ai/claude-agent-sdk";
import {
  buildJsonRetryPrompt,
  checkPublicWebUrl,
  createWebActivityLog,
  parseJsonWithSchema,
  STRICT_JSON_RULES,
  ungroundedSources,
  type WebActivityLog,
} from "@matsuri-ikoka/agent-kit";
import { VerificationResultSchema } from "@matsuri-ikoka/schema";
import { z } from "zod";
import { formatMonthDayWithWeekday } from "../domain/calendar";
import { placeLabel } from "../domain/dateWindow";
import { occurrenceOn } from "../domain/planCheck";
import type { VerificationReport } from "../domain/verification";
import type { FestivalVerifier } from "../tools/verifier";
import { deny } from "./hooks";
import type { QueryFn } from "./runner";

// verify_festival の中で、Web の検索と取得だけを許した1回きりのエージェントに開催予定を確かめさせる
// （docs/spec/agent-runtime.md の「確定前の再確認」）。
// - 接客エージェントと同じく開発環境から切り離し、道具は WebSearch と WebFetch だけにする
// - WebFetch の宛先は公開の Web だけにする（checkPublicWebUrl）
// - 検索だけして本文を読まずに答えようとしたら、1回だけ続けさせる
// - 返答の JSON は parseJsonWithSchema で取り出し、取り出せなければ道具なしで1回だけ差し戻す
// - 出典のうち、実際に読んでいないページは捨てる。結果と確度は domain/verification.ts で決め直す

const ReportSchema = z.object({
  result: VerificationResultSchema,
  sources: z.array(z.object({ url: z.string(), title: z.string().optional() })).max(5),
  note: z.string().max(200).optional(),
});

const WEB_TOOLS = ["WebSearch", "WebFetch"];
/** 検索だけで答えようとしたときに、続けさせる回数の上限 */
const MAX_READ_NUDGES = 1;

const ANSWER_FORMAT = [
  "## 返し方",
  "",
  "最後に、次の形の JSON を1つだけ返す。",
  "",
  '{"result":"as_planned か changed か cancelled か not_found","sources":[{"url":"読んだページの URL","title":"ページの題名"}],"note":"分かったことを1文で"}',
  "",
  "- sources には、WebFetch で実際に読んだページだけを入れる（検索結果に出ただけのページは入れない）",
  STRICT_JSON_RULES,
].join("\n");

export function verifierSystemPrompt(prompt: string): string {
  return `${prompt}\n\n${ANSWER_FORMAT}`;
}

export function buildVerifierOptions(input: {
  systemPrompt: string;
  model?: string | undefined;
  cwd: string;
  env: Record<string, string>;
  abortController: AbortController;
  hooks?: Options["hooks"];
  /** 差し戻しでは道具を使わせない */
  withTools: boolean;
}): Options {
  const tools = input.withTools ? WEB_TOOLS : [];
  return {
    systemPrompt: input.systemPrompt,
    ...(input.model ? { model: input.model } : {}),
    tools,
    allowedTools: tools,
    permissionMode: "dontAsk",
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    plugins: [],
    cwd: input.cwd,
    env: input.env,
    thinking: { type: "adaptive" },
    effort: "low",
    maxTurns: input.withTools ? 6 : 1,
    persistSession: false,
    abortController: input.abortController,
    ...(input.hooks ? { hooks: input.hooks } : {}),
  };
}

/** 再確認のエージェントのフック。WebFetch の宛先の確認、読んだページの控え、1回だけ続けさせる */
export function createVerifierHooks(
  log: WebActivityLog,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  let nudges = 0;
  const checkFetch: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const url = (input.tool_input as { url?: unknown } | null)?.url;
    const check = checkPublicWebUrl(url);
    return check.ok ? {} : deny(`この URL は読みません：${check.reason}`);
  };
  const record: HookCallback = async (input) => {
    if (input.hook_event_name === "PostToolUse") log.record(input.tool_name, input.tool_input);
    return {};
  };
  const requireReading: HookCallback = async (input) => {
    if (input.hook_event_name !== "Stop") return {};
    if (!log.searchedWithoutReading() || nudges >= MAX_READ_NUDGES) return {};
    nudges += 1;
    return {
      decision: "block",
      reason:
        "検索結果だけでは開催を確かめられません。公式のページを WebFetch で1つ読んでから、決めた形の JSON で答えてください。",
    };
  };
  return {
    PreToolUse: [{ matcher: "WebFetch", hooks: [checkFetch] }],
    PostToolUse: [{ matcher: "WebSearch|WebFetch", hooks: [record] }],
    Stop: [{ hooks: [requireReading] }],
  };
}

/** query を最後まで回し、成功の結果の文を返す。失敗なら null */
async function finalText(query: QueryFn, prompt: string, options: Options): Promise<string | null> {
  let text: string | null = null;
  for await (const message of query({ prompt, options })) {
    if (message.type === "result") {
      text = message.subtype === "success" && !message.is_error ? message.result : null;
    }
  }
  return text;
}

const NOT_CONFIRMED: VerificationReport = {
  result: "not_found",
  sources: [],
  note: "確認の結果を受け取れませんでした",
};

export function createWebVerifier(deps: {
  prompt: string;
  model?: string | undefined;
  cwd: string;
  env: Record<string, string>;
  query: QueryFn;
}): FestivalVerifier {
  const systemPrompt = verifierSystemPrompt(deps.prompt);
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

      // 時間の上限（20秒）は、ツールの包みが signal で知らせる。差し戻しも同じ予算の中で行う
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      if (signal.aborted) abort();
      signal.addEventListener("abort", abort, { once: true });
      const log = createWebActivityLog();
      const options = (withTools: boolean) =>
        buildVerifierOptions({
          systemPrompt,
          model: deps.model,
          cwd: deps.cwd,
          env: deps.env,
          abortController: controller,
          withTools,
          ...(withTools ? { hooks: createVerifierHooks(log) } : {}),
        });
      try {
        const answer = await finalText(deps.query, request, options(true));
        if (answer === null) return NOT_CONFIRMED;
        let parsed = parseJsonWithSchema(answer, ReportSchema, "object");
        if (!parsed.ok) {
          const failure =
            parsed.reason === "parse"
              ? { reason: "parse" as const, error: parsed.error }
              : { reason: "shape" as const, issues: parsed.issues };
          const retry = await finalText(
            deps.query,
            buildJsonRetryPrompt({ previous: answer, failure, shape: "object" }),
            options(false),
          );
          if (retry === null) return NOT_CONFIRMED;
          parsed = parseJsonWithSchema(retry, ReportSchema, "object");
          if (!parsed.ok) return NOT_CONFIRMED;
        }
        const { result, sources, note } = parsed.value;
        // 実際に読んでいないページは、出典にしない
        const unread = new Set(ungroundedSources(sources, log.fetchedUrls));
        return {
          result,
          sources: sources.filter((s) => !unread.has(s.url)),
          ...(note ? { note } : {}),
        };
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}
