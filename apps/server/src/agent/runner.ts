import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentMode,
  ConversationStage,
  ErrorCode,
  Preferences,
  SearchRetry,
  SseEvent,
} from "@matsuri-ikoka/schema";
import type { Session } from "../session/sessionStore";
import type { TurnState } from "../tools/context";

// 接客エージェントの差し替え口。画面は SSE のイベントだけを見て、どちらが動いているかを知らない。
// - live：Agent SDK でコンシェルジュとスタッフを動かす（ClaudeAgentRunner）
// - mock：記録したサンプルの相談を、記録した間隔で再生する（ReplayAgentRunner）
// done は呼び出し側（routes）が、相談の状態から必ず最後に1回送る。

export type { AgentMode };

export interface TurnInput {
  session: Session;
  message: string;
  preferences: Preferences;
  /** 候補の窓の次の手（ボタン）から送られた、変えて探し直す条件 */
  searchRetry?: SearchRetry;
  /** 時間の上限や接続の切断で止めるための signal */
  signal: AbortSignal;
  /** 進みがあったことを知らせる（イベントを出さない作業の途中。進みのない時間の上限を数え直す） */
  progress?: () => void;
}

export type EmitEvent = (event: SseEvent) => void;

/** Agent SDK の query と同じ形の関数（テストで差し替える） */
export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

export interface AgentRunner {
  readonly mode: AgentMode;
  runTurn(input: TurnInput, emit: EmitEvent): Promise<void>;
}

/** 利用者に見せる失敗。message は短い一文。詳しいことはサーバーのログに残す */
export class AgentError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/**
 * 発言1回のあとの会話の状態（docs/spec/agents.md の状態の移り方）。
 * - 再確認：予定どおり・要事前確認ならしおり（要事前確認は、しおりの表紙と画面に、出発の前に確かめるよう必ず出す）。
 *   変更・中止・どこからも情報が取れなかったときは、候補へ戻る（行き止まりにしない）
 * - 旅程を保存した → 旅程の案
 * - 旅程係が動いたのに保存できなかった（修正の途中）→ 修正
 * - 祭りを探した・祭りの固定を外した → 祭りの候補
 * - それ以外は変わらない
 */
export function nextStage(
  previous: ConversationStage,
  turn: TurnState,
  hasItinerary: boolean,
): ConversationStage {
  switch (turn.verification) {
    case "as_planned":
    case "needs_check":
      return "shiori";
    case "changed":
    case "cancelled":
    case "not_found":
      return "candidates";
    case null:
      break;
  }
  if (turn.savedItinerary) return "itinerary";
  if (turn.startedStaff.has("planner") && hasItinerary) return "revising";
  if (turn.searched || turn.anchorReleased) return "candidates";
  return previous;
}
