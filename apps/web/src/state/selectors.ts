import {
  type ConversationStage,
  collectItinerarySources,
  type Festival,
  type ItineraryItem,
  type Source,
} from "@matsuri-ikoka/schema";
import type { AppData } from "./types";
import { QUEST_IDS } from "./types";

// ストアから画面に出す形を取り出す。部品はここを通して読む。

export type ItemChange = "added" | "changed" | null;

/**
 * 予定が前の版から変わったか。初版（前の版がない）では色を付けない。
 * 差分に載っている予定だけを色で示す。
 */
export function itemChange(state: Pick<AppData, "itinerary">, item: ItineraryItem): ItemChange {
  const { diff } = state.itinerary;
  if (diff === null || diff.fromVersion === 0) {
    return null;
  }
  if (diff.added.includes(item.id)) {
    return "added";
  }
  if (diff.changed.includes(item.id)) {
    return "changed";
  }
  return null;
}

/** 出典のタブとしおりに出す出典。旅程・再確認・候補の出典を、URL の重複を除いて集める */
export function usedSources(state: Pick<AppData, "itinerary" | "verify" | "candidates">): Source[] {
  const list: Source[] = [];
  if (state.itinerary.current !== null) {
    list.push(...collectItinerarySources(state.itinerary.current));
  } else {
    list.push(...state.candidates.map((candidate) => candidate.source));
  }
  list.push(...state.verify.sources);
  const byUrl = new Map<string, Source>();
  for (const source of list) {
    if (!byUrl.has(source.url)) {
      byUrl.set(source.url, source);
    }
  }
  return [...byUrl.values()];
}

/** 旅程の主役の祭りのデータ（読み込めていなければ null） */
export function mainFestival(state: Pick<AppData, "itinerary" | "festivals">): Festival | null {
  const id = state.itinerary.current?.mainFestivalId;
  return id === undefined ? null : (state.festivals[id] ?? null);
}

/** しおりを開けるか。確定前の再確認で「予定どおり」と分かり、会話がしおりまで進んだとき */
export function shioriReady(state: Pick<AppData, "session" | "verify" | "itinerary">): boolean {
  return (
    state.itinerary.current !== null &&
    state.session.stage === "shiori" &&
    state.verify.result === "as_planned"
  );
}

/** 3つのクエストがそろったか */
export function allQuestsDone(state: Pick<AppData, "quests">): boolean {
  return QUEST_IDS.every((id) => state.quests[id].status === "done");
}

/** 相談の進み具合の段（ヘッダーに出す）。修正は旅程の段に、確認はしおりの前の段に含める */
export const PROGRESS_STEPS = [
  "hearing",
  "candidates",
  "itinerary",
  "verifying",
  "shiori",
] as const;
export type ProgressStep = (typeof PROGRESS_STEPS)[number];

export function progressStep(stage: ConversationStage): ProgressStep {
  return stage === "revising" ? "itinerary" : stage;
}

export interface ConditionChip {
  key: "date" | "origin" | "stay" | "party" | "move";
  /** 表示の材料。文言は部品の側で辞書から組み立てる */
  value: string;
}

/** 条件のチップ。読み取れた条件の順に並べ、まだ分からないものは出さない */
export function conditionChips(state: Pick<AppData, "session" | "preferences">): ConditionChip[] {
  const { conditions } = state.session;
  const chips: ConditionChip[] = [];
  if (conditions.when !== undefined) {
    chips.push({
      key: "date",
      value:
        conditions.when.kind === "date"
          ? conditions.when.date
          : `${conditions.when.from}/${conditions.when.to}`,
    });
  }
  if (conditions.origin !== undefined) {
    chips.push({ key: "origin", value: conditions.origin });
  }
  if (conditions.stay !== undefined) {
    chips.push({ key: "stay", value: conditions.stay });
  }
  if (conditions.party !== undefined) {
    chips.push({
      key: "party",
      value: `${conditions.party.adults}/${conditions.party.children}`,
    });
  }
  // 移動手段はこだわりで決まる。何か1つでも条件が読み取れてから出す
  if (chips.length > 0) {
    chips.push({ key: "move", value: state.preferences.move });
  }
  return chips;
}
