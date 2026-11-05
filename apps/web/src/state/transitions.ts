import type {
  FestivalQuiz,
  Preferences,
  SearchRetry,
  StaffId,
  TripAnchor,
} from "@matsuri-ikoka/schema";
import { clientError } from "./errors";
import { closeTurn, hasNextSteps, patchStaff } from "./events";
import { initialData } from "./initial";
import type { AppData, ChatEntry, ClientError } from "./types";

// 画面の側から起きる状態の変化（発言を送る・返答が終わる・クイズに答えるなど）。
// イベントの変換と同じく純粋な関数にする。

function resolveErrors(messages: readonly ChatEntry[]): ChatEntry[] {
  return messages.map((entry) =>
    entry.kind === "error" && !entry.resolved ? { ...entry, resolved: true } : entry,
  );
}

/** 会話欄にエラーを出す。サーバーの一文があればそれを持つ */
export function addError(state: AppData, error: ClientError): AppData {
  const entry: ChatEntry = {
    kind: "error",
    id: `e-${state.session.turn}-${state.messages.length}`,
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    resolved: false,
  };
  return { ...state, messages: [...state.messages, entry] };
}

/** 合言葉を聞く。rejected は、送った合言葉が違ったとき */
export function requirePasscode(state: AppData, rejected: boolean): AppData {
  return { ...state, auth: { needed: true, rejected } };
}

/** 合言葉が通った（または要らなかった） */
export function passcodeAccepted(state: AppData): AppData {
  return state.auth.needed || state.auth.rejected
    ? { ...state, auth: { needed: false, rejected: false } }
    : state;
}

/**
 * サーバーが相談を覚えていなかった。旅程や候補は新しい相談では使えないので片付け、
 * 会話の記録・こだわり・送り直す発言は残す。新しい相談はストアが始める。
 */
export function resetForNewSession(state: AppData): AppData {
  const fresh = initialData({ locale: state.ui.locale });
  const next: AppData = {
    ...fresh,
    session: {
      ...fresh.session,
      turn: state.session.turn,
      lastRequest: state.session.lastRequest,
      lastWasPreferences: state.session.lastWasPreferences,
    },
    preferences: state.preferences,
    messages: closeTurn(state).messages,
    festivals: state.festivals,
    festivalLoad: state.festivalLoad,
    auth: state.auth,
    ui: { ...state.ui, candidatesOpen: false, celebrating: false, drawerOpen: false },
    // 祭りを決めたあとなら、送り直したあとも祭りの結果へ戻れるよう、決めたことを残す
    ...(state.consult.anchor === null
      ? {}
      : { consult: state.consult, festivalSearch: state.festivalSearch }),
  };
  return addError(next, clientError("session_lost"));
}

export type TurnStart =
  /** 利用者の発言。retry のときは会話欄に同じ発言を足さない */
  | {
      kind: "chat";
      message: string;
      preferences: Preferences;
      retry?: boolean;
      /** 次の手（ボタン）から送るときの、変えて探し直す条件 */
      search?: SearchRetry;
      /** 祭りから探して決めた祭りと行く日 */
      anchor?: TripAnchor;
    }
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
          ? {
              message: start.message,
              preferences: start.preferences,
              ...(start.search === undefined ? {} : { search: start.search }),
              ...(start.anchor === undefined ? {} : { anchor: start.anchor }),
            }
          : state.session.lastRequest,
      lastWasPreferences: start.kind === "preferences",
      turnTasks: [],
      turnTools: [],
      newCandidates: false,
    },
    messages,
    ui: { ...state.ui, candidatesOpen: false, draft: start.kind === "chat" ? "" : state.ui.draft },
  };
}

/**
 * 返答の接続が閉じた。error は通信のエラー（なければ null）。
 * done を受け取らずに閉じたら、接続が切れたものとして「もう一度送る」を出す。
 */
export function endTurn(state: AppData, error: ClientError | null): AppData {
  // この発言で届いた候補は、返答が終わって選べるようになったここで開く
  const showCandidates =
    error === null &&
    state.session.sawDone &&
    state.session.newCandidates &&
    state.session.stage === "candidates" &&
    (state.candidates.length > 0 || hasNextSteps(state.search));
  let next: AppData = {
    ...state,
    session: { ...state.session, streaming: false, newCandidates: false },
    ui: showCandidates ? { ...state.ui, candidatesOpen: true } : state.ui,
  };
  if (error !== null) {
    next = addError(next, error);
  } else if (!state.session.sawDone) {
    next = addError(next, clientError("connection_lost"));
  }
  return state.session.sawDone ? next : closeTurn(next);
}

/**
 * 利用者が候補の窓を開け閉めする。候補がなければ開かない。
 * 返答の途中で閉じたら、返答が終わっても開き直さない
 */
export function setCandidatesOpen(state: AppData, open: boolean): AppData {
  const candidatesOpen = open && (state.candidates.length > 0 || hasNextSteps(state.search));
  return {
    ...state,
    session: open ? state.session : { ...state.session, newCandidates: false },
    ui: { ...state.ui, candidatesOpen },
  };
}

/** 戻っているスタッフを待機にする（戻る動きが終わったころに呼ぶ） */
export function settleStaff(state: AppData): AppData {
  let next = state;
  for (const id of Object.keys(state.staff) as StaffId[]) {
    if (state.staff[id].phase === "returning") {
      next = patchStaff(next, id, { phase: "idle", motion: "idle", bubble: null, detail: null });
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

/** クイズに答える。正解するとスタンプが1つ増える。答え直しはできない */
export function answerQuiz(state: AppData, quiz: FestivalQuiz, choice: number): AppData {
  if (state.quiz.answers[quiz.id] !== undefined || choice < 0 || choice >= quiz.choices.length) {
    return state;
  }
  return {
    ...state,
    quiz: { ...state.quiz, answers: { ...state.quiz.answers, [quiz.id]: choice } },
    stamps: state.stamps + (choice === quiz.answer ? 1 : 0),
  };
}
