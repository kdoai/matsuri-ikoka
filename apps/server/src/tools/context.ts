import {
  type IsoDate,
  type SseEvent,
  type StaffId,
  TOOL_NAMES,
  type ToolName,
  type VerificationResult,
} from "@matsuri-ikoka/schema";
import type { FestivalStore } from "../data/festivalStore";
import type { StationPointIndex } from "../domain/travelEstimate";
import type { ItineraryStore, Session } from "../session/sessionStore";
import type { CandidateChecker } from "./candidateCheck";
import type { LodgingService } from "./lodging";
import type { NearbyResearcher } from "./nearbyResearch";
import type { RouteResearcher } from "./routeResearch";
import type { FestivalVerifier } from "./verifier";
import type { WeatherService } from "./weather";

/**
 * 接客エージェントの道具の名前。画面に動きを見せる道具（ToolName）に、
 * 画面にイベントを出さない道具（聞き取った条件の書き留め・宿の空きを調べる・行き方を調べる）を足したもの
 */
export const ALL_TOOL_NAMES = [
  ...TOOL_NAMES,
  "note_conditions",
  "search_lodging",
  "research_route",
] as const;
export type AgentToolName = (typeof ALL_TOOL_NAMES)[number];

/** 画面にイベント（tool.start・tool.end）を出す道具か */
export function isVisibleTool(name: AgentToolName): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

/** 1回の発言の間に起きたこと。会話の状態（done の stage）を決めるのに使う */
export interface TurnState {
  startedStaff: Set<StaffId>;
  /** 呼んだツール（呼んだ順）。ログに残す */
  toolCalls: AgentToolName[];
  searched: boolean;
  savedItinerary: boolean;
  verification: VerificationResult | null;
}

export function newTurnState(): TurnState {
  return {
    startedStaff: new Set(),
    toolCalls: [],
    searched: false,
    savedItinerary: false,
    verification: null,
  };
}

/** ツールが使うもの。相談ごと・発言ごとに作る */
export interface ToolContext {
  session: Session;
  turn: TurnState;
  /**
   * 発言の signal。時間切れや接続の切断で止まる。ツールはこれと自分の時間の上限を合わせて使い、
   * 止まったあとに相談の状態（旅程・再確認の結果）を書き換えない
   */
  signal: AbortSignal;
  festivals: FestivalStore;
  itineraries: ItineraryStore;
  weather: WeatherService;
  lodging: LodgingService;
  verifier: FestivalVerifier;
  /** 候補を出す前の開催の確かめ。ないとき（mock やテスト）は確かめない */
  candidateChecks?: CandidateChecker;
  /** 駅の位置。出発の駅からの所要時間を見積もる。ないときは祭りのデータの主要駅からの所要時間だけを使う */
  stations?: StationPointIndex;
  /** 出発の駅から会場の最寄り駅までの行き方を Web で調べる。ないとき（mock やテスト）は駅の位置からの見積もりだけを返す */
  routes?: RouteResearcher;
  /** 会場の周りの店・寄り道を Web で調べる。ないとき（mock やテスト）は祭りのデータの周辺の場所だけから選ぶ */
  nearby?: NearbyResearcher;
  /**
   * ツールの中で調べが進んだ（中の Agent SDK の知らせが届いた）ことを知らせる。相談の進みのない時間を数え直す。
   * 寄り道の調べのように、ツール1回が長くかかっても、動き続けていれば止めない
   */
  progress?: () => void;
  /** ツールの途中で画面に送るイベント（候補の確かめの結果など） */
  emit?: (event: SseEvent) => void;
  today: () => IsoDate;
  /** 0 以上 1 未満の乱数（全国からランダムに候補を選ぶとき）。ないときは Math.random */
  random?: () => number;
  /** 日本の今の日時（ISO 8601） */
  now: () => string;
}

/** ツールごとの時間の上限（ミリ秒） */
export const TOOL_TIMEOUT_MS: Readonly<Record<AgentToolName, number>> = {
  note_conditions: 5_000,
  // 候補の確かめ（1件30秒、3件を並べて動かす）を含む
  search_festivals: 70_000,
  // 会場の周りの店を Web で調べる。1回目と、合う店がなければ広げた2回目を含めて NEARBY_RESEARCH_MS で打ち切り、
  // 祭りのデータの場所に戻す。調べの間は ToolContext.progress で進みを知らせるので、進みのない時間の上限には掛からない
  search_nearby: 95_000,
  get_access: 10_000,
  get_weather: 10_000,
  // 空室検索は1本ずつ間隔を空けて呼ぶので、待ちを含める
  search_lodging: 20_000,
  update_itinerary: 10_000,
  // 乗り換え案内や鉄道会社のページを検索して読む
  research_route: 40_000,
  // 公式のページを検索して読むので、確定前の再確認のモデル（MODEL_VERIFIER）でも収まる長さにする
  verify_festival: 70_000,
};
