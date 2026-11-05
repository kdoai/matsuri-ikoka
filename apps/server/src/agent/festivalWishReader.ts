import {
  buildJsonRetryPrompt,
  classifyFailure,
  classifyResultSubtype,
  parseJsonWithSchema,
  STRICT_JSON_RULES,
} from "@matsuri-ikoka/agent-kit";
import { type FestivalWishIntent, FestivalWishIntentSchema } from "@matsuri-ikoka/schema";
import { wishVocabulary } from "../domain/festivalSearchWish";
import type { FestivalWishReader } from "../routes/festivalSearch";
import { sanitizeMessage } from "./briefing";
import type { QueryFn } from "./runner";
import { buildVerifierOptions } from "./webVerifier";

// 祭りから探すときの自由記述を、道具を持たない1回きりのエージェントに読ませる
// （docs/spec/agent-runtime.md の「自由記述の読み取り」）。動かし方（開発環境から切り離す・JSON の差し戻し）は
// 旅程の評価係と同じ。読んだ結果は並び順にだけ効かせ、必ず守る条件と祭りの有無はコードで決める。
// 読めなければ null を返すか例外を投げ、呼ぶ側が言葉の辞書に戻す。時間の上限は呼ぶ側が signal で知らせる。

const OPEN_WISH = "<自由記述>";
const CLOSE_WISH = "</自由記述>";

function answerFormat(): string {
  const { concepts, categories } = wishVocabulary();
  return [
    "## 決まった呼び方",
    "",
    concepts.join("、"),
    "",
    "## 種類（categories に入れる値）",
    "",
    ...categories.map(([category, words]) => `- ${category}：${words.join("、")}`),
    "",
    "## 返し方",
    "",
    "次の形の JSON を1つだけ返す。",
    "",
    '{"summary":"受け取った内容の短い文","categories":[],"terms":[],"avoidTerms":[],"months":[],"prefectures":[],"wantsToJoin":false}',
    "",
    "- summary は40字まで。希望を読めなければ「希望を読み取れず、条件だけで探しました」",
    "- terms は16個まで、avoidTerms は8個まで。1つの言葉は20字まで",
    "- months は1から12の整数",
    STRICT_JSON_RULES,
  ].join("\n");
}

/** 自由記述をプロンプトに入れる形にする。山かっこを無効にし、区切りのタグを作らせない */
export function wishPrompt(wish: string): string {
  return [OPEN_WISH, sanitizeMessage(wish), CLOSE_WISH].join("\n");
}

export function createFestivalWishReader(deps: {
  prompt: string;
  model?: string | undefined;
  cwd: string;
  env: Record<string, string>;
  query: QueryFn;
  maxBudgetUsd?: number | undefined;
}): FestivalWishReader {
  const systemPrompt = `${deps.prompt}\n\n${answerFormat()}`;
  return async (wish, signal): Promise<FestivalWishIntent | null> => {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    const options = buildVerifierOptions({
      systemPrompt,
      model: deps.model,
      cwd: deps.cwd,
      env: deps.env,
      abortController: controller,
      maxBudgetUsd: deps.maxBudgetUsd,
      withTools: false,
    });
    const started = Date.now();
    let costUsd = 0;
    let failure: string | null = null;
    const ask = async (prompt: string): Promise<string | null> => {
      let text: string | null = null;
      for await (const message of deps.query({ prompt, options })) {
        if (message.type !== "result") continue;
        costUsd += message.total_cost_usd ?? 0;
        if (message.subtype === "success" && !message.is_error) {
          text = message.result;
        } else {
          failure = classifyResultSubtype(message.subtype)?.kind ?? message.subtype;
        }
      }
      return text;
    };
    try {
      const answer = await ask(wishPrompt(wish));
      if (answer === null) return null;
      let parsed = parseJsonWithSchema(answer, FestivalWishIntentSchema, "object");
      if (!parsed.ok) {
        const retry = await ask(
          buildJsonRetryPrompt({
            previous: answer,
            failure:
              parsed.reason === "parse"
                ? { reason: "parse", error: parsed.error }
                : { reason: "shape", issues: parsed.issues },
            shape: "object",
          }),
        );
        if (retry === null) return null;
        parsed = parseJsonWithSchema(retry, FestivalWishIntentSchema, "object");
        if (!parsed.ok) {
          failure = `json_${parsed.reason}`;
          return null;
        }
      }
      return parsed.value;
    } catch (error) {
      failure = classifyFailure(error).kind;
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      // 費用・所要時間・成否だけを残す（自由記述の中身は残さない）
      console.info(
        JSON.stringify({
          kind: "festival_wish_reader",
          failure,
          totalCostUsd: costUsd,
          elapsedMs: Date.now() - started,
        }),
      );
    }
  };
}
