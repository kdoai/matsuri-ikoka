import {
  type GuideMemoItem,
  GuideMemoItemSchema,
  type GuideNotice,
  GuideNoticeSchema,
  type GuideProposal,
  GuideProposalSchema,
  type IsoDate,
  type Itinerary,
  MAX_MEMO_ITEMS,
  type TripWatch,
  TripWatchSchema,
} from "@matsuri-ikoka/schema";
import { errorForLog } from "../log";
import type { GuideTripRead, StoragePersistence } from "../session/persistence";
import type { ItineraryStore, Session, SessionGuide } from "../session/sessionStore";
import type { OwnerId } from "../storage/owner";
import { type OwnerTripDocs, TRIP_WATCH_DOC_ID } from "../storage/types";
import type { GuideUsageLedger } from "./limits";

// ガイドが読み書きする、1つの旅のデータ（docs/spec/guide.md の「データの保存と消し方」）。
// - 残した旅：旅の下（users/{持ち主}/trips/{旅}/…）。持ち主で絞った保存の口だけで読み書きする
// - ログインしていない相談と、残す前の旅：相談の中だけ。相談といっしょに消える
// 呼ぶ側は、どちらに置いてあるかを知らない。読んだものはスキーマを通し、形の違うものは読まない。

export const TRIP_DATA_TTL_AFTER_TRIP_MS = 30 * 24 * 60 * 60 * 1000;

export interface TripGuideData {
  watch(): Promise<TripWatch | null>;
  putWatch(watch: TripWatch): Promise<void>;
  /** 新しい順 */
  notices(): Promise<GuideNotice[]>;
  putNotice(notice: GuideNotice): Promise<void>;
  proposals(): Promise<GuideProposal[]>;
  putProposal(proposal: GuideProposal): Promise<void>;
  /** 作った順 */
  memo(): Promise<GuideMemoItem[]>;
  putMemo(item: GuideMemoItem): Promise<void>;
  deleteMemo(id: string): Promise<boolean>;
}

/** ガイドが読む旅。旅程は保存の口から読んだ、いまの版 */
export interface GuideTrip {
  itinerary: Itinerary;
  data: TripGuideData;
}

const newestFirst = (a: GuideNotice, b: GuideNotice) =>
  Date.parse(b.createdAt) - Date.parse(a.createdAt);
const oldestFirst = (a: GuideMemoItem, b: GuideMemoItem) =>
  Date.parse(a.createdAt) - Date.parse(b.createdAt);

/** 旅の最終日から30日後の時刻（通知と提案を消す時刻） */
export function tripDataExpiresAt(itinerary: Itinerary): number {
  const lastDay = itinerary.days.at(-1)?.date;
  return Date.parse(`${lastDay}T23:59:59+09:00`) + TRIP_DATA_TTL_AFTER_TRIP_MS;
}

/**
 * 残した旅のデータ。旅の下に置く。通知と提案は旅の最終日から30日で消える。
 * expiresAt を null にすると、旅を消すまで残す（mock：記録の旅の日付は実際の今日と関係がない）
 */
export function storedGuideData(
  docs: OwnerTripDocs,
  itinerary: Itinerary,
  expiresAt: number | null = tripDataExpiresAt(itinerary),
): TripGuideData {
  const retention = expiresAt === null ? {} : { expiresAt };
  const parsedList = async <T>(
    kind: "notices" | "proposals" | "memo",
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  ): Promise<T[]> =>
    (await docs.list(kind)).flatMap((value) => {
      const parsed = schema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });
  return {
    watch: async () => {
      const parsed = TripWatchSchema.safeParse(await docs.get("watch", TRIP_WATCH_DOC_ID));
      return parsed.success ? parsed.data : null;
    },
    putWatch: (watch) => docs.put("watch", TRIP_WATCH_DOC_ID, watch),
    notices: async () => (await parsedList("notices", GuideNoticeSchema)).sort(newestFirst),
    putNotice: (notice) => docs.put("notices", notice.id, notice, retention),
    proposals: () => parsedList("proposals", GuideProposalSchema),
    putProposal: (proposal) => docs.put("proposals", proposal.id, proposal, retention),
    memo: async () => (await parsedList("memo", GuideMemoItemSchema)).sort(oldestFirst),
    putMemo: (item) => docs.put("memo", item.id, item),
    deleteMemo: (id) => docs.delete("memo", id),
  };
}

/** 同じ ID なら置き換え、なければ足す */
function upsert<T extends { id: string }>(list: T[], item: T): void {
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index === -1) list.push(item);
  else list[index] = item;
}

/** ログインしていない相談と、残す前の旅のデータ。相談の間だけ持つ */
export function sessionGuideData(guide: SessionGuide): TripGuideData {
  return {
    watch: async () => guide.watch,
    putWatch: async (watch) => {
      guide.watch = watch;
    },
    notices: async () => [...guide.notices].sort(newestFirst),
    putNotice: async (notice) => upsert(guide.notices, notice),
    proposals: async () => [...guide.proposals],
    putProposal: async (proposal) => upsert(guide.proposals, proposal),
    memo: async () => [...guide.memo].sort(oldestFirst),
    putMemo: async (item) => upsert(guide.memo, item),
    deleteMemo: async (id) => {
      const before = guide.memo.length;
      guide.memo = guide.memo.filter((item) => item.id !== id);
      return guide.memo.length !== before;
    },
  };
}

/**
 * 相談の中に持っていたデータを、旅の下へ移す（ログインしていない相談にログインして旅を残したとき）。
 * 移せなければ相談の中に残し、次にまた試す
 */
async function moveToTrip(guide: SessionGuide, data: TripGuideData): Promise<boolean> {
  const held =
    guide.memo.length + guide.notices.length + guide.proposals.length > 0 || guide.watch !== null;
  if (!held) return false;
  const room = MAX_MEMO_ITEMS - (guide.memo.length === 0 ? 0 : (await data.memo()).length);
  for (const item of guide.memo.slice(0, Math.max(0, room))) await data.putMemo(item);
  for (const notice of guide.notices) await data.putNotice(notice);
  for (const proposal of guide.proposals) await data.putProposal(proposal);
  if (guide.watch !== null) await data.putWatch(guide.watch);
  guide.memo = [];
  guide.notices = [];
  guide.proposals = [];
  guide.watch = null;
  return true;
}

/** ログインしている人の、ガイドの使った量の口。保存の口に残す */
export function ownerUsageLedger(
  persistence: StoragePersistence,
  owner: OwnerId,
  tripId: string,
  day: IsoDate,
): GuideUsageLedger {
  const trips = persistence.forOwner(owner);
  return {
    read: () => trips.readGuideUsage(tripId, day),
    add: (delta) => trips.addGuideUsage(tripId, day, delta),
  };
}

/** 相談の中に持っているデータを消す。消すものがあれば true */
function forgetHeldData(guide: SessionGuide): boolean {
  const held =
    guide.memo.length + guide.notices.length + guide.proposals.length > 0 || guide.watch !== null;
  guide.memo = [];
  guide.notices = [];
  guide.proposals = [];
  guide.watch = null;
  return held;
}

export type GuideTripResult =
  | { status: "ok"; trip: GuideTrip }
  /** 相談にまだ旅程がない */
  | { status: "no_itinerary" }
  /** 旅が消された、または読めない形 */
  | { status: "missing" }
  /** 保存の口が一時的に失敗し、手元の写しもない。あるかどうかが分からない */
  | { status: "unavailable" };

/**
 * 相談の旅を開く。旅は相談から決め、外から指定させない。別のインスタンスで版が増えていることがあるので、
 * 保存の口から読み直す。保存の口が失敗したときは、手元の写しで続ける
 */
export async function openGuideTrip(
  deps: { persistence: StoragePersistence; itineraries: ItineraryStore },
  session: Session,
  options: { keepTripData?: boolean } = {},
): Promise<GuideTripResult> {
  const id = session.itineraryId;
  if (id === null) return { status: "no_itinerary" };
  let read: GuideTripRead;
  try {
    read = await deps.persistence.readGuideTrip(id, session.ownerUid);
  } catch (error) {
    console.error(
      JSON.stringify({ kind: "storage_failed", what: "guide_trip", ...errorForLog(error) }),
    );
    const copy = deps.itineraries.get(id);
    // 消されたのか分からないので、相談の中の手帳は消さない
    if (copy === undefined) return { status: "unavailable" };
    read = { status: "found", itinerary: copy, kept: false };
  }
  if (read.status === "none") {
    // 旅を消したら、相談の中に持っていた手帳も消す（旅の下は、旅を消すときに消える）
    if (forgetHeldData(session.guide)) await deps.persistence.saveSession(session);
    return { status: "missing" };
  }
  // 読めない形の旅程は、消されたとは限らないので、相談の中の手帳は消さない
  if (read.status === "unreadable") return { status: "missing" };
  const { kept } = read;
  // ツールは手元の写しから旅程を読むので、いまの版にそろえる（古い版へは戻さない）
  const itinerary = deps.itineraries.rememberLatest(read.itinerary);
  if (!kept || session.ownerUid === null) {
    return { status: "ok", trip: { itinerary, data: sessionGuideData(session.guide) } };
  }
  const data = storedGuideData(
    deps.persistence.forOwner(session.ownerUid).tripDocs(id),
    itinerary,
    options.keepTripData ? null : tripDataExpiresAt(itinerary),
  );
  try {
    if (await moveToTrip(session.guide, data)) await deps.persistence.saveSession(session);
  } catch (error) {
    console.error(
      JSON.stringify({ kind: "storage_failed", what: "guide_move", ...errorForLog(error) }),
    );
  }
  return { status: "ok", trip: { itinerary, data } };
}
