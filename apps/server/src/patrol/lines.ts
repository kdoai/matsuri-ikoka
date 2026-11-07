import { createHash } from "node:crypto";
import { MAX_PATROL_CHANGED_LINES, MAX_PATROL_LINE_LENGTH } from "@matsuri-ikoka/schema";

// 公開のページを行に分けて前回と比べる。モデルを呼ぶかどうかを、ここの結果で決める。
// 行の文章は残さず、ハッシュだけを残す（ページの文章をコピーしない）。
// ページの文字は信用しない入力なので、指示に見える行はモデルにも検問の根拠にも渡さない。
// 指示の見分けは文字の形によるもので、言い換えをすべて見分けることはできない。
// そのため検問は、値がコードで読んだ新しい行に書いてあるときだけ認め、通知にページの文章を入れない。

/** 1ページから取り出す行の数の上限。保存する文書の大きさを抑える */
const MAX_LINES = 2_000;
/** 1行の長さの上限。正規表現にかける文字の長さを抑える */
const MAX_LINE_LENGTH = 2_000;

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
/** 波線の字形。NFKC ではそろわないものをそろえる */
const WAVE_DASHES = /〜|∼|〰/g;

function withoutInvisible(text: string): string {
  return text.replace(INVISIBLE_CHARS, "");
}

const RELATIVE_TIME =
  "(?:(?:\\d{1,6}|数|[一二三四五六七八九十]{1,3}) ?(?:秒|分|時間|日|週間|か月|ヶ月|カ月|ヵ月|ケ月|年) ?前|ついさっき|今さっき|さっき|たった今|先ほど|一昨日|おととい|昨日)";
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
  const line = withoutInvisible(raw.slice(0, MAX_LINE_LENGTH).normalize("NFKC"))
    .replace(WAVE_DASHES, "~")
    .replace(/\s+/g, " ")
    .trim();
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
  /\d{1,2}月\d{1,2}日|\d{1,2}\/\d{1,2}|\d{1,2}:\d{2}|\d{1,2}時|中止|延期|順延|変更|日程|開催|見合わせ|見送|休止|休催|断念|とりやめ|繰り?下げ|繰り?上げ/;

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
// 文に分ける。判定は文ごとに行う。中止の告知には、払い戻しや交通の案内がよく並ぶため

const WEEKDAY_PAREN = /^[月火水木金土日祝・]{1,4}(?:曜日?)?$/;

/** 行を文に分ける。括弧の中の補足は別の文にする。曜日の括弧はそのまま残す */
function sentencesOf(line: string): string[] {
  const notes: string[] = [];
  const body = line.normalize("NFKC").replace(/\(([^()]{1,200})\)/g, (whole, inner: string) => {
    if (WEEKDAY_PAREN.test(inner)) return whole;
    notes.push(inner);
    return " ";
  });
  return [...body.split(/[。!?]/), ...notes].map((text) => text.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// 日付と時刻を読む

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

const eraYear = (era: string): number => (era === "元" ? 1 : Number(era)) + 2018;

/** 行に書いてある日付を読む。月や年の省略は、同じ行の前の日付から引き継ぐ */
function datesIn(line: string): MonthDay[] {
  const text = withArabicDigits(line);
  const dates: MonthDay[] = [];
  const add = (year: number | null, month: number | null, day: number) => {
    if (day >= 1 && day <= 31 && (month === null || (month >= 1 && month <= 12))) {
      dates.push({ year, month, day });
    }
  };
  // 2026-11-15・2026.11.15・2026/11/15。「5-6人」「3.1km」は年がないので日付にしない
  for (const match of text.matchAll(
    /(?<!\d)(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})(?!\d)/g,
  )) {
    add(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  // R8.8.23・令和8.8.23
  for (const match of text.matchAll(
    /(?:\br|令和)\s*(\d{1,2}|元)\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})(?!\d)/gi,
  )) {
    add(eraYear(match[1] ?? ""), Number(match[2]), Number(match[3]));
  }
  // 8.23(日)。年のない点の区切りは、曜日があるときだけ日付にする
  for (const match of text.matchAll(/(?<![\d.])(\d{1,2})\.(\d{1,2})(?=\s*\([月火水木金土日祝])/g)) {
    add(null, Number(match[1]), Number(match[2]));
  }
  // 11/15、11/21・22。「1/2人」のような数は日付にしない
  for (const match of text.matchAll(
    /(?<![\d/.-])(\d{1,2})\/(\d{1,2})((?:\s*(?:\([^)]{1,4}\))?\s*[・,、~〜-]\s*\d{1,2}(?![\d/]))*)(?![\d/]|\s*(?:%|km|kg|m\b|人|名|円|個|本|杯))/g,
  )) {
    const month = Number(match[1]);
    add(null, month, Number(match[2]));
    for (const more of (match[3] ?? "").matchAll(/\d{1,2}/g)) add(null, month, Number(more[0]));
  }
  // 11月21〜22日
  for (const match of text.matchAll(/(\d{1,2})\s*月\s*(\d{1,2})\s*[~〜・,、-]\s*(\d{1,2})\s*日/g)) {
    add(null, Number(match[1]), Number(match[2]));
    add(null, Number(match[1]), Number(match[3]));
  }
  // 2026年11月21日・22日、11月21日(土)〜22日(日)、22日(日)に変更
  let month: number | null = null;
  let year: number | null = null;
  for (const match of text.matchAll(
    /(?<!\d)(?:(?:令和\s*(\d{1,2}|元)|(\d{4}))\s*年\s*)?(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*日(?!\s*(?:間|以内|前|後|程度|ほど))/g,
  )) {
    if (match[1] !== undefined) year = eraYear(match[1]);
    if (match[2] !== undefined) year = Number(match[2]);
    if (match[3] !== undefined) month = Number(match[3]);
    add(year, month, Number(match[4]));
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

const PM_WORDS = new Set(["午後", "夕方", "夕", "夜の部", "夜", "晩", "pm", "p.m."]);
const NOON_WORDS = new Set(["昼", "昼の部"]);

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
    /(午前|午後|朝|昼の部|昼|夕方|夕|夜の部|夜|晩|深夜|未明|am|pm|a\.m\.|p\.m\.)?\s*(?<![\d:])(\d{1,2})\s*(?:時(?!間)\s*(?:(\d{1,2})\s*分|(半))?|:(\d{2})(?!\d))\s*(am|pm|a\.m\.|p\.m\.)?/gi,
  )) {
    const word = (match[1] ?? match[6])?.toLowerCase();
    const raw = Number(match[2]);
    const minute = match[4] === "半" ? 30 : Number(match[3] ?? match[5] ?? 0);
    if (word !== undefined) afternoon = PM_WORDS.has(word);
    if (word === undefined) {
      add(raw, minute);
      if (afternoon && raw < 12) add(raw + 12, minute);
    } else if (PM_WORDS.has(word)) {
      add(raw < 12 ? raw + 12 : raw, minute);
    } else if (NOON_WORDS.has(word)) {
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

// ---------------------------------------------------------------------------
// 開催の根拠にできる文

const OTHER_EVENT_WORDS =
  "説明会|募集|締切|締め切り|申込|申し込み|受付|会議|講習|体験|ワークショップ|展示|物販|前夜祭|後夜祭|前日祭|後日祭|バス|列車|電車|シャトル|駐車場|終電|最終便|営業";
/** 祭りの本体でない、別の催しや案内の文。日付や時刻があっても、開催の根拠にしない */
const OTHER_EVENT = new RegExp(OTHER_EVENT_WORDS);
const HOLDING =
  "開催|日程|日時|期日|日にち|変更|振替|振り替え|実施|本祭|開始|開演|行います|行われ|おこな|(?:^|\\s)とき(?:[\\s:]|$)";
/** 開催の日時を述べる語。報告が「予定どおり」でも、この語と違う値が同じ文にあれば数える */
const HOLDING_WORD = new RegExp(HOLDING);
/** 開催の日程を述べている文 */
const SCHEDULE_CONTEXT = new RegExp(`${HOLDING}|延期|順延|当日|祭|まつり`);

/** 日付と時刻と記号のほかに何もない文（見出しのあとの「11月22日(日)」） */
function isBareDate(sentence: string): boolean {
  const rest = withArabicDigits(sentence)
    .replace(/(?:\br|令和)\s*(?:\d{1,2}|元)\s*[-./]\s*\d{1,2}\s*[-./]\s*\d{1,2}/gi, "")
    .replace(/\d{4}\s*[-./]\s*\d{1,2}\s*[-./]\s*\d{1,2}/g, "")
    .replace(/\d{4}\s*年/g, "")
    .replace(/令和\s*(?:\d{1,2}|元)\s*年/g, "")
    .replace(/\d{1,2}\s*月/g, "")
    .replace(/\d{1,2}\s*日/g, "")
    .replace(/\d{1,2}\s*[:/.]\s*\d{1,2}/g, "")
    .replace(/\d{1,2}\s*時(\s*\d{1,2}\s*分)?/g, "")
    .replace(/\([^)]{1,4}\)/g, "")
    .replace(/[\s~〜・,、.\-:]/g, "");
  return rest === "";
}

/** 行が、祭りの開催日としてその日付を述べているか */
export function announcesDate(line: string, date: string): boolean {
  return sentencesOf(line).some(
    (sentence) =>
      mentionsDate(sentence, date) &&
      !OTHER_EVENT.test(sentence) &&
      (SCHEDULE_CONTEXT.test(sentence) || isBareDate(sentence)),
  );
}

/** 行が、祭りの時刻としてその時刻を述べているか */
export function announcesTime(line: string, time: string): boolean {
  return sentencesOf(line).some(
    (sentence) => mentionsTime(sentence, time) && !OTHER_EVENT.test(sentence),
  );
}

// ---------------------------------------------------------------------------
// 中止と延期の判定（ここだけで決める）
//
// 文ごとに次の3つに分ける。迷うときは「言及」に倒す。決まった変更として知らせるのは「決定」だけで、
// 「言及」は検問で値を持たないお知らせになる。本物の中止を黙って失わないことを優先する。
//   decided   決まったと言い切れる
//   mentioned 語はあるが言い切れない（条件・打ち消し・一部の催し・別の催し・前の年の話かもしれない）
//   none      語がない、または前の年のことを述べている

type ChangeLevel = "decided" | "mentioned" | "none";

const CANCEL_WORDS = /中止|取りやめ|取り止め|開催(?:いた|致)?しません|開催を見送/;
const POSTPONE_WORDS = /延期|順延/;
/**
 * 中止や延期の言い換え。言い換えは尽きないので、これだけでは決まった変更にせず、
 * 値を持たないお知らせの理由にする
 */
const CANCEL_LIKE =
  /見合わせ|(?<!お)見送|休止|休催|断念|とりやめ|開催しない|開催(?:でき|いたしかね|致しかね)(?:ませ|ない|なく|ます)|自粛/;
const POSTPONE_LIKE = /繰り?下げ|繰り?上げ/;
const CHANGE = "(?:中止|順延|延期|取りやめ|取り止め)";

/** 決まった文の印。雨天などの語があっても、決まったことを述べている */
const DECIDED_MARK = /となりました|決定(?:いた)?しました|決定です|決定$|決まりました/;
/** 打ち消し（「中止の予定はありません」）と、一部や別の催し（「前夜祭は中止」）。決まった文の印より先に見る */
const NOT_ABOUT_FESTIVAL: readonly RegExp[] = [
  new RegExp(
    `${CHANGE}(?:は|に|の|を)?(?:なし|予定はあ|予定はご|ありません|ございません|しません|いたしません|致しません|なりません|撤回|取り消|取消)`,
  ),
  new RegExp(`(?:${OTHER_EVENT_WORDS}|一部|のみ|だけ|の部)[はをがのも]?[^。、]{0,6}${CHANGE}`),
];
/** 条件や見込みの文（「雨天の場合は中止」「中止の際はお知らせします」） */
const CONDITIONAL: readonly RegExp[] = [
  new RegExp(
    `(?:場合|とき|時は|時には|時、|際は|際には|なら(?!び)|であれば|によっては|次第)[^。]{0,16}${CHANGE}`,
  ),
  new RegExp(`(?:雨天|荒天|悪天候)時?は?${CHANGE}`),
  new RegExp(
    `${CHANGE}[^。]{0,10}(?:場合|とき|際|次第|ことがあ|こともあ|ことがござ|可能性|おそれ|恐れ|判断|かどうか|か否か|可否)`,
  ),
];

const LAST_YEAR = /昨年|去年|前年|前回/;
const THIS_YEAR = /本年|今年|今回|今季|に続き|に引き続き|同様|同じく/;
const NEXT_TIME = /来年|来季|翌年|次回/;
const PAST_TENSE = /でした|ました|となった|だった|なった/;

/** 文の年と開催回の年の関係。年度は4月から翌年3月までの幅で見る */
function yearRelation(sentence: string, date: string): "earlier" | "later" | "current" | "none" {
  const text = withArabicDigits(sentence);
  const year = Number(date.slice(0, 4));
  const fiscal = Number(date.slice(5, 7)) >= 4 ? year : year - 1;
  let relation: "earlier" | "later" | "current" | "none" = "none";
  const see = (stated: number, isFiscal: boolean) => {
    const target = isFiscal ? fiscal : year;
    if (stated === target) relation = "current";
    else if (relation === "none") relation = stated < target ? "earlier" : "later";
  };
  for (const match of text.matchAll(/(?<!\d)((?:19|20)\d{2})\s*年(度)?/g)) {
    see(Number(match[1]), match[2] !== undefined);
  }
  for (const match of text.matchAll(/令和\s*(\d{1,2}|元)\s*年(度)?/g)) {
    see(eraYear(match[1] ?? ""), match[2] !== undefined);
  }
  return relation;
}

/** 前の年のことを述べている文か。past は過去の形で言い切っている（〜年は中止でした） */
function pastState(sentence: string, date?: string): "past" | "earlier" | null {
  if (THIS_YEAR.test(sentence)) return null;
  const relation = date === undefined ? "none" : yearRelation(sentence, date);
  if (relation === "current") return null;
  if (relation !== "earlier" && !LAST_YEAR.test(sentence)) return null;
  return PAST_TENSE.test(sentence) ? "past" : "earlier";
}

/** 後の年のことを述べている文か（「2027年の祭りは中止します」）。今回の開催の決定とは言えない */
function aboutLaterYear(sentence: string, date?: string): boolean {
  if (THIS_YEAR.test(sentence)) return false;
  return (
    NEXT_TIME.test(sentence) || (date !== undefined && yearRelation(sentence, date) === "later")
  );
}

/** 行のどの文も、前の年のことを過去の形で述べているだけか */
export function talksOnlyAboutPast(line: string, date: string): boolean {
  return sentencesOf(line).every((sentence) => pastState(sentence, date) === "past");
}

function sentenceLevel(sentence: string, words: RegExp, date?: string): ChangeLevel {
  if (!words.test(sentence)) return "none";
  const past = pastState(sentence, date);
  if (past === "past") return "none";
  if (past === "earlier") return "mentioned";
  // 延期は後の年へ移ることがあるので、中止だけを見る（「来年(2027年)に延期します」は決まった延期）
  if (words === CANCEL_WORDS && aboutLaterYear(sentence, date)) return "mentioned";
  if (NOT_ABOUT_FESTIVAL.some((pattern) => pattern.test(sentence))) return "mentioned";
  if (DECIDED_MARK.test(sentence)) return "decided";
  return CONDITIONAL.some((pattern) => pattern.test(sentence)) ? "mentioned" : "decided";
}

function lineLevel(line: string, words: RegExp, date?: string): ChangeLevel {
  let level: ChangeLevel = "none";
  for (const sentence of sentencesOf(line)) {
    const found = sentenceLevel(sentence, words, date);
    if (found === "decided") return "decided";
    if (found === "mentioned") level = "mentioned";
  }
  return level;
}

/** 行に、中止が決まったと書いてあるか。date は開催回の日付（前の年の話を見分ける） */
export function saysCancelled(line: string, date?: string): boolean {
  return lineLevel(line, CANCEL_WORDS, date) === "decided";
}

/** 行に、延期が決まったと書いてあるか */
export function saysPostponed(line: string, date?: string): boolean {
  return lineLevel(line, POSTPONE_WORDS, date) === "decided";
}

/** いま分かっていること。同じことが載り直しただけの行は、新しい語として数えない */
export interface KnownSchedule {
  /** 開催回の日付 */
  occurrence: string;
  date: string;
  start: string | null;
  end: string | null;
  cancelled: boolean;
  postponed: boolean;
}

const SCHEDULE_WORD = /日程|日時|期日|開催日|開始時刻|開始時間/;

const DATE_TEXT =
  "(?:(?:令和\\s*(?:\\d{1,2}|元)|\\d{4})\\s*年\\s*)?(?:\\d{1,2}\\s*月\\s*)?\\d{1,2}\\s*日(?:\\s*\\([^)]{1,4}\\))?|\\d{4}\\s*[-./]\\s*\\d{1,2}\\s*[-./]\\s*\\d{1,2}|\\d{1,2}/\\d{1,2}";
const TIME_TEXT = "\\d{1,2}\\s*(?::\\s*\\d{2}|時(?:\\s*\\d{1,2}\\s*分)?)";
const STAMP = `(?:${DATE_TEXT})(?:\\s*(?:${TIME_TEXT}))?`;
const STAMP_LABEL = "更新|掲載|公開|投稿|作成|修正|発行";
/** 開催の日時でない日付と時刻。ページの更新の記録、残りの日数、いまの時刻 */
const NOT_SCHEDULE_VALUES: readonly RegExp[] = [
  new RegExp(`(?:${STAMP_LABEL})(?:日時?|時刻)?\\s*:?\\s*(?:${STAMP})`, "g"),
  new RegExp(`(?:${STAMP})\\s*に?\\s*(?:${STAMP_LABEL})`, "g"),
  new RegExp(`(?:${STAMP}|${TIME_TEXT})\\s*(?:現在|時点)`, "g"),
  /(?:あと|残り|まで)\s*\d{1,3}\s*日/g,
];

/**
 * 行に、開催に関わる新しい語があるか（中止・延期とその言い換え、日時）。決定と言い切れなくても true にする。
 * 検問はこれが true の行を黙って捨てず、値を持たないお知らせにする。
 * wordsOnly は報告が「予定どおり」のとき。日付や時刻だけでは数えず、開催の言葉が同じ文にあるときだけ数える
 */
export function hasScheduleSignal(
  line: string,
  known: KnownSchedule,
  options: { wordsOnly?: boolean } = {},
): boolean {
  const [, month, day] = known.date.split("-").map(Number);
  return sentencesOf(line).some((sentence) => {
    if (pastState(sentence, known.occurrence) === "past") return false;
    if ((CANCEL_WORDS.test(sentence) || CANCEL_LIKE.test(sentence)) && !known.cancelled)
      return true;
    if ((POSTPONE_WORDS.test(sentence) || POSTPONE_LIKE.test(sentence)) && !known.postponed) {
      return true;
    }
    const digits = withArabicDigits(sentence);
    const text = NOT_SCHEDULE_VALUES.reduce((rest, pattern) => rest.replace(pattern, " "), digits);
    const dates = datesIn(text);
    const times = timesIn(text);
    const differs =
      dates.some((found) => found.day !== day || (found.month ?? month) !== month) ||
      times.some((time) => time !== known.start && time !== known.end);
    if (differs && (!options.wordsOnly || (HOLDING_WORD.test(text) && !OTHER_EVENT.test(text)))) {
      return true;
    }
    return (
      dates.length === 0 && times.length === 0 && text === digits && SCHEDULE_WORD.test(digits)
    );
  });
}
