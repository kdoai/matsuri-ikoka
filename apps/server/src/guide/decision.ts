import {
  type GuideProposal,
  type Itinerary,
  ItinerarySchema,
  type TripChange,
  type TripWatch,
  TripWatchSchema,
} from "@matsuri-ikoka/schema";
import { addDays } from "../domain/calendar";
import { diffDays } from "../domain/itinerary";
import { proposalContentHash } from "./proposal";

// 提案の承認・却下、前の版に戻す、見回りの開始と停止を、どう扱うかを決める（docs/spec/guide.md の「組み直しの提案」）。
// 保存の口に触れず、受け取った値だけで決める。適用と保存は経路（routes/guide.ts）が行う。

/**
 * 承認の扱い。apply 今の旅程に当てる / applied もう当ててある（同じ結果を返す）/ rejected もう断ってある /
 * stale 提案のあとに旅程が変わった、または見た提案と違う / expired 期限が過ぎた。
 * mark は、提案の状態をこの結果に書き換えるか（承認を待っていた提案だけ）
 */
export type ApprovalPlan =
  | { kind: "apply" }
  | { kind: "applied"; mark: boolean }
  | { kind: "rejected" }
  | { kind: "stale"; mark: boolean }
  | { kind: "expired"; mark: boolean };

/**
 * 承認をどう扱うかを決める。版とハッシュを照らし合わせ、提案のあとに旅程が変わっていたり、
 * 期限を過ぎていたりしたら当てない。同じ承認が2回届いたら、2回目は当てずに同じ結果を返す
 */
export function planApproval(
  proposal: GuideProposal,
  seen: { baseVersion: number; contentHash: string },
  current: Itinerary,
  now: string,
): ApprovalPlan {
  const pending = proposal.status === "pending";
  if (proposal.status === "approved") return { kind: "applied", mark: false };
  if (proposal.status === "rejected") return { kind: "rejected" };
  // ほかの旅の提案は当てない
  if (proposal.tripId !== current.id || proposal.itinerary.id !== current.id) {
    return { kind: "stale", mark: pending };
  }
  // 見た提案と違う（画面に古い提案が残っていた）。提案の状態は変えない
  if (seen.baseVersion !== proposal.baseVersion || seen.contentHash !== proposal.contentHash) {
    return { kind: "stale", mark: false };
  }
  // 保存した中身がハッシュと合わなければ、当てない
  if (proposalContentHash(proposal.itinerary) !== proposal.contentHash) {
    return { kind: "stale", mark: pending };
  }
  // 当てたあとに状態を書けなかった。今の旅程がこの提案なら、当ててある
  if (
    current.version === proposal.baseVersion + 1 &&
    proposalContentHash(current) === proposal.contentHash
  ) {
    return { kind: "applied", mark: pending };
  }
  if (proposal.status === "stale" || proposal.baseVersion !== current.version) {
    return { kind: "stale", mark: pending };
  }
  if (proposal.status === "expired" || Date.parse(proposal.expiresAt) <= Date.parse(now)) {
    return { kind: "expired", mark: pending };
  }
  return { kind: "apply" };
}

/** 提案の状態を書き換える。承認と却下のときだけ、決めた時刻を書く */
export function settleProposal(
  proposal: GuideProposal,
  status: "approved" | "rejected" | "stale" | "expired",
  now: string,
): GuideProposal {
  const decided = status === "approved" || status === "rejected";
  return { ...proposal, status, decidedAt: decided ? now : null };
}

/** 承認した提案の、新しい版と差分 */
export function proposalChange(proposal: GuideProposal): TripChange {
  return { itinerary: proposal.itinerary, diff: proposal.diff };
}

/**
 * 前の版に戻した旅程を、新しい版として作る。戻す操作も版として残し、履歴を消さない。
 * 予定ごとの「最後に変わった版」と差分は、今の旅程から計算し直す
 */
export function revertedItinerary(current: Itinerary, target: Itinerary): TripChange {
  const version = current.version + 1;
  const { days, diff } = diffDays(
    current,
    target.days.map(({ weather: _weather, ...day }) => day),
    version,
  );
  const itinerary = ItinerarySchema.parse({
    ...target,
    id: current.id,
    version,
    days: days.map((day, index) => ({ ...day, weather: target.days[index]?.weather })),
  });
  return { itinerary, diff };
}

/** 見回りを止める日。旅の最終日の翌日 */
export function watchEndsOn(itinerary: Itinerary): string {
  const lastDay = itinerary.days.at(-1)?.date ?? itinerary.days[0]?.date ?? "";
  return addDays(lastDay, 1);
}

/**
 * 見回りを始める。見回り中ならそのまま返す。止めたものを始め直すときは、調べた時刻を引き継ぐ
 */
export function startedWatch(
  existing: TripWatch | null,
  itinerary: Itinerary,
  now: string,
): TripWatch {
  if (existing?.status === "active") return existing;
  return TripWatchSchema.parse({
    tripId: itinerary.id,
    status: "active",
    startedAt: now,
    endsOn: watchEndsOn(itinerary),
    stoppedAt: null,
    lastCheckedAt: existing?.lastCheckedAt ?? null,
  });
}

/** 見回りを止める。止まっているものは、そのまま返す */
export function stoppedWatch(existing: TripWatch, now: string): TripWatch {
  if (existing.status !== "active") return existing;
  return TripWatchSchema.parse({ ...existing, status: "stopped", stoppedAt: now });
}
