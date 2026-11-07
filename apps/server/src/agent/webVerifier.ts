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
import { bySourcePriority, verificationQueries } from "../domain/searchQueries";
import { officialHosts, type VerificationReport, yearStatedOnPage } from "../domain/verification";
import type { FestivalVerifier } from "../tools/verifier";
import { checkHostAddresses, type ResolveHost, resolveHost } from "./addressGuard";
import { deny } from "./hooks";
import type { RobotsChecker } from "./robots";
import type { QueryFn } from "./runner";

// verify_festival の中で、Web の検索と取得だけを許した1回きりのエージェントに開催予定を確かめさせる
// （docs/spec/agent-runtime.md の「確定前の再確認」）。
// - 接客エージェントと同じく開発環境から切り離し、道具は WebSearch と WebFetch だけにする
// - WebFetch の宛先は公開の Web だけにする（checkPublicWebUrl）
// - 本文を読まずに答えようとしたら（検索だけのときも、検索もしないときも）、1回だけ続けさせる
// - 返答の JSON は parseJsonWithSchema で取り出し、取り出せなければ道具なしで1回だけ差し戻す
// - 出典のうち、実際に読んでいないページは捨てる。結果と確度は domain/verification.ts で決め直す
// - 今年の開催と書かれていたかは、自己申告させない。ページの日付の文を写させ、読んだページの本文と照らして
//   コードで決める（yearStatedOnPage）

const ReportSchema = z.object({
  result: VerificationResultSchema,
  sources: z.array(z.object({ url: z.string(), title: z.string().optional() })).max(5),
  dateText: z.string().max(120).optional(),
  note: z.string().max(200).optional(),
});

const WEB_TOOLS = ["WebSearch", "WebFetch"];
/** 道具を使うときのターンの上限。検索を並べて呼び、言葉を変えて探し直せるだけの回数をとる（検索6回・ページ3回まで） */
export const VERIFIER_MAX_TURNS = 10;
/** 検索だけで答えようとしたときに、続けさせる回数の上限 */
const MAX_READ_NUDGES = 1;

const ANSWER_FORMAT = [
  "## 返し方",
  "",
  "最後に、次の形の JSON を1つだけ返す。",
  "",
  '{"result":"as_planned か changed か cancelled か not_found","sources":[{"url":"読んだページの URL","title":"ページの題名"}],"dateText":"ページに書かれている開催日の文（年も含めてそのまま）","note":"分かったことを1文で"}',
  "",
  "- sources には、WebFetch で実際に読んだページだけを入れる（検索結果に出ただけのページは入れない）",
  "- dateText には、読んだ公式のページに書かれている開催日の文を、書き換えず、年を補わずにそのまま写す（例：「2026年8月16日（日）」「毎年8月16日」）。日付が見つからなければ入れない",
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
  /** 1回の呼び出しの費用の上限（米ドル） */
  maxBudgetUsd?: number | undefined;
  /** 道具を使うときのターンの上限。省略すると VERIFIER_MAX_TURNS（寄り道の調べは多めに渡す） */
  maxTurns?: number;
  /** 考える深さ。省略すると low（決まった形の確かめを速く済ませる） */
  effort?: Options["effort"];
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
    effort: input.effort ?? "low",
    maxTurns: input.withTools ? (input.maxTurns ?? VERIFIER_MAX_TURNS) : 1,
    persistSession: false,
    ...(input.maxBudgetUsd ? { maxBudgetUsd: input.maxBudgetUsd } : {}),
    abortController: input.abortController,
    ...(input.hooks ? { hooks: input.hooks } : {}),
  };
}

/** 読んだページ（WebFetch の宛先と、エージェントが受け取った本文） */
export interface FetchedPage {
  url: string;
  text: string;
}

/** WebFetch の結果から、エージェントが受け取った本文を取り出す（SDK の WebFetchOutput は result に入る） */
function fetchedText(response: unknown): string {
  if (typeof response === "string") return response;
  if (response !== null && typeof response === "object") {
    const result = (response as { result?: unknown }).result;
    if (typeof result === "string") return result;
  }
  return "";
}

const READ_NUDGE =
  "まだページを読んでいないので、開催を確かめられません。公式のページを検索して WebFetch で1つ読んでから、決めた形の JSON で答えてください。";

/** 再確認のエージェントのフック。WebFetch の宛先の確認、読んだページの控え、1回だけ続けさせる */
/**
 * 読みに行かないサイト。利用規約が営利目的の利用や情報の複製を禁じているグルメの案内サイトと、
 * 確かめられないサイトを、安全のために並べる（docs/adr/0010-place-data-sources.md）
 */
const RESTRICTED_SITES = ["tabelog.com", "retty.me", "hotpepper.jp", "gnavi.co.jp"] as const;

export function isRestrictedSite(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return RESTRICTED_SITES.some((site) => host === site || host.endsWith(`.${site}`));
}

export function createVerifierHooks(
  log: WebActivityLog,
  resolve: ResolveHost = resolveHost,
  /** 読んだページの本文を控える先 */
  pages: FetchedPage[] = [],
  /** 検索だけで答えようとしたときに返す文 */
  nudge: string = READ_NUDGE,
  /** サイトの robots.txt を確かめる。省略すると確かめない */
  robots?: RobotsChecker,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  let nudges = 0;
  const checkFetch: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const url = (input.tool_input as { url?: unknown } | null)?.url;
    const check = checkPublicWebUrl(url);
    if (!check.ok) return deny(`この URL は読みません：${check.reason}`);
    if (isRestrictedSite(check.url.hostname)) {
      return deny("このサイトは利用規約の都合で読みません。店や施設の公式のページを探してください");
    }
    // 名前の文字列だけでなく、解決した先のアドレスも外の Web かを確かめる
    const addresses = await checkHostAddresses(check.url.hostname, resolve);
    if (!addresses.ok) return deny(`この URL は読みません：${addresses.reason}`);
    if (robots !== undefined && !(await robots.allowed(check.url))) {
      return deny(
        "このページはサイトの robots.txt で断られているので読みません。ほかのページを探してください",
      );
    }
    return {};
  };
  const record: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUse") return {};
    log.record(input.tool_name, input.tool_input);
    const url = (input.tool_input as { url?: unknown } | null)?.url;
    if (input.tool_name === "WebFetch" && typeof url === "string") {
      pages.push({ url, text: fetchedText(input.tool_response) });
    }
    return {};
  };
  const requireReading: HookCallback = async (input) => {
    if (input.hook_event_name !== "Stop") return {};
    // 検索しただけのときも、検索もしないで答えようとしたときも、ページを読んでから答えさせる
    if (log.fetchedUrls.length > 0 || nudges >= MAX_READ_NUDGES) return {};
    nudges += 1;
    return { decision: "block", reason: nudge };
  };
  return {
    PreToolUse: [{ matcher: "WebFetch", hooks: [checkFetch] }],
    PostToolUse: [{ matcher: "WebSearch|WebFetch", hooks: [record] }],
    Stop: [{ hooks: [requireReading] }],
  };
}

/**
 * query を最後まで回し、成功の結果の文（失敗なら null）と費用（SDK の推定）を返す。
 * onMessage は Agent SDK の知らせが届くたびに呼ぶ（呼ぶ側の進みのない時間を数え直す）
 */
export async function finalText(
  query: QueryFn,
  prompt: string,
  options: Options,
  onMessage?: () => void,
): Promise<{ text: string | null; costUsd: number }> {
  let text: string | null = null;
  let costUsd = 0;
  for await (const message of query({ prompt, options })) {
    onMessage?.();
    if (message.type === "result") {
      text = message.subtype === "success" && !message.is_error ? message.result : null;
      costUsd = message.total_cost_usd ?? 0;
    }
  }
  return { text, costUsd };
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
  /** WebFetch の宛先の名前を解決する関数（テストで差し替える） */
  resolveHost?: ResolveHost;
  /** 1回の呼び出しの費用の上限（米ドル） */
  maxBudgetUsd?: number | undefined;
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
        // データの出典は、情報源の優先順位（主催者・自治体 → 観光協会 → 広報誌の PDF → …）の順に渡す
        `データの出典（この順に確かめる）：${[
          ...new Set(
            bySourcePriority(
              [...(occurrence?.sources ?? []), ...festival.sources],
              officialHosts(festival),
            ).map((s) => s.url),
          ),
        ].join(" ")}`,
        `検索の言葉（上から優先。いくつかを並べて検索してよい）：${verificationQueries(festival, date).join(" / ")}`,
      ].join("\n");

      // 時間の上限は、ツールの包みが signal で知らせる（確定前の再確認は45秒、候補の確かめは1件30秒）。差し戻しも同じ予算の中で行う
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      if (signal.aborted) abort();
      signal.addEventListener("abort", abort, { once: true });
      const log = createWebActivityLog();
      const pages: FetchedPage[] = [];
      const options = (withTools: boolean) =>
        buildVerifierOptions({
          systemPrompt,
          model: deps.model,
          cwd: deps.cwd,
          env: deps.env,
          abortController: controller,
          maxBudgetUsd: deps.maxBudgetUsd,
          withTools,
          ...(withTools ? { hooks: createVerifierHooks(log, deps.resolveHost, pages) } : {}),
        });
      const started = Date.now();
      let costUsd = 0;
      let outcome: VerificationReport["result"] = "not_found";
      const ask = async (prompt: string, withTools: boolean) => {
        const reply = await finalText(deps.query, prompt, options(withTools));
        costUsd += reply.costUsd;
        return reply.text;
      };
      try {
        const answer = await ask(request, true);
        if (answer === null) return NOT_CONFIRMED;
        let parsed = parseJsonWithSchema(answer, ReportSchema, "object");
        if (!parsed.ok) {
          const failure =
            parsed.reason === "parse"
              ? { reason: "parse" as const, error: parsed.error }
              : { reason: "shape" as const, issues: parsed.issues };
          const retry = await ask(
            buildJsonRetryPrompt({ previous: answer, failure, shape: "object" }),
            false,
          );
          if (retry === null) return NOT_CONFIRMED;
          parsed = parseJsonWithSchema(retry, ReportSchema, "object");
          if (!parsed.ok) return NOT_CONFIRMED;
        }
        const { result, sources, dateText, note } = parsed.value;
        outcome = result;
        // 実際に読んでいないページは、出典にしない
        const unread = new Set(ungroundedSources(sources, log.fetchedUrls));
        const read = sources.filter((s) => !unread.has(s.url));
        // 写した日付の文は、出典に残したページの本文の中にあるときだけ使う
        const sourcePages = pages.filter(
          (page) =>
            ungroundedSources(
              [{ url: page.url }],
              read.map((s) => s.url),
            ).length === 0,
        );
        return {
          result,
          sources: read,
          yearStated: yearStatedOnPage({
            dateText,
            pages: sourcePages.map((page) => page.text),
            date,
          }),
          ...(note ? { note } : {}),
        };
      } finally {
        signal.removeEventListener("abort", abort);
        // 再確認の費用・所要時間・調べた数を残す（調べた語や URL は残さない）
        console.info(
          JSON.stringify({
            kind: "verify",
            reported: outcome,
            totalCostUsd: costUsd,
            elapsedMs: Date.now() - started,
            searches: log.searches.length,
            fetched: log.fetchedUrls.length,
          }),
        );
      }
    },
  };
}
