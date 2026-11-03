import type {
  ConversationStage,
  ErrorCode,
  Festival,
  FestivalCandidate,
  Itinerary,
  ItineraryDiff,
  PartialTripConditions,
  Preferences,
  Source,
  SpotPin,
  STAFF_TASKS,
  StaffId,
  ToolName,
  VerificationResult,
} from "@matsuri-ikoka/schema";

// 画面の正しい状態の形。3D・会話・しおりは、どれもこの形を読むだけにする。

export type StaffTask = (typeof STAFF_TASKS)[number];
/**
 * サーバーのエラーに、画面の側で気づくエラーを足したもの。
 * connection_lost 接続が切れた / invalid_event 形が違う / session_lost サーバーが相談を覚えていない
 */
export type ClientErrorCode = ErrorCode | "connection_lost" | "invalid_event" | "session_lost";

/** 画面に出すエラー。message はサーバーが送った一文（なければ null で、辞書の文言を出す） */
export interface ClientError {
  code: ClientErrorCode;
  message: string | null;
  retryable: boolean;
}

export type Locale = "ja" | "en";

// ---------------------------------------------------------------------------
// スタッフ

/** スタッフの状態：待機 / 持ち場へ移動 / 作業 / 戻る */
export const STAFF_PHASES = ["idle", "walking", "working", "returning"] as const;
export type StaffPhase = (typeof STAFF_PHASES)[number];

/** スタッフの動き。3D のモーションの名前にそろえる */
export const STAFF_MOTIONS = [
  "idle",
  "walk",
  "flip",
  "point",
  "look_up",
  "nod",
  "talk",
  "stamp",
  "carry",
] as const;
export type StaffMotion = (typeof STAFF_MOTIONS)[number];

export interface StaffState {
  phase: StaffPhase;
  motion: StaffMotion;
  task: StaffTask | null;
  tool: ToolName | null;
  /** 吹き出しの文章。サーバーが決まった型から作ったものをそのまま持つ */
  bubble: string | null;
  /** 変わるたびに1つ増える。うなずき・はんこのような1回きりの動きを出し直すのに使う */
  seq: number;
}

// ---------------------------------------------------------------------------
// 会話欄

export type WorkStatus = "running" | "ok" | "failed";

export type ChatEntry =
  | { kind: "user"; id: string; text: string }
  | { kind: "concierge"; id: string; text: string; streaming: boolean }
  /** 作業の記録（ツールの開始と終了） */
  | {
      kind: "work";
      id: string;
      staff: StaffId;
      tool: ToolName;
      status: WorkStatus;
      bubble: string;
      result: string | null;
    }
  /** こだわりを切り替えた記録 */
  | { kind: "preference"; id: string; key: keyof Preferences; value: string }
  /** message はサーバーが送った一文。画面の側で気づいたエラーでは null（辞書の文言を出す） */
  | {
      kind: "error";
      id: string;
      code: ClientErrorCode;
      message: string | null;
      retryable: boolean;
      resolved: boolean;
    };

// ---------------------------------------------------------------------------
// 相談

export interface ChatRequestDraft {
  message: string;
  preferences: Preferences;
}

export interface SessionState {
  id: string | null;
  status: "closed" | "opening" | "ready" | "failed";
  stage: ConversationStage;
  conditions: PartialTripConditions;
  streaming: boolean;
  /** 発言の通し番号。発言を送るたびに1つ増える */
  turn: number;
  /** いまの発言への返答で done を受け取ったか */
  sawDone: boolean;
  /** 「もう一度送る」で送り直す発言。こだわりの切り替えでは null */
  lastRequest: ChatRequestDraft | null;
  /** 最後の通信がこだわりの切り替えだったか（送り直しの行き先） */
  lastWasPreferences: boolean;
  /** この発言で始まった作業と、使われたツール。待ち時間の見込みに使う */
  turnTasks: StaffTask[];
  turnTools: ToolName[];
}

export interface ItineraryState {
  current: Itinerary | null;
  previous: Itinerary | null;
  diff: ItineraryDiff | null;
}

export interface VerifyState {
  status: "idle" | "checking" | "done";
  festivalId: string | null;
  result: VerificationResult | null;
  checkedAt: string | null;
  sources: Source[];
  note: string | null;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 待ち時間：祭りの小話・クイズ

/** 豆知識の話の種類：小話 / 見どころ / 作法 */
export type WaitingTalkKind = "trivia" | "highlight" | "etiquette";

/**
 * 待ち時間の豆知識の1話。中身は祭りのデータの文字列だけで、その場で文章を作らない。
 * 作法のうち、決まった値（見学か加われるか・危険度・写真）は code に入れ、画面の辞書で言葉にする。
 */
export interface WaitingTalk {
  kind: WaitingTalkKind;
  festivalId: string;
  festivalName: string;
  /** 作法のときの項目 */
  item?: "participation" | "howToJoin" | "rules" | "dress" | "bring" | "risk" | "photo";
  /** 作法の決まった値（participation・risk の level・photo の policy） */
  code?: string;
  /** データの文字列（作法で決まった値だけのときは空） */
  text: string;
  source: Source;
}

export type QuizKind = "category" | "highlight" | "local_food";

export interface QuizQuestion {
  kind: QuizKind;
  festivalId: string;
  festivalName: string;
  /** category のときは祭りの種類の ID、それ以外はデータの文字列 */
  choices: [string, string];
  correct: 0 | 1;
  source: Source;
}

export interface QuizState {
  /** クイズを出した発言の番号。1つの発言に1問まで */
  offeredTurn: number | null;
  question: QuizQuestion | null;
  answer: 0 | 1 | null;
}

export type FestivalLoad = "loading" | "loaded" | "missing";

// ---------------------------------------------------------------------------
// 画面

export const PANEL_TABS = ["itinerary", "map", "sources"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

/** 合言葉。needed なら入力を出す。rejected は送った合言葉が違ったとき */
export interface AuthState {
  needed: boolean;
  rejected: boolean;
}

export interface UiState {
  view: "storefront" | "shop" | "shiori";
  tab: PanelTab;
  locale: Locale;
  soundOn: boolean;
  candidatesOpen: boolean;
  /** スマートフォンで、下から引き出すパネルが開いているか */
  drawerOpen: boolean;
  /** 「旅のしおり完成」の演出の最中か */
  celebrating: boolean;
  /** 入力欄の下書き */
  draft: string;
}

/** ストアのデータの部分。イベントの変換はこの形からこの形への純粋な関数にする */
export interface AppData {
  session: SessionState;
  preferences: Preferences;
  messages: ChatEntry[];
  staff: Record<StaffId, StaffState>;
  candidates: FestivalCandidate[];
  spots: SpotPin[];
  itinerary: ItineraryState;
  verify: VerifyState;
  quiz: QuizState;
  /** クイズに正解して集めたスタンプの数。しおりの表紙に押す */
  stamps: number;
  trivia: { index: number };
  festivals: Record<string, Festival>;
  festivalLoad: Record<string, FestivalLoad>;
  auth: AuthState;
  ui: UiState;
}
