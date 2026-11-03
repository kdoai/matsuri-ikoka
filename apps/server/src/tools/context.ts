import {
  type IsoDate,
  type StaffId,
  TOOL_NAMES,
  type ToolName,
  type VerificationResult,
} from "@matsuri-ikoka/schema";
import type { FestivalStore } from "../data/festivalStore";
import type { ItineraryStore, Session } from "../session/sessionStore";
import type { FestivalVerifier } from "./verifier";
import type { WeatherService } from "./weather";

/**
 * 接客エージェントの道具の名前。画面に動きを見せる道具（ToolName）に、
 * 画面にイベントを出さない道具（聞き取った条件の書き留め）を足したもの
 */
export const ALL_TOOL_NAMES = [...TOOL_NAMES, "note_conditions"] as const;
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
  verifier: FestivalVerifier;
  today: () => IsoDate;
  /** 日本の今の日時（ISO 8601） */
  now: () => string;
}

/** ツールごとの時間の上限（ミリ秒） */
export const TOOL_TIMEOUT_MS: Readonly<Record<AgentToolName, number>> = {
  note_conditions: 5_000,
  search_festivals: 10_000,
  search_nearby: 10_000,
  get_access: 10_000,
  get_weather: 10_000,
  update_itinerary: 10_000,
  verify_festival: 30_000,
};
