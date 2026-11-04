import { MESSAGES } from "../i18n";
import type { AppData } from "./types";

// 返答を待つ間に、会話の窓でコンシェルジュが話すひとこと。
// いまの段階（祭りを探す・旅程を組む・しおりを作る）をストアの状態から決め、その段階の文を順に入れ替える。

export type WaitPhase = "search" | "plan" | "shiori";

/** ひとことを入れ替える間隔（ミリ秒） */
export const WAIT_LINE_MS = 5_000;

const LOCALES = Object.values(MESSAGES);

/** 最後に送った文。「決定」や候補の選択を、どの言語で送っても見分けられるようにする */
function lastUserText(state: Pick<AppData, "messages">): string | null {
  const entry = state.messages.findLast((message) => message.kind === "user");
  return entry?.kind === "user" ? entry.text : null;
}

/** いま返答を待っているのは、どの段階の作業か */
export function waitPhase(
  state: Pick<AppData, "messages" | "session" | "itinerary" | "candidates">,
): WaitPhase {
  const { stage } = state.session;
  if (stage === "verifying" || stage === "shiori") return "shiori";
  const text = lastUserText(state);
  if (text !== null && LOCALES.some((m) => m.dialogue.replies.decideMessage === text)) {
    return "shiori";
  }
  if (state.itinerary.current !== null || stage === "itinerary" || stage === "revising") {
    return "plan";
  }
  // 候補から祭りを選んだら、その祭りで旅程を組み始める
  const chose =
    text !== null &&
    state.candidates.some((candidate) =>
      LOCALES.some((m) => m.candidates.chooseMessage(candidate.name) === text),
    );
  return chose ? "plan" : "search";
}

/** 待ち始めてからの時間で、何番目のひとことを出すか。最初はその段階の切り出しの文 */
export function waitLineIndex(elapsedMs: number, count: number): number {
  if (count <= 0) return 0;
  return Math.floor(Math.max(0, elapsedMs) / WAIT_LINE_MS) % count;
}
