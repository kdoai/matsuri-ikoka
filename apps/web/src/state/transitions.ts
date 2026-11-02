import type { Preferences, StaffId } from "@matsuri-ikoka/schema";
import { closeTurn, patchStaff } from "./events";
import type { AppData, ChatEntry, ClientErrorCode, QuizQuestion, StaffTask } from "./types";

// 画面の側から起きる状態の変化（発言を送る・返答が終わる・クイズに答えるなど）。
// イベントの変換と同じく純粋な関数にする。

/** 送り直せば直る見込みのあるエラー（サーバーが retryable を送らない、画面の側のエラー） */
const RETRYABLE: Record<ClientErrorCode, boolean> = {
  bad_request: false,
  unauthorized: false,
  rate_limited: false,
  timeout: true,
  tool_failed: true,
  upstream_unavailable: true,
  internal: true,
  connection_lost: true,
  invalid_event: false,
};

export function isRetryable(code: ClientErrorCode): boolean {
  return RETRYABLE[code];
}

function resolveErrors(messages: readonly ChatEntry[]): ChatEntry[] {
  return messages.map((entry) =>
    entry.kind === "error" && !entry.resolved ? { ...entry, resolved: true } : entry,
  );
}

export function addClientError(state: AppData, code: ClientErrorCode): AppData {
  const entry: ChatEntry = {
    kind: "error",
    id: `e-${state.session.turn}-${state.messages.length}`,
    code,
    message: null,
    retryable: isRetryable(code),
    resolved: false,
  };
  return { ...state, messages: [...state.messages, entry] };
}

export type TurnStart =
  /** 利用者の発言。retry のときは会話欄に同じ発言を足さない */
  | { kind: "chat"; message: string; preferences: Preferences; retry?: boolean }
  /** こだわりの切り替え（旅程係だけが組み直す） */
  | { kind: "preferences"; preferences: Preferences };

/** 発言を送り始める */
export function beginTurn(state: AppData, start: TurnStart): AppData {
  const turn = state.session.turn + 1;
  let messages = resolveErrors(state.messages);
  if (start.kind === "chat" && !start.retry) {
    messages = [...messages, { kind: "user", id: `u-${turn}`, text: start.message }];
  }
  return {
    ...state,
    session: {
      ...state.session,
      streaming: true,
      turn,
      sawDone: false,
      lastRequest:
        start.kind === "chat"
          ? { message: start.message, preferences: start.preferences }
          : state.session.lastRequest,
      lastWasPreferences: start.kind === "preferences",
      turnTasks: [],
      turnTools: [],
    },
    messages,
    quiz: { ...state.quiz, question: null, answer: null },
    ui: { ...state.ui, candidatesOpen: false, draft: start.kind === "chat" ? "" : state.ui.draft },
  };
}

/**
 * 返答の接続が閉じた。error は通信のエラー（なければ null）。
 * done を受け取らずに閉じたら、接続が切れたものとして「もう一度送る」を出す。
 */
export function endTurn(state: AppData, error: ClientErrorCode | null): AppData {
  let next: AppData = { ...state, session: { ...state.session, streaming: false } };
  if (error !== null) {
    next = addClientError(next, error);
  } else if (!state.session.sawDone) {
    next = addClientError(next, "connection_lost");
  }
  if (!state.session.sawDone) {
    next = closeTurn(next);
    next = {
      ...next,
      messages: next.messages.map((entry) =>
        entry.kind === "work" && entry.status === "running"
          ? { ...entry, status: "failed" }
          : entry,
      ),
      quiz: { ...next.quiz, question: null, answer: null },
    };
  }
  return next;
}

/** 戻っているスタッフを待機にする（戻る動きが終わったころに呼ぶ） */
export function settleStaff(state: AppData): AppData {
  let next = state;
  for (const id of Object.keys(state.staff) as StaffId[]) {
    if (state.staff[id].phase === "returning") {
      next = patchStaff(next, id, { phase: "idle", motion: "idle", bubble: null });
    }
  }
  return next;
}

/** こだわりを1つ切り替える。会話欄に記録を残す */
export function changePreference<K extends keyof Preferences>(
  state: AppData,
  key: K,
  value: Preferences[K],
): AppData {
  if (state.preferences[key] === value) {
    return state;
  }
  const entry: ChatEntry = {
    kind: "preference",
    id: `p-${state.session.turn}-${state.messages.length}`,
    key,
    value,
  };
  return {
    ...state,
    preferences: { ...state.preferences, [key]: value },
    messages: [...state.messages, entry],
  };
}

// ---------------------------------------------------------------------------
// クイズ

/** スタッフの作業の、だいたいの所要時間（ミリ秒）。クイズを出すかどうかの見込みにだけ使う */
const TASK_EXPECTED_MS: Record<StaffTask, number> = {
  find_festivals: 6_000,
  find_nearby: 5_000,
  plan_route: 7_000,
};
const VERIFY_EXPECTED_MS = 12_000;
/** これ以上待ちそうなときだけクイズを出す */
export const QUIZ_MIN_WAIT_MS = 10_000;

/** この発言で、どのくらい待ちそうか。始まった作業と、再確認の有無から見込む */
export function expectedWaitMs(state: AppData): number {
  const taskMs = state.session.turnTasks.reduce((sum, task) => sum + TASK_EXPECTED_MS[task], 0);
  const verifyMs = state.session.turnTools.includes("verify_festival") ? VERIFY_EXPECTED_MS : 0;
  return taskMs + verifyMs;
}

export function shouldOfferQuiz(state: AppData): boolean {
  return (
    state.session.streaming &&
    state.quiz.offeredTurn !== state.session.turn &&
    expectedWaitMs(state) >= QUIZ_MIN_WAIT_MS
  );
}

export function offerQuiz(state: AppData, question: QuizQuestion): AppData {
  return { ...state, quiz: { offeredTurn: state.session.turn, question, answer: null } };
}

/** クイズに答える。正解するとスタンプが1つ増える。答え直しはできない */
export function answerQuiz(state: AppData, choice: 0 | 1): AppData {
  const { question, answer } = state.quiz;
  if (question === null || answer !== null) {
    return state;
  }
  return {
    ...state,
    quiz: { ...state.quiz, answer: choice },
    stamps: state.stamps + (choice === question.correct ? 1 : 0),
  };
}
