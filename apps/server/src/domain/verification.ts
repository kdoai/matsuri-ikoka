import type { Festival, IsoDate, Source, VerificationResult } from "@matsuri-ikoka/schema";

// 確定前の再確認の結果を、コードのルールで決める。
// 調べた側の報告（Web 検索の結果）は信用しない入力として扱い、出典の URL から確度を付け直す。

/** 調べた側が返す報告 */
export interface VerificationReport {
  result: VerificationResult;
  sources: { url: string; title?: string }[];
  /** 読んだ公式のページに、確かめる日の年（今年の開催）が書かれていたか。例年の日付だけなら false */
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
 */
export function decideVerification(
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
