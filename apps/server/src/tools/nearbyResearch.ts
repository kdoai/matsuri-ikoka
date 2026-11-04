import type { DietaryNeed, FoodWish, IsoDate, LatLng, Party } from "@matsuri-ikoka/schema";
import type { ResearchedSpotReport } from "../domain/nearbyResearch";

export type { ResearchedSpotReport };

export interface NearbyResearchRequest {
  festival: { id: string; name: string; place: string; venue: { name: string } & LatLng };
  date: IsoDate;
  foodWishes: FoodWish[];
  dietary: DietaryNeed[];
  /** 1人あたりの旅の予算（円）。分からなければ null */
  perPersonBudgetYen: number | null;
  party: Party | null;
  /** 祭りのデータにある周辺の場所（参考として渡す） */
  references: { name: string; kind: string; summary: string }[];
  signal: AbortSignal;
}

/**
 * 会場の周りの店・寄り道を、公開の情報で調べる口。
 * live では Web 検索だけを使う1回きりのエージェント（周辺係の調べ）が受け持つ（agent/webNearbyResearcher.ts）。
 * 返す報告は信用しない入力として、希望・予算・同行者・行く日の営業に合うかは
 * コードで決め直し（domain/nearbyResearch.ts の screenResearchedSpots）、出典は実際に読んだページだけを残す。
 */
export interface NearbyResearcher {
  /** 調べられなかったときは null（呼ぶ側は祭りのデータの周辺の場所に戻る） */
  research(input: NearbyResearchRequest): Promise<{ spots: ResearchedSpotReport[] } | null>;
}
