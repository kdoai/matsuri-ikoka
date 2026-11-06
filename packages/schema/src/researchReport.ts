import { z } from "zod";
import { IsoDateSchema, LocalTimeSchema, SlugSchema } from "./common";

/** 調査員が開催を確かめた根拠。quote はページにそのまま書いてある短い引用 */
export const ResearchEvidenceSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }),
  title: z.string().min(1).max(120).optional(),
  quote: z.string().min(1).max(300),
  /** 確度。意見は持たず、調査のスキルの情報源の順位で決める */
  confidence: z.enum(["official", "corroborated", "single"]),
});
export type ResearchEvidence = z.infer<typeof ResearchEvidenceSchema>;

/** 調査で変えてよい項目だけを持つ開催回。ほかの項目はこの報告では変えられない */
export const ResearchOccurrencePatchSchema = z.strictObject({
  date: IsoDateSchema,
  endDate: IsoDateSchema.optional(),
  start: LocalTimeSchema.nullable(),
  end: LocalTimeSchema.nullable(),
  status: z.enum(["announced", "postponed", "cancelled"]),
  rainPolicy: z.string().min(1).max(200).nullable(),
  note: z.string().min(1).max(200).optional(),
});
export type ResearchOccurrencePatch = z.infer<typeof ResearchOccurrencePatchSchema>;

/**
 * 1つの祭りについての調査の報告（/mnt/session/outputs/{festivalId}.json）。
 * found なら開催回と根拠を持ち、not_found ならどちらも持たない
 */
export const ResearchReportSchema = z
  .strictObject({
    festivalId: SlugSchema,
    occurrenceDate: IsoDateSchema,
    outcome: z.enum(["found", "not_found"]),
    occurrence: ResearchOccurrencePatchSchema.nullable(),
    evidence: z.array(ResearchEvidenceSchema).max(8),
  })
  .refine(
    (report) =>
      report.outcome === "found"
        ? report.occurrence !== null && report.evidence.length > 0
        : report.occurrence === null && report.evidence.length === 0,
    { message: "found には開催回と根拠が要り、not_found には書かない" },
  );
export type ResearchReport = z.infer<typeof ResearchReportSchema>;

/** セッションが読む調査リスト（Memory Store の /queue.json）。コードだけが書く */
export const ResearchQueueSchema = z.strictObject({
  /** 作った日（日本の日付）。調査員に今日の日付として伝える */
  preparedOn: IsoDateSchema,
  /** 作った時刻。これより後に起動したセッションの結果だけを回収する */
  preparedAt: z.iso.datetime(),
  targets: z.array(
    z.strictObject({
      id: SlugSchema,
      occurrenceDate: IsoDateSchema,
    }),
  ),
});
export type ResearchQueue = z.infer<typeof ResearchQueueSchema>;
