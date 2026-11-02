import type { IsoDate, StaffId, ToolName, VerificationResult } from "@matsuri-ikoka/schema";
import type { FestivalStore } from "../data/festivalStore";
import type { ItineraryStore, Session } from "../session/sessionStore";
import type { FestivalVerifier } from "./verifier";
import type { WeatherService } from "./weather";

/** 1回の発言の間に起きたこと。会話の状態（done の stage）を決めるのに使う */
export interface TurnState {
  startedStaff: Set<StaffId>;
  searched: boolean;
  savedItinerary: boolean;
  verification: VerificationResult | null;
}

export function newTurnState(): TurnState {
  return { startedStaff: new Set(), searched: false, savedItinerary: false, verification: null };
}

/** ツールが使うもの。相談ごと・発言ごとに作る */
export interface ToolContext {
  session: Session;
  turn: TurnState;
  festivals: FestivalStore;
  itineraries: ItineraryStore;
  weather: WeatherService;
  verifier: FestivalVerifier;
  today: () => IsoDate;
  /** 日本の今の日時（ISO 8601） */
  now: () => string;
}

/** ツールごとの時間の上限（ミリ秒） */
export const TOOL_TIMEOUT_MS: Readonly<Record<ToolName, number>> = {
  search_festivals: 10_000,
  search_nearby: 10_000,
  get_access: 10_000,
  get_weather: 10_000,
  update_itinerary: 10_000,
  verify_festival: 20_000,
};
