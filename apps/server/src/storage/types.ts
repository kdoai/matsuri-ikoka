import type {
  AnchorPlan,
  ConversationStage,
  FestivalCandidate,
  Itinerary,
  PartialTripConditions,
  Preferences,
  TripAnchor,
  VerificationResult,
} from "@matsuri-ikoka/schema";

// 保存の口（docs/spec/account.md）。Firestore の実装（firestore.ts）と、テストと手元用のメモリの実装（memory.ts）がある。
// 旅程は形が変わっても保存の側を直さずに済むよう、丸ごと JSON の文字列で持ち、読むときに呼ぶ側でスキーマを通す。
// 会話の全文は残さない。

/** 共有の URL で読める期間と、持ち主のない旅程を残す期間（最後の保存から） */
export const SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 相談の途中の状態を残す期間（最後に使ってから） */
export const SESSION_STATE_TTL_MS = 6 * 60 * 60 * 1000;
/** 1つの旅程に残す版の数。超えたら古い版から消す */
export const MAX_VERSIONS = 20;

/** 自分の旅の一覧に出す見出し */
export interface StoredTrip {
  itineraryId: string;
  /** ログインした利用者の ID。まだだれも残していなければ null */
  ownerUid: string | null;
  title: string;
  date: string | null;
  /** 最新の版 */
  version: number;
  createdAt: number;
  updatedAt: number;
}

/** 版を指して読んだ旅程。itinerary は保存した JSON をそのまま戻したもの（スキーマは通していない） */
export interface StoredTripDetail {
  trip: StoredTrip;
  /** 残っている版（古い順） */
  versions: number[];
  version: number;
  itinerary: unknown;
}

/** 共有の URL から読んだ旅程。itinerary はスキーマを通していない */
export interface SharedItinerary {
  itineraryId: string;
  version: number;
  itinerary: unknown;
}

export interface CreatedShare {
  shareId: string;
  expiresAt: number;
}

/**
 * 相談の途中の状態。別のインスタンスに届いても相談を続けられるよう、条件・旅程の ID・段階などを残す。
 * 会話の文章と、Agent SDK の会話の記録（インスタンスの /tmp にある）は残さない
 */
export interface SessionSnapshot {
  id: string;
  createdAt: number;
  updatedAt: number;
  stage: ConversationStage;
  conditions: PartialTripConditions;
  preferences: Preferences;
  candidates: FestivalCandidate[];
  selectedFestivalId: string | null;
  itineraryId: string | null;
  /** 祭りを固定した旅程の状態。この項目がない、前の形の保存もある */
  anchor?: TripAnchor | null;
  anchorPlan?: AnchorPlan | null;
  anchorCheck?: VerificationResult | null;
  cancelledAnchor?: (TripAnchor & { name: string; note: string | null }) | null;
  replay: { sampleId: string; nextTurn: number; itineraryIds?: Record<string, string> } | null;
}

export type ClaimResult =
  | { status: "saved"; trip: StoredTrip }
  | { status: "not_found" }
  /** ほかの利用者がもう残している */
  | { status: "forbidden" };

export interface TripStorage {
  readonly kind: "memory" | "firestore";

  /** 旅程の版を残す。持ち主は変えない。持ち主のない旅程は、最後の保存から30日で消える */
  saveItinerary(itinerary: Itinerary): Promise<void>;
  /**
   * 共有の URL（しおり）から読む。id は旅程の ID か共有の ID（sh-…）。
   * 旅程の ID なら最後の保存から30日以内の最新の版、共有の ID なら作ってから30日以内の、作ったときの版
   */
  getShared(id: string): Promise<SharedItinerary | null>;
  /** 相談の中の旅程を、利用者の旅として残す（消えないようにする） */
  claimTrip(uid: string, itineraryId: string): Promise<ClaimResult>;
  /** 利用者の旅の一覧（新しく保存した順） */
  listTrips(uid: string): Promise<StoredTrip[]>;
  /** 利用者の旅を読む。version を省くと最新の版。持ち主でなければ null */
  getTrip(uid: string, itineraryId: string, version?: number): Promise<StoredTripDetail | null>;
  /** 利用者の旅を、すべての版と共有ごと消す。消したら true */
  deleteTrip(uid: string, itineraryId: string): Promise<boolean>;
  /** 利用者の旅をすべて消す。消した数を返す */
  deleteAllTrips(uid: string): Promise<number>;
  /** 利用者の旅の最新の版を、推測できない ID で30日だけ共有する。持ち主でなければ null */
  createShare(uid: string, itineraryId: string): Promise<CreatedShare | null>;

  saveSession(snapshot: SessionSnapshot): Promise<void>;
  /** 最後に使ってから6時間を過ぎた相談は null */
  getSession(id: string): Promise<SessionSnapshot | null>;
}

/** 旅程から一覧の見出しを取り出す。旅程の形が変わっても動くよう、型に頼らずに読む */
export function summarize(itinerary: unknown): { title: string; date: string | null } {
  const record = (itinerary ?? {}) as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title : "";
  const days = Array.isArray(record.days) ? record.days : [];
  const firstDay = (days[0] ?? {}) as Record<string, unknown>;
  const date = [record.date, record.startDate, firstDay.date].find(
    (value): value is string => typeof value === "string",
  );
  return { title, date: date ?? null };
}
