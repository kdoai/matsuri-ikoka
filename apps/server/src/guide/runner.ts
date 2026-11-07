import {
  type AgentMode,
  GUIDE_TOPICS,
  type GuideResumeSummary,
  type GuideSseEvent,
  type GuideToolName,
  type IsoDate,
  type LatLng,
  type Source,
} from "@matsuri-ikoka/schema";
import type { CostMeter } from "../agent/costMeter";
import type { Session } from "../session/sessionStore";
import type { GuideTrip } from "./data";

// ガイドの差し替え口。店内の相談と同じく、画面は SSE のイベントだけを見て、どちらが動いているかを知らない。
// - live：Agent SDK でガイドを動かす（ClaudeGuideRunner）
// - mock：記録したガイドの相談を再生する（ReplayGuideRunner）
// guide.emergency と guide.done は、呼び出し側（routes）が送る。

export type EmitGuideEvent = (event: GuideSseEvent) => void;

/** 1回の発言の間に起きたこと */
export interface GuideTurnState {
  toolCalls: GuideToolName[];
  /** 返答に添える出典。キーは URL */
  sources: Map<string, Source>;
  /** 調べた時刻（いちばん新しいもの） */
  checkedAt: string | null;
  /** この発言で知らせた通知と提案（同じものを2度送らない） */
  shownNotices: Set<string>;
  shownProposals: Set<string>;
}

export function newGuideTurn(): GuideTurnState {
  return {
    toolCalls: [],
    sources: new Map(),
    checkedAt: null,
    shownNotices: new Set(),
    shownProposals: new Set(),
  };
}

export interface GuideTurnInput {
  session: Session;
  trip: GuideTrip;
  message: string;
  /** この発言のときだけ使う現在地。保存せず、ログにも残さない */
  location?: LatLng | undefined;
  /** 発言に緊急かもしれない言葉があった。連絡先は呼び出し側が先に送ってある */
  emergency: boolean;
  /** この発言に使える費用（米ドル） */
  budgetUsd: number;
  turn: GuideTurnState;
  /** この発言の費用を足す先。ツールの中の調べの分も含める */
  meter: CostMeter;
  signal: AbortSignal;
  progress?: (() => void) | undefined;
}

export interface GuideRunner {
  readonly mode: AgentMode;
  /** 旅の時期を決める今日 */
  today(): IsoDate;
  /** 提案の期限を比べる、今の日時 */
  now(): string;
  /** 1回の発言の費用の上限（米ドル）。なければ、今日の残りだけで抑える */
  readonly maxBudgetUsd?: number | undefined;
  /** 相談の旅を開いたときに呼ぶ（mock：記録の通知と提案を、この相談の旅に届ける） */
  prepare?(session: Session, trip: GuideTrip): Promise<void>;
  runTurn(input: GuideTurnInput, emit: EmitGuideEvent): Promise<void>;
}

const TOPIC_BY_TOOL: Record<GuideToolName, (typeof GUIDE_TOPICS)[number]> = {
  read_trip: "festival",
  list_notices: "festival",
  research_web: "other",
  get_weather: "weather",
  research_route: "move",
  search_nearby: "food",
  propose_change: "change",
  save_memo: "other",
};

/** 続きの要約を書き足す。コードが、使ったツールと数だけから書く（会話の文を入れない） */
export function nextResumeSummary(
  previous: GuideResumeSummary,
  input: {
    turn: GuideTurnState;
    emergency: boolean;
    pendingProposalIds: readonly string[];
    now: string;
  },
): GuideResumeSummary {
  const topics = new Set(previous.topics);
  for (const tool of input.turn.toolCalls) topics.add(TOPIC_BY_TOOL[tool]);
  if (input.emergency) topics.add("trouble");
  return {
    turns: previous.turns + 1,
    topics: GUIDE_TOPICS.filter((topic) => topics.has(topic)),
    pendingProposalIds: [...input.pendingProposalIds],
    lastTurnAt: input.now,
  };
}
