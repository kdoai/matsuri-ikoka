import type {
  AgentMode,
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
import type { ConsultState } from "./consult";

// 画面の正しい状態の形。3D・会話・しおりは、どれもこの形を読むだけにする。

export type StaffTask = (typeof STAFF_TASKS)[number];
/**
 * サーバーのエラーに、画面の側で気づくエラーを足したもの。
 * connection_lost 返答の途中で接続が切れた（サーバーは動いている） / server_unreachable サーバーにつながらない /
 * invalid_event 形が違う / session_lost サーバーが相談を覚えていない
 */
export type ClientErrorCode =
  | ErrorCode
  | "connection_lost"
  | "server_unreachable"
  | "invalid_event"
  | "session_lost";

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
// スタッフどうしの頼みと受け渡し

/**
 * 頼み（コンシェルジュがスタッフに作業を頼む）と受け渡し（作業の結果を次の人へ渡す）の1件。
 * task は、頼みでは頼んだ作業、受け渡しでは渡すものを作った作業。文は画面の辞書の決まった型で作る
 */
export interface RelayEntry {
  /** 通し番号。3D の手紙の動きを1回だけ流すのに使う */
  id: number;
  /** どの発言のときか */
  turn: number;
  kind: "request" | "handoff";
  from: StaffId;
  to: StaffId;
  task: StaffTask;
}

export interface RelayState {
  /** これまでの頼みと受け渡し（古いものから） */
  log: RelayEntry[];
  /** コンシェルジュがいま頼んでいる相手（吹き出しを出す間） */
  asking: { to: StaffId; task: StaffTask } | null;
  /** コンシェルジュが向いている相手（頼んだ相手・結果を受け取った相手） */
  focus: StaffId | null;
  /** 作業を終えて、まだ結果を渡していないスタッフ */
  holding: StaffId[];
}

/** 頭の上に出す、いまの作業のようす */
export const STAFF_ACTIVITIES = [
  "heading",
  "asking",
  "researching",
  "checking",
  "summarizing",
  "delivering",
] as const;
export type StaffActivity = (typeof STAFF_ACTIVITIES)[number];

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
  /** 接客サーバーの動き方。mock は見本の相談の再生で、画面にそれと出す。分からなければ null */
  mode: AgentMode | null;
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

export interface QuizState {
  /** 出す順に並べたクイズの ID。店を開くたびに混ぜ直す */
  deck: string[];
  /** 答えたクイズの ID と、選んだ選択肢の位置。答え直しはできない */
  answers: Record<string, number>;
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
  /** 会話の窓を出しているか。最初は出さず、コンシェルジュに話しかけたら出す */
  dialogueOpen: boolean;
  /** はじめての操作の案内を見終えたか。見終えたら、操作の案内は「使い方」から開く */
  tutorialSeen: boolean;
}

/** ストアのデータの部分。イベントの変換はこの形からこの形への純粋な関数にする */
export interface AppData {
  session: SessionState;
  preferences: Preferences;
  /** 選んで進める聞き取り（誰と・いつ・どこ・泊まり・楽しみ・食・スタイル） */
  consult: ConsultState;
  messages: ChatEntry[];
  staff: Record<StaffId, StaffState>;
  /** スタッフどうしの頼みと受け渡し */
  relay: RelayState;
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
