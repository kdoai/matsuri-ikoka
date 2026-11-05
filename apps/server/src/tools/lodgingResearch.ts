import type { IsoDate, Party } from "@matsuri-ikoka/schema";
import type { LodgingSearchPlan, PerspectiveLodgingReport } from "../domain/lodgingResearch";

export type { PerspectiveLodgingReport };

export interface LodgingResearchRequest {
  festival: {
    id: string;
    name: string;
    place: string;
    venue: { name: string; lat: number; lng: number };
  };
  checkIn: IsoDate;
  nights: number;
  party: Party;
  /** 1泊1人あたりの宿の予算の上限（円）。分からなければ null */
  perPersonNightLimitYen: number | null;
  /** 観点ごとの調べ方。コードで決め、観点ごとに1つの調べ役に渡す（domain/lodgingResearch.ts） */
  plans: LodgingSearchPlan[];
  signal: AbortSignal;
  /** 調べが進んだ（検索やページの読み込みがあった）ときに呼ぶ。相談の進みのない時間を数え直す */
  onActivity?: () => void;
}

/**
 * 祭りの会場の近くの宿を、公開の Web で調べる口。
 * live では Web 検索だけを使う1回きりのエージェントを観点ごとに並べて動かす（agent/webLodgingResearcher.ts）。
 * 返す報告は信用しない入力として、突き合わせ・距離・予算に合うかはコードで決め直し
 * （domain/lodgingResearch.ts の screenResearchedLodging）、出典は実際に読んだページだけを残す。
 */
export interface LodgingResearcher {
  /** 調べられなかったときは null（呼ぶ側は空室検索の結果か、泊まる地域だけの案内に戻る） */
  research(input: LodgingResearchRequest): Promise<{ reports: PerspectiveLodgingReport[] } | null>;
}
