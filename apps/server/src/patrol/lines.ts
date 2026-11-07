import { createHash } from "node:crypto";
import { MAX_PATROL_CHANGED_LINES, MAX_PATROL_LINE_LENGTH } from "@matsuri-ikoka/schema";

// 公開のページを行に分けて前回と比べる。モデルを呼ぶかどうかを、ここの結果だけで決める。
// 行の文章は残さず、ハッシュだけを残す（ページの文章をコピーしない）。
// ページの文字は信用しない入力なので、指示に見える行はモデルにも検問にも渡さない。

/** 1ページから取り出す行の数の上限。保存する文書の大きさを抑える */
const MAX_LINES = 2_000;

/** 中身を読まない要素 */
const SKIPPED_ELEMENTS = new Set([
  "head",
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "object",
]);
/** 閉じたら行を分ける要素 */
const BLOCK_ELEMENTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tr",
  "ul",
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#\d{1,7}|#x[\da-f]{1,6}|[a-z]{2,6});/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * HTML から本文の文字を取り出す。読むだけで何も組み立てないので、タグの判定は最小限にする。
 * 文字列を前から1度だけなめるので、ページが長くても時間は延びない
 */
function htmlToText(html: string): string {
  const lower = html.toLowerCase();
  let out = "";
  let i = 0;
  while (i < html.length) {
    const open = html.indexOf("<", i);
    if (open < 0) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, open);
    if (lower.startsWith("<!--", open)) {
      const end = lower.indexOf("-->", open + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const close = html.indexOf(">", open + 1);
    if (close < 0) break;
    const name = /^\/?([a-z][a-z0-9]*)/.exec(lower.slice(open + 1, close))?.[1] ?? "";
    i = close + 1;
    if (SKIPPED_ELEMENTS.has(name) && lower[open + 1] !== "/") {
      const end = lower.indexOf(`</${name}`, i);
      if (end < 0) break;
      const after = html.indexOf(">", end);
      i = after < 0 ? html.length : after + 1;
      continue;
    }
    if (BLOCK_ELEMENTS.has(name)) out += "\n";
    else out += " ";
  }
  return decodeEntities(out);
}

/**
 * 相対的な時刻（「3日前」「さっき」など）。ページを開くたびに変わるだけで、開催の変更ではない。
 * 区切りに挟まれたものだけを消す。「開催の3日前まで」のような決まりの数字を消すと、本当の変更を見逃すため。
 * 消し損ねても余分に調べるだけで、変更を見逃すことはない
 */
const RELATIVE_TIME =
  /(^|[\s・|:()[\]【】「」]|更新|投稿|公開)(?:(?:\d+|数|[一二三四五六七八九十]+) ?(?:秒|分|時間|日|週間|か月|ヶ月|カ月|ヵ月|ケ月|年) ?前|ついさっき|今さっき|さっき|たった今|先ほど|一昨日|おととい|昨日)(?=$|[\s・|:()[\]【】「」]|に?(?:更新|投稿|公開))/g;

/** 比べるための行にする。全角と半角と空白の違いをならし、相対的な時刻を消す。何も残らなければ空文字 */
export function normalizeLine(raw: string): string {
  const line = raw
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .replace(RELATIVE_TIME, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return /[\p{L}\p{N}]/u.test(line) ? line : "";
}

/** HTML を、比べるための行に分ける。同じ行は1つにまとめる */
export function pageLines(html: string): string[] {
  const seen = new Set<string>();
  for (const raw of htmlToText(html).split("\n")) {
    const line = normalizeLine(raw);
    if (line !== "") seen.add(line);
    if (seen.size >= MAX_LINES) break;
  }
  return [...seen];
}

export function lineHash(line: string): string {
  return createHash("sha256").update(line).digest("hex").slice(0, 16);
}

/** 指示に見える行。モデルに渡さず、根拠にも使わない */
const INSTRUCTION_LINE: readonly RegExp[] = [
  /\b(ignore|disregard|forget)\b.{0,30}\b(previous|prior|above|all|instructions?|prompts?)\b/i,
  /\bsystem\s*prompt\b/i,
  /\byou\s+(are|must|should)\b.{0,30}\b(ai|assistant|agent|model)\b/i,
  /プロンプト/,
  /(これまで|以前|上記|前)の?.{0,10}(指示|命令).{0,10}(無視|忘れ)/,
  /(指示|命令).{0,6}を無視/,
  /(\bai\b|\bllm\b|エージェント|アシスタント|見回り係|調査員|claude|chatgpt|gemini).{0,30}(指示|報告|出力|回答|従|無視)/i,
  /(と|を)(報告|出力|回答)(して|せよ|しろ|すること)/,
];

export function isInstructionLine(line: string): boolean {
  return INSTRUCTION_LINE.some((pattern) => pattern.test(line));
}

export interface LineDiff {
  /** 前回になかった行（指示に見える行を除く） */
  added: string[];
  /** 前回あって今回なくなった行の数 */
  removed: number;
  /** 指示に見えたので除いた行の数 */
  suspicious: number;
}

/** 前回の行のハッシュと比べる。並びが変わっただけの行は変更にしない */
export function diffLines(previous: readonly string[], lines: readonly string[]): LineDiff {
  const before = new Set(previous);
  const current = new Set(lines.filter((line) => !isInstructionLine(line)).map(lineHash));
  const added: string[] = [];
  let suspicious = 0;
  for (const line of lines) {
    if (before.has(lineHash(line))) continue;
    if (isInstructionLine(line)) suspicious += 1;
    else added.push(line);
  }
  let removed = 0;
  for (const hash of before) if (!current.has(hash)) removed += 1;
  return { added, removed, suspicious };
}

/** 残す行のハッシュ。指示に見える行は比べる対象にしない（同じ行で毎回モデルを呼ばないため） */
export function lineHashes(lines: readonly string[]): string[] {
  return lines.filter((line) => !isInstructionLine(line)).map(lineHash);
}

/** 開催の変更に関わりそうな行 */
const SCHEDULE_LIKE =
  /\d{1,2}月\d{1,2}日|\d{1,2}\/\d{1,2}|\d{1,2}:\d{2}|\d{1,2}時|中止|延期|順延|変更|日程|開催/;

/** 見回り係に渡す行。関わりそうな行を先にして、数と長さの上限に切りそろえる */
export function changedLinesForAgent(diff: LineDiff): string[] {
  const ordered = [
    ...diff.added.filter((line) => SCHEDULE_LIKE.test(line)),
    ...diff.added.filter((line) => !SCHEDULE_LIKE.test(line)),
  ].map((line) => line.slice(0, MAX_PATROL_LINE_LENGTH));
  if (diff.removed > 0) ordered.push(`（前回あった行が ${diff.removed} 行なくなりました）`);
  return ordered.slice(0, MAX_PATROL_CHANGED_LINES);
}

// ---------------------------------------------------------------------------
// 根拠の照合。報告の値が、コードで読んだ行に書いてあるかを確かめる

const KANJI_DIGITS: Record<string, number> = {
  〇: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 「十一月十五日」のような漢数字を、算用数字にする（神社や寺のページでよく使われる） */
function kanjiToNumber(text: string): number {
  if (text.includes("十")) {
    const [tens = "", ones = ""] = text.split("十");
    return (tens === "" ? 1 : (KANJI_DIGITS[tens] ?? 0)) * 10 + (KANJI_DIGITS[ones] ?? 0);
  }
  return [...text].reduce((total, ch) => total * 10 + (KANJI_DIGITS[ch] ?? 0), 0);
}

function withArabicDigits(line: string): string {
  return line.replace(/[〇一二三四五六七八九十]{1,3}(?=月|日|時|分)/g, (digits) =>
    String(kanjiToNumber(digits)),
  );
}

/** 行に、その日付（YYYY-MM-DD）が書いてあるか。年は補われていないことが多いので、月と日を見る */
export function mentionsDate(line: string, date: string): boolean {
  const [, month, day] = date.split("-").map(Number);
  const pattern = new RegExp(`(?<!\\d)0?${month}(?:月 ?|/|-|\\.)0?${day}(?:日|(?!\\d))`);
  return pattern.test(withArabicDigits(line));
}

/** 行に、その時刻（HH:mm）が書いてあるか */
export function mentionsTime(line: string, time: string): boolean {
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  const hours = hour > 12 ? [String(hour), `午後 ?${hour - 12}`] : [String(hour)];
  if (hour > 0 && hour <= 12) hours.push(`午前 ?${hour}`);
  if (hour < 10) hours.push(`0${hour}`);
  const minutes =
    minute === 0
      ? ["時(?!\\d)", ":00", "時0?0分"]
      : [
          `:${String(minute).padStart(2, "0")}`,
          `時${minute}分`,
          ...(minute === 30 ? ["時半"] : []),
        ];
  const pattern = new RegExp(`(?<!\\d)(?:${hours.join("|")})(?:${minutes.join("|")})`);
  return pattern.test(withArabicDigits(line));
}

/** 「雨天の場合は中止」のような、決まりの説明の文 */
const CONDITIONAL_CHANGE: readonly RegExp[] = [
  /(場合|とき|時は|際は|なら|次第)[^。]{0,12}(中止|順延|延期)/,
  /(雨天|荒天|悪天候)時?は?(中止|順延|延期)/,
  /(中止|順延|延期)[^。]{0,6}(場合|こと|可能性)/,
];

function isDecided(line: string, words: RegExp): boolean {
  return words.test(line) && !CONDITIONAL_CHANGE.some((pattern) => pattern.test(line));
}

/** 行に、中止が決まったと書いてあるか */
export function saysCancelled(line: string): boolean {
  return isDecided(line, /中止|取りやめ|取り止め|開催(いた)?しません|開催を見送/);
}

/** 行に、延期が決まったと書いてあるか */
export function saysPostponed(line: string): boolean {
  return isDecided(line, /延期|順延/);
}
