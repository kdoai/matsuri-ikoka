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
// guide.done は、呼び出し側（routes）が送る。

export type EmitGuideEvent = (event: GuideSseEvent) => void;

/**
 * 返答に添える出典の優先。checked：この発言で Web を調べたものと、検問を通った通知 /
 * lookup：天気・行き方・周りの店 / stored：保存してある祭りのデータ。数を超えたら後ろから落とす
 */
export const SOURCE_RANKS = { checked: 0, lookup: 1, stored: 2 } as const;
export type SourceRank = keyof typeof SOURCE_RANKS;

/** 返答に添える出典の数の上限 */
export const MAX_TURN_SOURCES = 8;

export interface NotedSource {
  source: Source;
  rank: SourceRank;
  /** その出典を確かめた時刻 */
  checkedAt: string;
}

/** 1回の発言の間に起きたこと */
export interface GuideTurnState {
  toolCalls: GuideToolName[];
  /** 返答に添える出典の候補。キーは URL */
  sources: Map<string, NotedSource>;
  /** この発言で知らせた通知と提案（同じものを2度送らない） */
  shownNotices: Set<string>;
  shownProposals: Set<string>;
}

export function newGuideTurn(): GuideTurnState {
  return {
    toolCalls: [],
    sources: new Map(),
    shownNotices: new Set(),
    shownProposals: new Set(),
  };
}

/** 出典を控える。同じ URL なら、優先の高いほうと、新しい時刻を残す */
export function noteTurnSource(turn: GuideTurnState, noted: NotedSource): void {
  const current = turn.sources.get(noted.source.url);
  if (current === undefined) {
    turn.sources.set(noted.source.url, noted);
    return;
  }
  const better = SOURCE_RANKS[noted.rank] < SOURCE_RANKS[current.rank];
  turn.sources.set(noted.source.url, {
    source: better ? noted.source : current.source,
    rank: better ? noted.rank : current.rank,
    checkedAt:
      Date.parse(noted.checkedAt) > Date.parse(current.checkedAt)
        ? noted.checkedAt
        : current.checkedAt,
  });
}

/**
 * 返答に添える出典と、調べた時刻。優先の高いものから上限まで選び、時刻は選んだもののいちばん新しい値にする。
 * 出典がなければ null
 */
export function turnSources(turn: GuideTurnState): { sources: Source[]; checkedAt: string } | null {
  const chosen = [...turn.sources.values()]
    .sort((a, b) => SOURCE_RANKS[a.rank] - SOURCE_RANKS[b.rank])
    .slice(0, MAX_TURN_SOURCES);
  const [first, ...rest] = chosen;
  if (first === undefined) return null;
  const checkedAt = rest.reduce(
    (newest, noted) =>
      Date.parse(noted.checkedAt) > Date.parse(newest) ? noted.checkedAt : newest,
    first.checkedAt,
  );
  return { sources: chosen.map((noted) => noted.source), checkedAt };
}

export interface GuideTurnInput {
  session: Session;
  trip: GuideTrip;
  message: string;
  /** この発言のときだけ使う現在地。保存せず、ログにも残さない */
  location?: LatLng | undefined;
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
    pendingProposalIds: readonly string[];
    now: string;
  },
): GuideResumeSummary {
  const topics = new Set(previous.topics);
  for (const tool of input.turn.toolCalls) topics.add(TOPIC_BY_TOOL[tool]);
  return {
    turns: previous.turns + 1,
    topics: GUIDE_TOPICS.filter((topic) => topics.has(topic)),
    pendingProposalIds: [...input.pendingProposalIds],
    lastTurnAt: input.now,
  };
}
