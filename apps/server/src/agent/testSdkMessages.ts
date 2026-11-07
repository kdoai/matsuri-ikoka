import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// テストの偽物の query が返す Agent SDK の知らせ。本物の SDK は呼ばない

/** 台本が「ターンの上限で終わった」ことにする印 */
export const MAX_TURNS = Symbol("max_turns");

/** 台本の返し。文なら成功、null なら途中の失敗、MAX_TURNS ならターンの上限 */
export type ScriptResult = string | null | typeof MAX_TURNS;

/** セッションの始まりの知らせ（session_id を名乗る） */
export function initMessage(sessionId: string): SDKMessage {
  return { type: "system", subtype: "init", session_id: sessionId } as unknown as SDKMessage;
}

/** 台本の返しを結果の知らせにする。costUsd は結果の total_cost_usd（この呼び出しの累計） */
export function resultMessage(text: ScriptResult, costUsd = 0): SDKMessage {
  if (text === MAX_TURNS) {
    return {
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      errors: [],
      total_cost_usd: costUsd,
    } as unknown as SDKMessage;
  }
  if (text === null) {
    return {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: [],
      total_cost_usd: costUsd,
    } as unknown as SDKMessage;
  }
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    total_cost_usd: costUsd,
  } as unknown as SDKMessage;
}
