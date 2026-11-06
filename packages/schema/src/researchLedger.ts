import { z } from "zod";
import { IsoDateSchema, SlugSchema } from "./common";

/**
 * 調べた結果。
 * found 開催を確かめられた（データへの反映は PR で決まる） / not_found 調べたが確かめられなかった /
 * failed 通信の失敗や費用の上限で、最後まで調べられなかった
 */
export const RESEARCH_RESULTS = ["found", "not_found", "failed"] as const;
export const ResearchResultSchema = z.enum(RESEARCH_RESULTS);
export type ResearchResult = z.infer<typeof ResearchResultSchema>;

/** 1つの祭りの、いま調べている開催回についての記録 */
export const ResearchLedgerEntrySchema = z.strictObject({
  /** この記録が指す開催回の初日。開催回が変われば、この記録は効かなくなる */
  occurrenceDate: IsoDateSchema,
  lastResearchedAt: IsoDateSchema,
  result: ResearchResultSchema,
  /** 次に調べてよい日。null ならこの開催回はこれ以上調べない */
  nextResearchOn: IsoDateSchema.nullable(),
  /** 続けて失敗した回数 */
  failures: z.number().int().nonnegative(),
});
export type ResearchLedgerEntry = z.infer<typeof ResearchLedgerEntrySchema>;

/** 確定しないまま開催日を過ぎた記録。今後の情報の集め方を考える材料で、調査の選び方には使わない */
export const OfficialNotFoundSchema = z.strictObject({
  festivalId: SlugSchema,
  occurrenceDate: IsoDateSchema,
  lastResearchedAt: IsoDateSchema,
});
export type OfficialNotFound = z.infer<typeof OfficialNotFoundSchema>;

/** 調査の台帳（data/research-ledger.json）。コードだけが書き込み、モデルの出力をそのまま入れない */
export const ResearchLedgerSchema = z.strictObject({
  festivals: z.record(SlugSchema, ResearchLedgerEntrySchema),
  officialNotFound: z.array(OfficialNotFoundSchema),
});
export type ResearchLedger = z.infer<typeof ResearchLedgerSchema>;
