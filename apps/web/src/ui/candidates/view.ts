import type { FestivalCandidate } from "@matsuri-ikoka/schema";
import type { PostcardTag } from "../../state/postcards";

// 祭りの候補の画面の、表示の決まり：カード表示とリスト表示、選べるかどうか、カードの面に出すタグ。

export const CANDIDATE_VIEWS = ["cards", "list"] as const;
export type CandidateView = (typeof CANDIDATE_VIEWS)[number];

/** 覚えておいた表示を読む。知らない値や、覚えていなければカード表示 */
export function parseCandidateView(stored: string | null): CandidateView {
  return CANDIDATE_VIEWS.find((view) => view === stored) ?? "cards";
}

/** 「この祭りにする」を押せない理由。押せるときは null */
export type ChooseBlock = "unconfirmed" | "busy";

/** 公式以外の情報源や例年の日程で開催を確かめた候補（要事前確認。選べるが、出発の前に確かめる） */
export function needsCheck(candidate: Pick<FestivalCandidate, "check">): boolean {
  return candidate.check?.result === "needs_check";
}

export function chooseBlock(candidate: FestivalCandidate, streaming: boolean): ChooseBlock | null {
  // 開催の情報が確かめられていない祭りは、確定した旅程に入れられない（要事前確認の祭りは選べる）
  if (!candidate.confirmed && !needsCheck(candidate)) return "unconfirmed";
  if (streaming) return "busy";
  return null;
}

/** カードの面に並べるタグ。「ご希望の日」は日付の札で出すので重ねない */
export function faceTags(tags: readonly PostcardTag[]): PostcardTag[] {
  return tags.filter((tag) => tag !== "wishDay");
}
