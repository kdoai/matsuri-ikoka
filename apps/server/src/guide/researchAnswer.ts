import { privateValueRefusal } from "./memo";

// 調べ役の答えを、ガイドに渡してよいかをコードで確かめる（docs/spec/agent-runtime.md の「ガイド」）。
// 調べ役はページを読むので、ページの指示に動かされた答えを返すことがある。答えはガイドのプロンプトに入るので、
// URL や連絡先、指示の文、ページの写しが入っていたら、答えごと捨てて「分からない」にする。

/** 言わせたい文を指図する形（「伝えて」「お伝えください」）。文の終わりまで見る */
const TOLD_TO =
  "(?:お伝え(?:ください|下さい)|(?:伝え|答え|回答し|書い|残し|案内し|表示し|言っ|教え)て(?:ください|下さい|ほしい|欲しい|おいて|$|[。!]))";

/**
 * AI やガイドに向けた指示の言い方。答えは現地の案内をまとめたものなので、「予約してください」
 * 「係員の指示に従ってください」「はがきを送ってください」のような、読む人への案内には当てない
 */
const INSTRUCTION_PATTERNS = [
  // 読み手の AI やガイドに向けて言っている。「AIの案内ロボットを展示」「ガイドが案内してくれます」には当てない
  new RegExp(
    `(?:あなた|貴方|ガイド|アシスタント|エージェント|(?<![a-z])ai)\\s*(?:は|が|、)[^。\\n]{0,30}${TOLD_TO}`,
    "im",
  ),
  /(?:この|あなたの?|貴方の?)\s*(?:ai|アシスタント|エージェント|チャットボット)(?![a-z])/i,
  /(?<![a-z])ai\s*(?:への|に対する|に向けた|に向けて)/i,
  // ページから読み手へ
  /(?:この|本)(?:ページ|文章|記事|指示|メッセージ)を?(?:読んだ|見た|読む|読み)/,
  /この(?:リンク|url|ページ|サイト)を?(?:開いて|読んで|送って)/i,
  /(?:次|以下)の(?:ように|とおり|通り)(?:答|伝|回答|書|言)/,
  // 言わせる内容を決めている。「宿の予約で『祭りプラン』とお伝えください」には当てない
  new RegExp(`(?:旅(?!館)|予定|開催|中止|延期|全員)[^。\\n]{0,20}と${TOLD_TO}`, "m"),
  new RegExp(`(?:利用者|ユーザー|旅行者)[^。\\n]{0,20}${TOLD_TO}`, "m"),
  // 手帳に書かせる。「メモに書いて持っていく」には当てない
  /手帳に[^。\n]{0,40}(?:書いて|残して|記して|記録して)/,
  /メモに[^。\n]{0,40}と(?:書いて|残して|記して)/,
  // 決まりを変える・代わりに動かす。「係員の指示に従って」には当てない
  /(?:この|次の|以下の|上記の|ページの|文書の)指示(?:に従|どおり|通り)/,
  /(?<!(?:係員|スタッフ|警備員|誘導員)の)指示を無視/,
  /(?:前|以前|これまで|上記)の[^。\n]{0,10}無視して/,
  /代わりに[^。\n]{0,20}(?:予約|送信|送金|支払|転送|実行|削除)して/,
  /プロンプト/,
  /system\s*prompt/i,
  /\b(?:system|assistant)\s*:/i,
  /ignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above)/i,
  /disregard\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|instructions)/i,
  /you\s+are\s+(?:now\s+)?(?:an?\s+)?(?:ai|assistant|agent|model)\b/i,
  /you\s+(?:must|should)\s+(?:tell|say|answer|respond|reply|send|open|write|save|remember|ignore|forward)\b/i,
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
