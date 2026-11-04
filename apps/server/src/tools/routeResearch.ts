import type { IsoDate, LocalTime, MinuteRange } from "@matsuri-ikoka/schema";

/**
 * 出発の駅から会場の最寄り駅までの行き方を、公開の情報で調べる口。
 * live では Web 検索だけを使う1回きりのエージェントが受け持つ（agent/webRouteResearcher.ts）。
 * 返す報告は信用しない入力として、所要時間は駅の位置からの見積もりと照らし（checkResearchedMinutes）、
 * 出典は実際に読んだページだけを残す。
 */
export interface RouteReport {
  /** 出発の駅から最寄り駅までの所要時間（分の幅） */
  minutes: MinuteRange;
  /** 乗る路線と乗り換えの要約（例：阪急京都線で桂、嵐山線に乗り換えて嵐山） */
  summary: string;
  /** 乗り換えの回数 */
  transfers: number | null;
  sources: { url: string; title?: string }[];
}

export interface RouteResearcher {
  /** 調べられなかったときは null */
  research(input: {
    from: string;
    to: string;
    date: IsoDate;
    arriveBy?: LocalTime;
    signal: AbortSignal;
  }): Promise<RouteReport | null>;
}
