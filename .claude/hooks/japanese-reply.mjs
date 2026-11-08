// 回答を日本語に保つ Claude Code のフック（UserPromptSubmit と Stop）。
//
// このリポジトリの文書・コミット・PR・Issue は日本語で書くので、会話もそろえる。
// - UserPromptSubmit：発言のたびに「日本語で答える」ことを文脈に足す
// - Stop：そのターンの回答に英語の文が混ざっていたら止めて、日本語で書き直させる
//   コード・コマンド・URL・パスは英語でよいので、数える前に外す
//   書き直しのあとにもう一度止めると終わらなくなるので、2回目（stop_hook_active）は通す
//
// 設定は .claude/settings.json。テストは scripts/claude-hooks.test.ts。
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const REPLY_IN_JAPANESE =
  "回答・途中の説明・まとめは、すべて日本語で書く。コード・コマンド・識別子・固有名詞だけは原文のままでよい。";

/** ひらがな・カタカナ・漢字・半角カナ */
const JA = /[぀-ヿ㐀-鿿ｦ-ﾟ]/g;
/** 英単語が6語以上続く並び（文になっている英語） */
const EN_RUN = /[A-Za-z][A-Za-z'’-]*(?:[ ,;:]+[A-Za-z][A-Za-z'’-]*){5,}/;

/** コードの塊・インラインのコード・URL・リンクの先・パスを外す */
export function stripNonProse(text) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(?:[A-Za-z]:)?[\w.-]*[\\/][\w./\\-]+/g, " ");
}

/** 日本語を含まない英語の文の行と、日本語の文字数 */
export function englishLines(text) {
  const prose = stripNonProse(text);
  const jaCount = (prose.match(JA) ?? []).length;
  const lines = prose
    .split("\n")
    .filter((line) => (line.match(JA) ?? []).length === 0 && EN_RUN.test(line));
  return { lines, jaCount };
}

/** 書き直させるほど英語が多いか。英語の文が2行以上か、日本語がほとんどなく英語の文がある */
export function isTooEnglish(text) {
  const { lines, jaCount } = englishLines(text);
  return lines.length >= 2 || (lines.length >= 1 && jaCount < 20);
}

/** 会話の記録（JSONL）の、最後の人の発言より後にあるアシスタントの文章 */
export function textOfLastTurn(transcript) {
  const lines = transcript.split("\n").filter(Boolean);
  const texts = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const content = entry.message?.content;
    if (entry.type === "user") {
      const isPrompt =
        typeof content === "string" ||
        (Array.isArray(content) && content.some((c) => c.type === "text"));
      if (isPrompt && !entry.isMeta) break;
      continue;
    }
    if (entry.type === "assistant" && Array.isArray(content)) {
      for (const c of content) if (c.type === "text") texts.unshift(c.text);
    }
  }
  return texts.join("\n");
}

function readJson(source) {
  try {
    return JSON.parse(readFileSync(source, "utf8"));
  } catch {
    return {};
  }
}

function main() {
  const input = readJson(0);
  if (input.hook_event_name === "UserPromptSubmit") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: REPLY_IN_JAPANESE,
        },
      }),
    );
    return;
  }
  if (input.hook_event_name !== "Stop") return;
  if (input.stop_hook_active || typeof input.transcript_path !== "string") return;
  let transcript;
  try {
    transcript = readFileSync(input.transcript_path, "utf8");
  } catch {
    return;
  }
  const text = textOfLastTurn(transcript);
  if (!isTooEnglish(text)) return;
  const sample = englishLines(text).lines[0].trim().slice(0, 80);
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: `回答に英語の文が混ざっています（例：「${sample}」）。この回答の内容を、日本語で書き直して伝え直してください。以降も日本語で答えてください。コード・コマンド・識別子は原文のままでかまいません。`,
    }),
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
