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
import type { OwnerId } from "./owner";

// 保存の口（docs/spec/account.md）。Firestore の実装（firestore.ts）と、テストと手元用のメモリの実装（memory.ts）がある。
// 旅程は形が変わっても保存の側を直さずに済むよう、丸ごと JSON の文字列で持ち、読むときに呼ぶ側でスキーマを通す。
// 会話の全文は残さない。
// 利用者の旅は forOwner(持ち主) を通してしか読み書きできない。持ち主を決めずに呼ぶ口はない。

/** 共有の URL で読める期間と、持ち主のない旅程を残す期間（最後の保存から） */
export const SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 共有を使い回すときに残っているべき期間。これより短ければ、受け取った人がすぐ開けなくなるので新しく作る */
export const SHARE_REUSE_MIN_REMAINING_MS = SHARE_TTL_MS / 2;
/** 相談の途中の状態を残す期間（最後に使ってから） */
export const SESSION_STATE_TTL_MS = 6 * 60 * 60 * 1000;
/** 1つの旅程に残す版の数。超えたら古い版から消す */
export const MAX_VERSIONS = 20;
/** ガイドの1日の使った量を残す期間。上限を数え終えたら要らない */
export const GUIDE_USAGE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
/** 旅の下の1つの種類から読む文書の数の上限（通知と手帳はスキーマで決まった数まで。提案は期限で消える） */
export const MAX_TRIP_DOCS = 200;

/** 旅の下に置くガイドのデータの種類（docs/spec/guide.md の「データの保存と消し方」） */
export const TRIP_DOC_KINDS = ["watch", "notices", "proposals", "memo"] as const;
export type TripDocKind = (typeof TRIP_DOC_KINDS)[number];
/** 見回りの依頼の文書の ID。1つの旅に1つだけ持つ */
export const TRIP_WATCH_DOC_ID = "current";

/** 自分の旅の一覧に出す見出し */
export interface StoredTrip {
  itineraryId: string;
  /** 自分の旅として残した利用者の ID。まだだれも残していなければ null */
  ownerUid: string | null;
  /** ログインした相談で組んだ旅程の、その利用者の ID。残す前でも、この人だけが読める */
  consultOwnerUid: string | null;
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
  /** ログインして使った相談の持ち主。一度決まったら変わらない。この項目がない、前の形の保存もある */
  ownerUid?: string | null;
  /** ガイドと話した相談の状態。話していない相談と、前の形の保存にはない */
  guide?: unknown;
  /** 祭りを固定した旅程の状態。この項目がない、前の形の保存もある */
  anchor?: TripAnchor | null;
  anchorPlan?: AnchorPlan | null;
  anchorCheck?: VerificationResult | null;
  cancelledAnchor?: (TripAnchor & { name: string; note: string | null }) | null;
  replay: { sampleId: string; nextTurn: number; itineraryIds?: Record<string, string> } | null;
}

export type ClaimResult =
  | { status: "saved"; trip: StoredTrip }
  /** 旅程がない。ほかの利用者の旅程も、あるかどうかを見せずに同じように扱う */
  | { status: "not_found" };

/** 旅程の持ち主。残した人を先に見る。どちらもいなければ null（だれのものでもない） */
export function tripOwner(trip: Pick<StoredTrip, "ownerUid" | "consultOwnerUid">): string | null {
  return trip.ownerUid ?? trip.consultOwnerUid;
}

/** 共有の URL の ID か（旅程の ID とは頭の文字で分かれる） */
export function isShareId(id: string): boolean {
  return id.startsWith("sh-");
}

/** 旅がもうない（消された）か、自分の旅でないので、旅の下に書けない */
export class TripGoneError extends Error {
  constructor() {
    super("旅がありません");
    this.name = "TripGoneError";
  }
}

/**
 * 1人の利用者の1つの旅に絞った、ガイドのデータの口。置き場は users/{持ち主}/trips/{旅}/{種類}/{ID}。
 * 値は保存した JSON をそのまま戻したもの（スキーマは通していない）。読むときに呼ぶ側でスキーマを通す。
 * 文書の ID の形でない ID は、ないものとして扱う。期限を過ぎた文書は読めない
 */
export interface OwnerTripDocs {
  get(kind: TripDocKind, id: string): Promise<unknown | null>;
  list(kind: TripDocKind): Promise<unknown[]>;
  /**
   * expiresAt は消す時刻（ミリ秒）。省略すると、旅を消すまで残す。
   * 旅がない・自分の旅でないときは書かず、TripGoneError を投げる（発言の途中に消した旅へ書き戻さない）
   */
  put(
    kind: TripDocKind,
    id: string,
    value: unknown,
    options?: { expiresAt?: number },
  ): Promise<void>;
  /** 消したら true */
  delete(kind: TripDocKind, id: string): Promise<boolean>;
}

/** ガイドの使った量（発言の回数と費用の見積もり） */
export interface GuideUsage {
  turns: number;
  costUsd: number;
}

/** 1日の使った量。利用者全体と、1つの旅の分 */
export interface DailyGuideUsage {
  user: GuideUsage;
  trip: GuideUsage;
}

/** 1人の利用者に絞った保存の口。ここを通る読み書きは、その人の旅にしか届かない */
export interface OwnerTripStorage {
  readonly owner: OwnerId;
  /** この人の、この旅のガイドのデータの口。読めない ID の旅は例外にする */
  tripDocs(tripId: string): OwnerTripDocs;
  /** この人のガイドの、その日の使った量（日は YYYY-MM-DD） */
  readGuideUsage(tripId: string, day: string): Promise<DailyGuideUsage>;
  /** ガイドの使った量を足す */
  addGuideUsage(tripId: string, day: string, delta: GuideUsage): Promise<void>;
  /** 相談の中の旅程を、自分の旅として残す（消えないようにする）。ほかの人の旅程は not_found */
  claimTrip(itineraryId: string): Promise<ClaimResult>;
  /** 残した旅の一覧（新しく保存した順） */
  listTrips(): Promise<StoredTrip[]>;
  /** 自分の旅程を読む。version を省くと最新の版。自分のものでなければ null */
  getTrip(itineraryId: string, version?: number): Promise<StoredTripDetail | null>;
  /** 自分の旅程を、すべての版と共有と、ガイドのデータごと消す。消したら true */
  deleteTrip(itineraryId: string): Promise<boolean>;
  /** 自分の旅程をすべて（残す前のものも）、ガイドのデータごと消す。消した、残した旅の数を返す */
  deleteAllTrips(): Promise<number>;
  /**
   * 自分の旅程の最新の版を、推測できない ID で30日だけ共有する。自分のものでなければ null。
   * 同じ内容で、期限に余裕のある自分の共有があれば、それを返す。内容が変われば別の共有になる
   */
  createShare(itineraryId: string): Promise<CreatedShare | null>;
}

export interface TripStorage {
  readonly kind: "memory" | "firestore";

  /** 持ち主を決めて、利用者の旅の口を受け取る */
  forOwner(owner: OwnerId): OwnerTripStorage;
  /**
   * 旅程の版を残す。consultOwner は、その旅程を組んだ相談の持ち主（ログインなしなら null）。
   * 残した人は変えない。残されていない旅程は、最後の保存から30日で消える
   */
  saveItinerary(itinerary: Itinerary, consultOwner: OwnerId | null): Promise<void>;
  /** 共有の ID（sh-…）から、作ってから30日以内の、作ったときの版を読む */
  readShare(shareId: string): Promise<SharedItinerary | null>;
  /** 持ち主のない旅程の最新の版を、最後の保存から30日以内なら読む。持ち主のある旅程は null */
  readUnowned(itineraryId: string): Promise<SharedItinerary | null>;

  /** 一度書いた持ち主は、持ち主のない書き込みでも、別の持ち主の書き込みでも変わらない */
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
