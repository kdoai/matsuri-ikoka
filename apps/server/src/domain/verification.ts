import type { Festival, IsoDate, Source, VerificationResult } from "@matsuri-ikoka/schema";
import { daysBetween } from "./calendar";
import { occurrenceOn } from "./planCheck";

// 確定前の再確認の結果を、コードのルールで決める。
// 調べた側の報告（Web 検索の結果）は信用しない入力として扱い、出典の URL から確度を付け直す。

/** 調べた側が返す報告 */
export interface VerificationReport {
  result: VerificationResult;
  sources: { url: string; title?: string }[];
  /**
   * 読んだ公式のページに、確かめる日の年（今年の開催）が書かれていたか。例年の日付だけなら false。
   * 調べた側の自己申告ではなく、ページの日付の文からコードで決める（yearStatedOnPage）
   */
  yearStated?: boolean;
  note?: string;
}

export interface VerificationDecision {
  result: VerificationResult;
  sources: Source[];
  note?: string;
}

const NOTE_MAX_LENGTH = 200;

/** 公式のページに例年の日付はあるが、今年の開催と書かれていないときの説明 */
export const YEAR_NOT_STATED_NOTE =
  "公式のページに例年の日程はありますが、今年の開催とは書かれていないため、今年の予定は確かめられませんでした";

/**
 * 祭りのデータの公式の出典で、当年の開催を確かめたとみなせる日数。
 * データを調べた日（出典の確認した日）からこれより古ければ、データだけでは確かめたことにしない
 */
export const DATA_CONFIRMATION_MAX_AGE_DAYS = 60;

/** Web で確かめられなかったが、祭りのデータの公式の出典で確かめたときの説明 */
export const DATA_CONFIRMED_NOTE =
  "Web で読んだページでは今年の日程を確かめられませんでしたが、主催者などの公式の案内で今年の開催を確かめてあります";

/**
 * 祭りのデータで、その日の開催を公式の出典で確かめてあるか。確かめてあれば、その出典を返す。
 * - その日を含む開催回が「発表済み」（announced）で、確度が公式の出典がある
 * - その出典を確かめた日が、今日から DATA_CONFIRMATION_MAX_AGE_DAYS 日以内で、開催の日より後でない
 */
export function dataConfirmation(festival: Festival, date: IsoDate, today: IsoDate): Source[] {
  const occurrence = occurrenceOn(festival, date);
  if (occurrence === null || occurrence.status !== "announced") return [];
  return occurrence.sources.filter((source) => {
    if (source.confidence !== "official") return false;
    const age = daysBetween(source.checkedAt, today);
    return age >= 0 && age <= DATA_CONFIRMATION_MAX_AGE_DAYS && source.checkedAt <= date;
  });
}

/** 照合のために、全角と半角・空白の違いをならす */
function normalizeForMatch(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, "");
}

const KANJI_DIGITS = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

/** 1〜99 を漢数字にする（八・十一・二十・三十五） */
function kanjiNumber(n: number): string {
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  const tensPart = tens === 0 ? "" : `${tens === 1 ? "" : KANJI_DIGITS[tens]}十`;
  return `${tensPart}${KANJI_DIGITS[ones]}`;
}

/**
 * 文に、その年が書かれているか。西暦（2026・２０２６）と令和（令和8年・令和八年・令和元年）を読む。
 * 「毎年」「例年」のように年のない書き方や、2桁の年（26年）は、書かれていないとみなす
 */
export function statesYear(text: string, year: number): boolean {
  const normalized = normalizeForMatch(text);
  if (new RegExp(`(?<!\\d)${year}(?!\\d)`).test(normalized)) return true;
  const reiwa = year - 2018;
  if (reiwa < 1 || reiwa > 99) return false;
  const names = [String(reiwa), kanjiNumber(reiwa), ...(reiwa === 1 ? ["元"] : [])];
  return new RegExp(`令和(?:${names.join("|")})年`).test(normalized);
}

/**
 * 調べた側が写したページの日付の文（dateText）から、確かめる日の年がページに書かれていたかを決める。
 * - 写した文が、実際に読んだページの本文（WebFetch の結果）の中にあるときだけ使う。ないなら、書き換えたか補ったとみなす
 * - その文に、確かめる日の年が書かれているか（statesYear）
 */
export function yearStatedOnPage(input: {
  dateText: string | undefined;
  /** 実際に読んだページの本文 */
  pages: readonly string[];
  date: IsoDate;
}): boolean {
  const quote = normalizeForMatch(input.dateText ?? "");
  if (quote === "") return false;
  if (!input.pages.some((page) => normalizeForMatch(page).includes(quote))) return false;
  return statesYear(quote, Number(input.date.slice(0, 4)));
}

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.hostname.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

/** 公式の確度の出典があるか。「公式情報で確認」と言ってよいかの判定に使う */
export function hasOfficialSource(sources: readonly Source[]): boolean {
  return sources.some((s) => s.confidence === "official");
}

/** 祭りのデータで「公式」とした出典のホスト */
export function officialHosts(festival: Festival): Set<string> {
  const sources = [...festival.sources, ...festival.occurrences.flatMap((o) => o.sources)];
  return new Set(
    sources.flatMap((s) => {
      const host = s.confidence === "official" ? hostOf(s.url) : null;
      return host === null ? [] : [host];
    }),
  );
}

/**
 * 再確認の結果を決める（docs/spec/agent-runtime.md の「確定前の再確認」の手順4）。
 * - 予定どおり（as_planned）と言えるのは、公式のホストの出典があるときだけ。
 *   公式でない情報源がいくつ一致しても、「確認できず」にして確定させない
 *   （画面としおりの「公式情報で確認」の文言と、実際の確度をそろえる）
 * - 公式の出典があっても、確かめる日の年が書かれていなければ（例年の日付だけなら）、
 *   今年の開催と言えないので「確認できず」にする。報告に年の明記がなければ、書かれていないとみなす
 * - 変更・中止は、出典が1つ以上あるときだけ認める
 * - Web で「確認できず」になっても、確かめる日（date）が分かり、祭りのデータの公式の出典で当年の開催を
 *   確かめてあれば（dataConfirmation）、予定どおりにする。変更・中止の知らせは Web の結果を優先する
 */
export function decideVerification(
  festival: Festival,
  report: VerificationReport,
  today: IsoDate,
  date?: IsoDate,
): VerificationDecision {
  const decision = decideFromReport(festival, report, today);
  if (decision.result !== "not_found" || date === undefined) return decision;
  const confirmed = dataConfirmation(festival, date, today);
  if (confirmed.length === 0) return decision;
  const urls = new Set(confirmed.map((s) => s.url));
  return {
    result: "as_planned",
    sources: [...confirmed, ...decision.sources.filter((s) => !urls.has(s.url))],
    note: DATA_CONFIRMED_NOTE,
  };
}

function decideFromReport(
  festival: Festival,
  report: VerificationReport,
  today: IsoDate,
): VerificationDecision {
  const official = officialHosts(festival);
  const seen = new Set<string>();
  const sources: Source[] = [];
  for (const { url, title } of report.sources) {
    const host = hostOf(url);
    if (host === null || seen.has(url)) continue;
    seen.add(url);
    sources.push({
      url,
      ...(title ? { title: title.slice(0, 120) } : {}),
      checkedAt: today,
      confidence: official.has(host) ? "official" : "single",
    });
  }
  const note = report.note?.trim().slice(0, NOTE_MAX_LENGTH) || undefined;

  if (report.result === "as_planned") {
    if (!hasOfficialSource(sources)) {
      return {
        result: "not_found",
        sources,
        note: "公式の情報で開催予定を確かめられませんでした",
      };
    }
    if (report.yearStated !== true) {
      return { result: "not_found", sources, note: YEAR_NOT_STATED_NOTE };
    }
    return { result: "as_planned", sources, ...(note ? { note } : {}) };
  }

  if ((report.result === "changed" || report.result === "cancelled") && sources.length === 0) {
    return { result: "not_found", sources, note: "変更や中止の出典が見つかりませんでした" };
  }
  return { result: report.result, sources, ...(note ? { note } : {}) };
}
