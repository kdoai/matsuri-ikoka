import { createHash } from "node:crypto";
import { MAX_PATROL_CHANGED_LINES, MAX_PATROL_LINE_LENGTH } from "@matsuri-ikoka/schema";

// 公開のページを行に分けて前回と比べる。モデルを呼ぶかどうかを、ここの結果で決める。
// 行の文章は残さず、ハッシュだけを残す（ページの文章をコピーしない）。
// ページの文字は信用しない入力なので、指示に見える行はモデルにも検問の根拠にも渡さない。
// 指示の見分けは文字の形によるもので、言い換えをすべて見分けることはできない。
// そのため検問は、値がコードで読んだ新しい行に書いてあるときだけ認め、通知にページの文章を入れない。

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
/** 開いても閉じても行を分ける要素 */
const BLOCK_ELEMENTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dl",
  "div",
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
 * 文字列を前から1度だけなめるので、ページが長くても時間は延びない。
 * dt と dd は1つの行にする。別の行にすると、値を入れ替えても同じ行の集まりになり、変化に気づけない
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
    const closing = lower[open + 1] === "/";
    const name = /^\/?([a-z][a-z0-9]*)/.exec(lower.slice(open + 1, close))?.[1] ?? "";
    i = close + 1;
    if (SKIPPED_ELEMENTS.has(name) && !closing) {
      const end = lower.indexOf(`</${name}`, i);
      if (end < 0) break;
      const after = html.indexOf(">", end);
      i = after < 0 ? html.length : after + 1;
      continue;
    }
    if (BLOCK_ELEMENTS.has(name) || (name === "dd" && closing)) out += "\n";
    else out += " ";
  }
  return decodeEntities(out);
}

/** 見えない文字。語の間に挟むと、指示の見分けをすり抜けられる */
const INVISIBLE_CHARS = /​|‌|‍|⁠|﻿|­/g;

function withoutInvisible(text: string): string {
  return text.replace(INVISIBLE_CHARS, "");
}

const RELATIVE_TIME =
  "(?:(?:\\d+|数|[一二三四五六七八九十]+) ?(?:秒|分|時間|日|週間|か月|ヶ月|カ月|ヵ月|ケ月|年) ?前|ついさっき|今さっき|さっき|たった今|先ほど|一昨日|おととい|昨日)";
const RELATIVE_LABEL = "(?:更新|投稿|公開)(?:日時?)?";
/** 行全体が相対的な時刻だけ（「3日前」「3日前に更新」） */
const WHOLE_RELATIVE = new RegExp(
  `^${RELATIVE_TIME}(?: ?に?(${RELATIVE_LABEL})(?:しました|されました)?)?$`,
);
/** 更新・投稿・公開のラベルが付いた相対的な時刻（「更新：3日前」「お知らせ 3日前に更新」） */
const LABEL_THEN_RELATIVE = new RegExp(
  `(${RELATIVE_LABEL})(?: ?: ?| )?${RELATIVE_TIME}(?=$|[\\s・|)\\]】」])`,
  "g",
);
const RELATIVE_THEN_LABEL = new RegExp(`${RELATIVE_TIME} ?に?(${RELATIVE_LABEL})`, "g");

/**
 * 比べるための行にする。全角と半角と空白の違いをならし、ページを開くたびに変わるだけの相対的な時刻を消す。
 * 消すのは、行全体がそれだけのときと、更新・投稿・公開のラベルが付くときだけにする。
 * 「入場締切:1時間前」「開催の3日前まで」のような決まりの数字を消すと、本当の変更を見逃すため。
 * 消し損ねても余分に調べるだけで、変更を見逃すことはない。何も残らなければ空文字
 */
export function normalizeLine(raw: string): string {
  const line = withoutInvisible(raw.normalize("NFKC")).replace(/\s+/g, " ").trim();
  const whole = WHOLE_RELATIVE.exec(line);
  const cleaned = whole
    ? (whole[1] ?? "")
    : line.replace(LABEL_THEN_RELATIVE, "$1").replace(RELATIVE_THEN_LABEL, "$1").trim();
  return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : "";
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
  /\b(assistant|agent|ai|model|llm)\b.{0,40}\b(must|should|report|say|output|respond|answer)\b/i,
  /\breport\b.{0,30}\b(cancelled|canceled|postponed)\b/i,
  /プロンプト/,
  /(これまで|以前|上記|前)の?.{0,10}(指示|命令|ルール).{0,10}(無視|忘れ|従わ|聞か)/,
  /(指示|命令).{0,6}(を無視|を取り消|を上書き)/,
  /(\bai\b|\bllm\b|エージェント|アシスタント|見回り係|調査員|claude|chatgpt|gemini).{0,30}(指示|報告|出力|回答|従|無視)/i,
  /(この|本)(ページ|サイト|文章|文書)を(読|処理|要約|確認).{0,20}(方|者|人|システム|プログラム|ツール|ボット|bot|ai|エージェント)/i,
  /(と|として)(報告|出力|回答|記載|記録|伝え|答え|書|扱|みな)[っいうえきくけしす].{0,8}(ください|下さい|こと|なさい|せよ|しろ)/,
  /(と|を)(報告|出力|回答)(して|せよ|しろ|すること)/,
];

export function isInstructionLine(line: string): boolean {
  const text = withoutInvisible(line);
  return INSTRUCTION_LINE.some((pattern) => pattern.test(text));
}

/** 開催の変更に関わりそうな行 */
const SCHEDULE_LIKE =
  /\d{1,2}月\d{1,2}日|\d{1,2}\/\d{1,2}|\d{1,2}:\d{2}|\d{1,2}時|中止|延期|順延|変更|日程|開催/;

export interface LineDiff {
  /** 前回になかった行（指示に見える行を除く） */
  added: string[];
  /** 前回あって今回なくなった行の数 */
  removed: number;
  /** 指示に見えたので除いた新しい行の数 */
  suspicious: number;
  /** そのうち、日程や中止の言葉がある行の数。黙って捨てず、ページを見回り係に任せる */
  suspiciousSchedule: number;
}

/** 前回の行のハッシュと比べる。並びが変わっただけの行は変更にしない */
export function diffLines(previous: readonly string[], lines: readonly string[]): LineDiff {
  const before = new Set(previous);
  const current = new Set(lines.map(lineHash));
  const added: string[] = [];
  let suspicious = 0;
  let suspiciousSchedule = 0;
  for (const line of lines) {
    if (before.has(lineHash(line))) continue;
    if (isInstructionLine(line)) {
      suspicious += 1;
      if (SCHEDULE_LIKE.test(line)) suspiciousSchedule += 1;
    } else {
      added.push(line);
    }
  }
  let removed = 0;
  for (const hash of before) if (!current.has(hash)) removed += 1;
  return { added, removed, suspicious, suspiciousSchedule };
}

/** 見回り係を呼ぶ変化か。指示に見える行だけで、日程の言葉もなければ呼ばない */
export function needsAgent(diff: LineDiff): boolean {
  return diff.added.length > 0 || diff.removed > 0 || diff.suspiciousSchedule > 0;
}

/** 残す行のハッシュ。指示に見える行も含める（同じ行で毎回モデルを呼ばないため） */
export function lineHashes(lines: readonly string[]): string[] {
  return lines.map(lineHash);
}

/** 見回り係に渡す行。関わりそうな行を先にして、数と長さの上限に切りそろえる */
export function changedLinesForAgent(diff: LineDiff): string[] {
  const ordered = [
    ...diff.added.filter((line) => SCHEDULE_LIKE.test(line)),
    ...diff.added.filter((line) => !SCHEDULE_LIKE.test(line)),
  ].map((line) => line.slice(0, MAX_PATROL_LINE_LENGTH));
  const marks: string[] = [];
  if (diff.suspiciousSchedule > 0) {
    marks.push("（指示に見える行があったので渡していません。ページを開いて確かめてください）");
  }
  if (diff.removed > 0) marks.push(`（前回あった行が ${diff.removed} 行なくなりました）`);
  return [...marks, ...ordered].slice(0, MAX_PATROL_CHANGED_LINES);
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
  return line.replace(/[〇一二三四五六七八九十]{1,4}(?=\s*(?:年|月|日|時|分))/g, (digits) =>
    String(kanjiToNumber(digits)),
  );
}

interface MonthDay {
  /** 分からなければ null（「22日に変更」） */
  month: number | null;
  day: number;
  /** 分かれば年 */
  year: number | null;
}

const validDay = (month: number | null, day: number) =>
  day >= 1 && day <= 31 && (month === null || (month >= 1 && month <= 12));

/** 行に書いてある日付を読む。月の省略は、同じ行の前の日付の月を引き継ぐ */
function datesIn(line: string): MonthDay[] {
  const text = withArabicDigits(line);
  const dates: MonthDay[] = [];
  const add = (year: number | null, month: number | null, day: number) => {
    if (validDay(month, day)) dates.push({ year, month, day });
  };
  // 2026-11-15・2026.11.15・2026/11/15。「5-6人」「3.1km」は年がないので日付にしない
  for (const match of text.matchAll(
    /(?<!\d)(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})(?!\d)/g,
  )) {
    add(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  // 11/15。「1/2人」のような数は日付にしない
  for (const match of text.matchAll(
    /(?<![\d/.-])(\d{1,2})\/(\d{1,2})(?![\d/]|\s*(?:%|km|kg|m\b|人|名|円|個|本|杯))/g,
  )) {
    add(null, Number(match[1]), Number(match[2]));
  }
  // 11月21〜22日
  for (const match of text.matchAll(/(\d{1,2})\s*月\s*(\d{1,2})\s*[~〜・,、-]\s*(\d{1,2})\s*日/g)) {
    add(null, Number(match[1]), Number(match[2]));
    add(null, Number(match[1]), Number(match[3]));
  }
  // 11月21日・22日、11月21日(土)〜22日(日)、22日(日)に変更
  let month: number | null = null;
  for (const match of text.matchAll(
    /(?<!\d)(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*日(?!\s*(?:間|以内|前|後|程度|ほど))/g,
  )) {
    if (match[1] !== undefined) month = Number(match[1]);
    add(null, month, Number(match[2]));
  }
  return dates;
}

/** 月のない「22日」を、その日付として読んでよい行（変更を述べている行だけ） */
const CHANGE_WORD = /変更|延期|順延|振替|振り替え|に変/;

/** 行に、その日付（YYYY-MM-DD）が書いてあるか。年は補われていないことが多いので、月と日を見る */
export function mentionsDate(line: string, date: string): boolean {
  const [year, month, day] = date.split("-").map(Number);
  return datesIn(line).some(
    (found) =>
      found.day === day &&
      (found.year === null || found.year === year) &&
      (found.month === month || (found.month === null && CHANGE_WORD.test(line))),
  );
}

const PM_WORDS = new Set(["午後", "夕方", "夕", "夜", "晩"]);

/** 行に書いてある時刻を HH:mm で読む。「午後6時〜9時」の 9時 は 21:00 としても読む */
function timesIn(line: string): string[] {
  const text = withArabicDigits(line);
  const times = new Set<string>();
  const add = (hour: number, minute: number) => {
    if (hour >= 0 && hour <= 24 && minute >= 0 && minute < 60) {
      times.add(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
    }
  };
  if (/正午/.test(text)) add(12, 0);
  let afternoon = false;
  for (const match of text.matchAll(
    /(午前|午後|朝|昼|夕方|夕|夜|晩|深夜|未明)?\s*(?<![\d:])(\d{1,2})\s*(?:時(?!間)\s*(?:(\d{1,2})\s*分|(半))?|:(\d{2})(?!\d))/g,
  )) {
    const word = match[1];
    const raw = Number(match[2]);
    const minute = match[4] === "半" ? 30 : Number(match[3] ?? match[5] ?? 0);
    if (word !== undefined) afternoon = PM_WORDS.has(word);
    if (word === undefined) {
      add(raw, minute);
      if (afternoon && raw < 12) add(raw + 12, minute);
    } else if (PM_WORDS.has(word)) {
      add(raw < 12 ? raw + 12 : raw, minute);
    } else if (word === "昼") {
      add(raw <= 6 ? raw + 12 : raw, minute);
    } else {
      add(raw, minute);
    }
  }
  return [...times];
}

/** 行に、その時刻（HH:mm）が書いてあるか */
export function mentionsTime(line: string, time: string): boolean {
  return timesIn(line).includes(time);
}

/** 祭りの本体でない、別の催しや案内の行。日付や時刻があっても、開催の根拠にしない */
const OTHER_EVENT =
  /説明会|募集|締切|締め切り|申込|申し込み|受付|会議|講習|体験|ワークショップ|展示|物販|前夜祭|後夜祭|前日祭|後日祭|バス|列車|電車|シャトル|駐車場|終電|最終便|営業/;
/** 開催の日程を述べている行 */
const SCHEDULE_CONTEXT =
  /開催|日程|変更|延期|順延|振替|振り替え|実施|本祭|当日|祭|まつり|開始|開演|行います|行われ|おこな/;

/** 日付と時刻と記号のほかに何もない行（見出しのあとの「11月22日(日)」） */
function isBareDate(line: string): boolean {
  const rest = withArabicDigits(line)
    .replace(/\d{4}\s*年/g, "")
    .replace(/令和\s*(?:\d{1,2}|元)\s*年/g, "")
    .replace(/\d{1,2}\s*月/g, "")
    .replace(/\d{1,2}\s*日/g, "")
    .replace(/\d{1,2}\s*[:/]\s*\d{1,2}/g, "")
    .replace(/\d{1,2}\s*時(\s*\d{1,2}\s*分)?/g, "")
    .replace(/\([^)]{1,4}\)/g, "")
    .replace(/[\s~〜・,、.\-:]/g, "");
  return rest === "";
}

export function isOtherEvent(line: string): boolean {
  return OTHER_EVENT.test(line);
}

/** 行が、祭りの開催日としてその日付を述べているか */
export function announcesDate(line: string, date: string): boolean {
  if (!mentionsDate(line, date) || isOtherEvent(line)) return false;
  return SCHEDULE_CONTEXT.test(line) || isBareDate(line);
}

/** 行が、祭りの時刻としてその時刻を述べているか */
export function announcesTime(line: string, time: string): boolean {
  return mentionsTime(line, time) && !isOtherEvent(line);
}

/** 行の年が、開催回の年と違うか（「2019年の巡行は中止でした」） */
export function mentionsOtherYear(line: string, date: string): boolean {
  const target = Number(date.slice(0, 4));
  const text = withArabicDigits(line);
  for (const match of text.matchAll(/(?<!\d)((?:19|20)\d{2})\s*年/g)) {
    if (Number(match[1]) !== target) return true;
  }
  for (const match of text.matchAll(/令和\s*(\d{1,2}|元)\s*年/g)) {
    const era = match[1] === "元" ? 1 : Number(match[1]);
    if (era + 2018 !== target) return true;
  }
  return false;
}

/** 決まった文の印。これがあれば、雨天などの語があっても決まったことを述べている */
const DECIDED_MARK = /となりました|決定(?:いた)?しました|決定です|決定$|決まりました/;
/** 「雨天の場合は中止」のような、決まりの説明の文 */
const CONDITIONAL_CHANGE: readonly RegExp[] = [
  /(場合|とき|時は|際は|ならば|なら、|次第)[^。]{0,12}(中止|順延|延期)/,
  /(雨天|荒天|悪天候)時?は?(中止|順延|延期)/,
  /(中止|順延|延期)[^。]{0,6}(場合|ことがあ|こともあ|可能性)/,
];
/** 中止や延期を打ち消す文（「中止はありません」） */
const NEGATED_CHANGE = /(中止|順延|延期)(は|に)?(なし|ありません|しません|いたしません|なりません)/;
/** 祭りの全体でなく、一部の催しについての文 */
const PARTIAL_EVENT = /一部|のみ|だけ|の部(?:は|を|が|の)/;

function isDecided(line: string, words: RegExp): boolean {
  if (!words.test(line) || NEGATED_CHANGE.test(line)) return false;
  if (isOtherEvent(line) || PARTIAL_EVENT.test(line)) return false;
  return DECIDED_MARK.test(line) || !CONDITIONAL_CHANGE.some((pattern) => pattern.test(line));
}

/** 行に、中止が決まったと書いてあるか */
export function saysCancelled(line: string): boolean {
  return isDecided(line, /中止|取りやめ|取り止め|開催(いた)?しません|開催を見送/);
}

/** 行に、延期が決まったと書いてあるか */
export function saysPostponed(line: string): boolean {
  return isDecided(line, /延期|順延/);
}

/** 行に、日付や時刻があるか（別の催しの行を除く） */
export function hasScheduleValue(line: string): boolean {
  return !isOtherEvent(line) && (datesIn(line).length > 0 || timesIn(line).length > 0);
}
