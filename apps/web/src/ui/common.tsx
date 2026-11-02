import type { Confidence, Source } from "@matsuri-ikoka/schema";
import type { ReactNode } from "react";
import { useT } from "../state/react";
import { sourceLabel } from "./links";
import { printedUrl } from "./text";

// 確度のバッジ（緑・青・黄・灰）。色だけに頼らず、必ず文字でも出す
const CONFIDENCE_STYLE: Record<Confidence, string> = {
  official: "border-emerald-700 bg-emerald-50 text-emerald-900",
  corroborated: "border-sky-700 bg-sky-50 text-sky-900",
  single: "border-amber-600 bg-amber-100 text-amber-950",
  inferred: "border-stone-500 bg-stone-200 text-stone-800",
};

const CONFIDENCE_DOT: Record<Confidence, string> = {
  official: "bg-emerald-600",
  corroborated: "bg-sky-600",
  single: "bg-amber-500",
  inferred: "bg-stone-500",
};

export function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  const t = useT();
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 font-semibold text-xs ${CONFIDENCE_STYLE[confidence]}`}
      data-confidence={confidence}
    >
      <span aria-hidden="true" className={`size-2 rounded-full ${CONFIDENCE_DOT[confidence]}`} />
      {t.confidence[confidence]}
    </span>
  );
}

/** 出典のリンク。URL・確認した日・確度をそろえて出す */
export function SourceLink({ source, compact = false }: { source: Source; compact?: boolean }) {
  const t = useT();
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <a
        href={source.url}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all font-medium text-ai-700 underline decoration-ai-200 underline-offset-2 hover:decoration-ai-600"
      >
        {sourceLabel(source)}
      </a>
      <PrintedUrl source={source} />
      {compact ? null : (
        <span className="text-ink-soft">{t.sources.checkedAt(source.checkedAt)}</span>
      )}
      <ConfidenceBadge confidence={source.confidence} />
    </span>
  );
}

/** 印刷したときだけ、タイトルのある出典の URL を文字で添える（画面ではリンクで足りる） */
export function PrintedUrl({ source }: { source: Source }) {
  const url = printedUrl(source);
  return url === null ? null : (
    <span className="hidden break-all text-ink-soft print:inline" data-testid="printed-url">
      （{url}）
    </span>
  );
}

export function Pill({ children, tone = "plain" }: { children: ReactNode; tone?: PillTone }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 font-semibold text-xs ${PILL_TONE[tone]}`}
    >
      {children}
    </span>
  );
}

type PillTone = "plain" | "ai" | "shu" | "yamabuki" | "wood";

const PILL_TONE: Record<PillTone, string> = {
  plain: "bg-kinari-200 text-ink",
  ai: "bg-ai-700 text-white",
  shu: "bg-shu-600 text-white",
  yamabuki: "bg-yamabuki-200 text-yamabuki-700 ring-1 ring-yamabuki-400",
  wood: "bg-wood-100 text-wood-800 ring-1 ring-wood-300",
};

export const buttonPrimary =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-ai-700 px-4 py-2 font-bold text-white shadow-sm transition hover:bg-ai-800 active:translate-y-px disabled:cursor-not-allowed disabled:bg-stone-400";

export const buttonSecondary =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border-2 border-ai-700 bg-white px-4 py-2 font-bold text-ai-800 transition hover:bg-ai-50 disabled:cursor-not-allowed disabled:border-stone-400 disabled:text-stone-500";

export const buttonQuiet =
  "inline-flex min-h-10 items-center justify-center gap-1 rounded-lg px-3 py-1.5 font-semibold text-ai-800 text-sm transition hover:bg-ai-50";

/** 時刻の幅（開始〜終了）。片方だけ分からないときは分かる方だけ */
export function timeRange(start: string | null, end: string | null): string | null {
  if (start !== null && end !== null) {
    return `${start}〜${end}`;
  }
  return start ?? end;
}
