import type { IsoDate, LocalTime, MinuteRange } from "@matsuri-ikoka/schema";

/** 調べた行き方の1区間（乗り換えまでの1本） */
export interface RouteLeg {
  from: string;
  to: string;
  /** 乗る路線。歩く区間は null */
  line: string | null;
  minutes: MinuteRange;
}

/**
 * 出発の駅から会場の最寄り駅までの行き方（帰りは、最寄り駅から終わりの駅まで）を、公開の情報で調べる口。
 * live では Web 検索だけを使う1回きりのエージェントが受け持つ（agent/webRouteResearcher.ts）。
 * 返す報告は信用しない入力として、所要時間は駅の位置からの見積もりと照らし（checkResearchedMinutes）、
 * 出典は実際に読んだページだけを残す。
 */
export interface RouteReport {
  /** 出発の駅から最寄り駅までの所要時間（分の幅） */
  minutes: MinuteRange;
  /** 乗る路線と乗り換えの要約（例：〇〇線で△△へ、□□線に乗り換えて××） */
  summary: string;
  /** 乗り換えの回数 */
  transfers: number | null;
  /** 乗り換えごとの区間。読んだページで分かったときだけ */
  legs?: RouteLeg[];
  /** 帰りのとき、その日のうちに終わりの駅へ着ける最終の目安（乗る駅を出る時刻）。分からなければ null */
  lastDeparture?: LocalTime | null;
  sources: { url: string; title?: string }[];
}

/** outbound 行き（出発の駅から会場の最寄り駅）/ return 帰り（会場の最寄り駅から終わりの駅） */
export type RouteDirection = "outbound" | "return";

export interface RouteResearcher {
  /** 調べられなかったときは null */
  research(input: {
    from: string;
    to: string;
    date: IsoDate;
    arriveBy?: LocalTime;
    direction?: RouteDirection;
    /** 調べ直しで特に確かめること（評価係の指摘） */
    focus?: string;
    signal: AbortSignal;
  }): Promise<RouteReport | null>;
}
