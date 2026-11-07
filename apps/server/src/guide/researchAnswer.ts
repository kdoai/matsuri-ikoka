import { privateValueRefusal } from "./memo";

// 調べ役の答えを、ガイドに渡してよいかをコードで確かめる（docs/spec/agent-runtime.md の「ガイド」）。
// 調べ役はページを読むので、ページの指示に動かされた答えを返すことがある。答えはガイドのプロンプトに入るので、
// URL や連絡先、指示の文、ページの写しが入っていたら、答えごと捨てて「分からない」にする。

/** 指示や依頼の言い方。事実を答える文には出てこないものだけを並べる */
const INSTRUCTION_PATTERNS = [
  /(?<![a-z])ai\s*(?:は|が|に|へ|を|の)/i,
  /(?:この|本)(?:ページ|文章|記事|指示)を?(?:読んだ|見た|読む)/,
  /(?:次|以下)の(?:ように|とおり|通り)(?:答|伝|回答|書|言)/,
  /指示(?:に従|を無視|どおり|通り)/,
  /無視して/,
  /(?:手帳|メモ)に[^。]{0,40}(?:書|残|記)/,
  /(?:予約|送信|送金|支払|転送|実行|削除)して/,
  /(?:伝えて|答えて|回答して|送って|開いて|読んで)(?:ください|下さい)/,
  /ignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above)/i,
  /disregard|system\s*prompt|システムプロンプト|プロンプト/i,
  /you\s+(?:are|must|should)\b/i,
];

/** 読んだページの本文と、これだけ続けて同じなら、ページの写しとみなす */
const MAX_COPIED_CHARS = 40;

export type ResearchAnswerRefusal = "private_value" | "instruction" | "copied";

function joined(text: string): string {
  return text.normalize("NFKC").replaceAll(/\s+/g, "");
}

/** 答えが読んだページの本文と長く同じか */
function copiedFromPage(answer: string, pages: readonly string[]): boolean {
  const text = joined(answer);
  if (text.length < MAX_COPIED_CHARS) return false;
  const bodies = pages.map(joined);
  for (let start = 0; start + MAX_COPIED_CHARS <= text.length; start += 1) {
    const piece = text.slice(start, start + MAX_COPIED_CHARS);
    if (bodies.some((body) => body.includes(piece))) return true;
  }
  return false;
}

/** 答えをガイドに渡してはいけない理由。渡してよければ null。pages は読んだページの本文 */
export function researchAnswerRefusal(
  answer: string,
  pages: readonly string[] = [],
): ResearchAnswerRefusal | null {
  if (privateValueRefusal(answer) !== null) return "private_value";
  const text = answer.normalize("NFKC");
  if (INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text))) return "instruction";
  return copiedFromPage(answer, pages) ? "copied" : null;
}
