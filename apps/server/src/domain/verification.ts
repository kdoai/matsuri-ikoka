import type { Festival, IsoDate, Source, VerificationResult } from "@matsuri-ikoka/schema";

// 確定前の再確認の結果を、コードのルールで決める。
// 調べた側の報告（Web 検索の結果）は信用しない入力として扱い、出典の URL から確度を付け直す。

/** 調べた側が返す報告 */
export interface VerificationReport {
  result: VerificationResult;
  sources: { url: string; title?: string }[];
  note?: string;
}

export interface VerificationDecision {
  result: VerificationResult;
  sources: Source[];
  note?: string;
}

const NOTE_MAX_LENGTH = 200;

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
 * 再確認の結果を決める。
 * - 予定どおり（as_planned）と言えるのは、公式のホストの出典があるか、2つ以上のホストで一致したときだけ。
 *   そうでなければ「確認できず」にして、確定させない
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
  const hosts = new Set(sources.map((s) => hostOf(s.url)));

  if (report.result === "as_planned") {
    if (sources.some((s) => s.confidence === "official")) {
      return { result: "as_planned", sources, ...(note ? { note } : {}) };
    }
    if (hosts.size >= 2) {
      return {
        result: "as_planned",
        sources: sources.map((s) => ({ ...s, confidence: "corroborated" })),
        ...(note ? { note } : {}),
      };
    }
    return {
      result: "not_found",
      sources,
      note: "公式の情報で開催予定を確かめられませんでした",
    };
  }

  if ((report.result === "changed" || report.result === "cancelled") && sources.length === 0) {
    return { result: "not_found", sources, note: "変更や中止の出典が見つかりませんでした" };
  }
  return { result: report.result, sources, ...(note ? { note } : {}) };
}
