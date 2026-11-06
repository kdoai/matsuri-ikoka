// 調査の報告を祭りのデータに反映してよいかを、モデルを使わずに確かめる。
// 集めた文字列は信用しない入力として扱う。ファイルや通信は扱わない（呼ぶ側が渡す）。
import { ungroundedSources } from "../packages/agent-kit/src";
import {
  type Festival,
  FestivalSchema,
  type IsoDate,
  type ResearchReport,
} from "../packages/schema/src";
import { validateFestivalFiles } from "./festival-validation";

/** 指示や埋め込みに見える文字。接客のエージェントがあとで読むデータに入れない */
const SUSPICIOUS_TEXT: readonly RegExp[] = [
  /https?:\/\//i,
  /<\/?[a-z][^>]*>/i,
  /\b(ignore|disregard|forget)\b.{0,30}\b(previous|above|instructions?|prompts?)\b/i,
  /\bsystem\s*prompt\b/i,
  /(これまで|以前|上記).{0,10}(指示|命令).{0,10}(無視|忘れ)/,
  /(指示|命令).{0,6}(に従|を無視)/,
  /プロンプト/,
];

export function hasSuspiciousText(text: string): boolean {
  return SUSPICIOUS_TEXT.some((pattern) => pattern.test(text));
}

export type ReportCheck = { ok: true; after: Festival } | { ok: false; reason: string };

/**
 * found の報告を祭りのデータに当てる。変えるのは任された開催回だけで、ほかの項目は変えられない。
 * 開いていないページの根拠、指示に見える文字、データの検証に落ちる結果は取り込まない
 */
export function applyResearchReport(input: {
  before: Festival;
  report: ResearchReport;
  occurrenceDate: IsoDate;
  today: IsoDate;
  fetchedUrls: readonly string[];
  /** 例示用のドメインの出典を許す（架空のデータで確かめるテストだけで使う） */
  allowExampleSources?: boolean;
}): ReportCheck {
  const { before, report, occurrenceDate, today, fetchedUrls, allowExampleSources = false } = input;
  const reject = (reason: string): ReportCheck => ({ ok: false, reason });

  if (report.festivalId !== before.id) return reject(`別の祭りの報告（${report.festivalId}）`);
  if (report.occurrenceDate !== occurrenceDate) return reject("別の開催回の報告");
  const patch = report.occurrence;
  if (report.outcome !== "found" || patch === null) return reject("開催回がない報告");

  const texts = [
    patch.rainPolicy,
    patch.note,
    ...report.evidence.flatMap((evidence) => [evidence.title, evidence.quote]),
  ];
  if (texts.some((text) => typeof text === "string" && hasSuspiciousText(text))) {
    return reject("報告の文字に、URL や指示に見える文が混ざっている");
  }

  const unread = ungroundedSources(report.evidence, fetchedUrls);
  if (unread.length > 0) return reject(`開いていないページを根拠にした（${unread.length} 件）`);

  const previous = before.occurrences.find((occurrence) => occurrence.date === occurrenceDate);
  const next = {
    date: patch.date,
    ...(patch.endDate === undefined ? {} : { endDate: patch.endDate }),
    start: patch.start ?? previous?.start ?? null,
    end: patch.end ?? previous?.end ?? null,
    status: patch.status,
    rainPolicy: patch.rainPolicy ?? previous?.rainPolicy ?? null,
    ...(patch.note === undefined ? {} : { note: patch.note }),
    sources: report.evidence.map((evidence) => ({
      url: evidence.url,
      ...(evidence.title === undefined ? {} : { title: evidence.title }),
      checkedAt: today,
      confidence: evidence.confidence,
    })),
  };
  const occurrences = [
    ...before.occurrences.filter((occurrence) => occurrence.date !== occurrenceDate),
    next,
  ].sort((a, b) => (a.date < b.date ? -1 : 1));

  const parsed = FestivalSchema.safeParse({ ...before, occurrences });
  if (!parsed.success) return reject("スキーマに合わない");
  const errors = validateFestivalFiles(
    [{ name: `${before.id}.json`, content: JSON.stringify(parsed.data) }],
    { today, allowExampleSources },
  ).filter((finding) => finding.level === "error");
  if (errors.length > 0) {
    return reject(`データの検証に落ちた（${errors[0]?.message ?? ""}）`);
  }
  return { ok: true, after: parsed.data };
}

/** ページの本文として比べる文字にする。タグを除き、全角と半角と空白の違いをならす */
export function normalizePageText(raw: string): string {
  return raw
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/** これより本文が短いページは、スクリプトで描かれていて機械では比べられないとみなす */
const MIN_COMPARABLE_LENGTH = 300;

export type QuoteCheck = "found" | "missing" | "unverifiable";

/** ページを取り直した本文に、報告の引用がそのまま書いてあるか */
export function checkQuote(page: string, quote: string): QuoteCheck {
  const body = normalizePageText(page);
  if (body.length < MIN_COMPARABLE_LENGTH) return "unverifiable";
  return body.includes(normalizePageText(quote)) ? "found" : "missing";
}
