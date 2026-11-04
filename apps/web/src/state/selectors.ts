import {
  collectItinerarySources,
  type Festival,
  type Itinerary,
  type ItineraryItem,
  itineraryItems,
  type PartialTripConditions,
  type Preferences,
  type Source,
  type SpotPin,
  type StaffId,
} from "@matsuri-ikoka/schema";
import type { AppData, ChatEntry } from "./types";

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
/**
 * しおりを開けるか。公式で確かめられた旅程と、確かめられなかった（not_found）が利用者が決めた旅程
 * （しおりに、出発の前に確かめるよう注意を出す）。変更・中止は候補へ戻る
 */
export function shioriReady(state: Pick<AppData, "session" | "verify" | "itinerary">): boolean {
  return (
    state.itinerary.current !== null &&
    state.session.stage === "shiori" &&
    (state.verify.result === "as_planned" || state.verify.result === "not_found")
  );
}

export interface ConditionChip {
  key: "date" | "origin" | "nights" | "party" | "move";
  /** 表示の材料。文言は部品の側で辞書から組み立てる */
  value: string;
}

/**
 * 条件のチップ。読み取れた条件の順に並べ、まだ分からないものは出さない。
 * 呼ぶたびに新しい配列を返すので、部品では useMemo で包む。
 */
export function conditionChips(
  conditions: PartialTripConditions,
  move: Preferences["move"],
): ConditionChip[] {
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
  if (conditions.nights !== undefined) {
    chips.push({ key: "nights", value: String(conditions.nights) });
  }
  if (conditions.party !== undefined) {
    chips.push({
      key: "party",
      value: `${conditions.party.adults}/${conditions.party.children}`,
    });
  }
  // 移動手段はこだわりで決まる。何か1つでも条件が読み取れてから出す
  if (chips.length > 0) {
    chips.push({ key: "move", value: move });
  }
  return chips;
}

export interface MapPoint {
  key: string;
  name: string;
  lat: number;
  lng: number;
  /** venue 主役の祭りの会場 / stop 旅程の予定 / spot 寄り道の候補（旅程に入っていない場所） */
  kind: "venue" | "stop" | "spot";
  /** 旅程の中での順番（1から）。寄り道の候補では null */
  order: number | null;
}

/**
 * 地図に打つ点。旅程の予定を順番どおりに並べ、旅程に入っていない寄り道の候補を後ろに足す。
 * 呼ぶたびに新しい配列を返すので、部品では useMemo で包む。
 */
export function mapPoints(itinerary: Itinerary | null, spots: readonly SpotPin[]): MapPoint[] {
  const points: MapPoint[] = [];
  const usedSpots = new Set<string>();
  let order = 0;
  for (const item of itinerary === null ? [] : itineraryItems(itinerary)) {
    if (item.spotId !== undefined) {
      usedSpots.add(item.spotId);
    }
    if (item.location === null) {
      continue;
    }
    order += 1;
    const venue = item.type === "festival" && item.festivalId === itinerary?.mainFestivalId;
    points.push({
      key: `item-${item.id}`,
      name: item.name,
      ...item.location,
      kind: venue ? "venue" : "stop",
      order,
    });
  }
  for (const spot of spots) {
    if (!usedSpots.has(spot.spotId)) {
      points.push({
        key: `spot-${spot.spotId}`,
        name: spot.name,
        ...spot.location,
        kind: "spot",
        order: null,
      });
    }
  }
  return points;
}

// ---------------------------------------------------------------------------
// 会話の窓

export type DialogueLine =
  /** 店に入ったときのあいさつ */
  | { kind: "greeting" }
  /** 送ったあと、何か届くまで */
  | { kind: "waiting"; userText: string }
  /** スタッフが調べている間の吹き出し（コンシェルジュが話し始める前） */
  | { kind: "work"; staff: StaffId; text: string }
  | { kind: "concierge"; id: string; text: string; streaming: boolean }
  | { kind: "error"; entry: Extract<ChatEntry, { kind: "error" }> };

/**
 * 会話の窓に出す、いまの一言。いちばん新しい発言のあとに届いたものから選ぶ。
 * 返答の途中は、コンシェルジュが話し始めたらその文を、それまではスタッフの作業の吹き出しを出す。
 * 返答のあとは、片付いていないエラーか、コンシェルジュの最後の返答を出す。
 */
export function currentLine(state: Pick<AppData, "messages" | "session">): DialogueLine {
  const { messages } = state;
  const lastUser = messages.findLastIndex((entry) => entry.kind === "user");
  const since = messages.slice(lastUser + 1);
  const error = since.findLast((entry) => entry.kind === "error" && !entry.resolved);
  if (error?.kind === "error" && !state.session.streaming) {
    return { kind: "error", entry: error };
  }
  const reply = since.findLast((entry) => entry.kind === "concierge");
  if (reply?.kind === "concierge") {
    return { kind: "concierge", id: reply.id, text: reply.text, streaming: reply.streaming };
  }
  if (state.session.streaming) {
    const work = since.findLast((entry) => entry.kind === "work");
    if (work?.kind === "work") {
      return { kind: "work", staff: work.staff, text: work.result ?? work.bubble };
    }
    const user = messages[lastUser];
    return { kind: "waiting", userText: user?.kind === "user" ? user.text : "" };
  }
  if (error?.kind === "error") {
    return { kind: "error", entry: error };
  }
  const earlier = messages.findLast((entry) => entry.kind === "concierge");
  return earlier?.kind === "concierge"
    ? { kind: "concierge", id: earlier.id, text: earlier.text, streaming: false }
    : { kind: "greeting" };
}

/** いま動いているスタッフ（待機していない人）。画面の上の「店内のようす」に出す */
export function busyStaff(state: Pick<AppData, "staff">): StaffId[] {
  return (Object.keys(state.staff) as StaffId[]).filter((id) => state.staff[id].phase !== "idle");
}

// ---------------------------------------------------------------------------
// ゲームの画面の上のタブ

export const SECTIONS = ["guide", "candidates", "shiori", "confirm"] as const;
export type Section = (typeof SECTIONS)[number];

/**
 * いま光らせるタブ。開いているもの（候補・パネル）を先に見て、なければ相談の進み具合で決める。
 * 聞き取りと候補は「祭りの候補」、旅程と修正は「旅程の案内」、確定前の確認は「確認」、しおりは「旅のしおり」
 */
export function currentSection(state: Pick<AppData, "ui" | "session">): Section {
  if (state.ui.candidatesOpen) return "candidates";
  if (state.ui.drawerOpen) return state.ui.tab === "sources" ? "confirm" : "guide";
  switch (state.session.stage) {
    case "hearing":
    case "candidates":
      return "candidates";
    case "itinerary":
    case "revising":
      return "guide";
    case "verifying":
      return "confirm";
    case "shiori":
      return "shiori";
  }
}
