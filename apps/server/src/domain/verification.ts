import type { Festival, IsoDate, Source, VerificationResult } from "@matsuri-ikoka/schema";
import { daysBetween } from "./calendar";
import { occurrenceOn } from "./planCheck";
import { sourcePriority } from "./searchQueries";

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
  "公式のページに例年の日程はありますが、今年の開催とは書かれていません。出発の前に、主催者の案内で今年の開催を確かめてください";

/** 公式以外の情報源で今年の開催を確かめたときの説明 */
export const UNOFFICIAL_NOTE =
  "公式以外の情報源で今年の開催を確かめました。出発の前に、主催者の案内で確かめてください";

/** どこからも開催の情報が取れなかったときの説明 */
export const NO_INFO_NOTE = "公式のページでもほかの情報源でも、開催の情報が見つかりませんでした";

/**
 * 祭りのデータの出典で、当年の開催を確かめたとみなせる日数。
 * データを調べた日（出典の確認した日）からこれより古ければ、データだけでは確かめたことにしない
 */
export const DATA_CONFIRMATION_MAX_AGE_DAYS = 60;

/** Web で確かめられなかったが、祭りのデータの公式の出典で確かめたときの説明 */
export const DATA_CONFIRMED_NOTE =
  "Web で読んだページでは今年の日程を確かめられませんでしたが、主催者などの公式の案内で今年の開催を確かめてあります";

/** Web で確かめられなかったが、祭りのデータの公式以外の出典で確かめたときの説明 */
export const DATA_UNOFFICIAL_NOTE =
  "公式以外の情報源で今年の開催を確かめてあります。出発の前に、主催者の案内で確かめてください";

/**
 * 祭りのデータで、その日の開催を最近確かめた出典。
 * - その日を含む開催回が「発表済み」（announced）であること
 * - 出典を確かめた日が、今日から DATA_CONFIRMATION_MAX_AGE_DAYS 日以内で、開催の日より後でない
 * official は公式の出典、any は確度を問わない出典（推定は除く）
 */
export function dataSources(
  festival: Festival,
  date: IsoDate,
  today: IsoDate,
): { official: Source[]; any: Source[] } {
  const occurrence = occurrenceOn(festival, date);
  if (occurrence === null || occurrence.status !== "announced") return { official: [], any: [] };
  const fresh = occurrence.sources.filter((source) => {
    if (source.confidence === "inferred") return false;
    const age = daysBetween(source.checkedAt, today);
    return age >= 0 && age <= DATA_CONFIRMATION_MAX_AGE_DAYS && source.checkedAt <= date;
  });
  return { official: fresh.filter((s) => s.confidence === "official"), any: fresh };
}

/** 祭りのデータで、その日の開催を公式の出典で確かめてあれば、その出典を返す */
export function dataConfirmation(festival: Festival, date: IsoDate, today: IsoDate): Source[] {
  return dataSources(festival, date, today).official;
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
 * 開催の確かめの結果を決める（docs/spec/agent-runtime.md の「確定前の再確認」）。
 * - 予定どおり（as_planned）：公式の出典（データで公式としたホスト、自治体のサイト）に、確かめる日の年の開催が書かれていた
 * - 要事前確認（needs_check）：公式の出典に例年の日程しかない、または公式以外の情報源に今年の開催が書かれていた。
 *   提案はするが、出発の前に主催者の案内で確かめるよう必ず添える
 * - 確認できず（not_found）：どこからも開催の情報が取れなかった。提案しない
 * - 変更・中止は、出典が1つ以上あるときだけ認める
 * - 年が書かれていたかは、調べた側の申告ではなく、ページの日付の文からコードで決めたもの（yearStated）を使う
 * - 確かめる日（date）が分かれば、祭りのデータの最近の出典で補う。公式の出典があれば予定どおりに、
 *   公式以外の出典だけなら、確認できずを要事前確認にする。変更・中止の知らせは Web の結果を優先する
 */
export function decideVerification(
  festival: Festival,
  report: VerificationReport,
  today: IsoDate,
  date?: IsoDate,
): VerificationDecision {
  const decision = decideFromReport(festival, report, today);
  const upgradable = decision.result === "not_found" || decision.result === "needs_check";
  if (!upgradable || date === undefined) return decision;
  const data = dataSources(festival, date, today);
  const merge = (first: Source[]) => {
    const urls = new Set(first.map((s) => s.url));
    return [...first, ...decision.sources.filter((s) => !urls.has(s.url))];
  };
  if (data.official.length > 0) {
    return { result: "as_planned", sources: merge(data.official), note: DATA_CONFIRMED_NOTE };
  }
  if (decision.result === "not_found" && data.any.length > 0) {
    return { result: "needs_check", sources: merge(data.any), note: DATA_UNOFFICIAL_NOTE };
  }
  return decision;
}

/** 公式の出典とみなすか。祭りのデータで公式としたホストか、自治体のサイト */
function isOfficial(url: string, host: string, official: ReadonlySet<string>): boolean {
  return official.has(host) || sourcePriority(url, new Set()) === 1;
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
      confidence: isOfficial(url, host, official) ? "official" : "single",
    });
  }
  const note = report.note?.trim().slice(0, NOTE_MAX_LENGTH) || undefined;

  if (report.result === "as_planned" || report.result === "needs_check") {
    const yearStated = report.yearStated === true;
    if (hasOfficialSource(sources)) {
      return yearStated
        ? { result: "as_planned", sources, ...(note ? { note } : {}) }
        : { result: "needs_check", sources, note: YEAR_NOT_STATED_NOTE };
    }
    if (sources.length > 0 && yearStated) {
      return { result: "needs_check", sources, note: UNOFFICIAL_NOTE };
    }
    return { result: "not_found", sources, note: NO_INFO_NOTE };
  }

  if ((report.result === "changed" || report.result === "cancelled") && sources.length === 0) {
    return { result: "not_found", sources, note: "変更や中止の出典が見つかりませんでした" };
  }
  if (report.result === "not_found") {
    return { result: "not_found", sources, note: note ?? NO_INFO_NOTE };
  }
  return { result: report.result, sources, ...(note ? { note } : {}) };
}
