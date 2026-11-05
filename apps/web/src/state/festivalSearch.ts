import {
  FESTIVAL_KINDS,
  type FestivalNearMatch,
  type FestivalSearchConditions,
  type FestivalSearchNext,
  type FestivalSearchRequest,
  type FestivalSearchResponse,
  type FestivalSearchResult,
  type FestivalWishReading,
  MAX_EXCLUDED_FESTIVALS,
  MAX_FESTIVAL_WISH_LENGTH,
  PREFECTURES,
  type Season,
  type TripAnchor,
} from "@matsuri-ikoka/schema";
import { AUTO, type Prefecture, prefecturePick, REGIONS, type Region, togglePick } from "./consult";
import type { ClientError } from "./types";

// 祭りから探す相談（docs/spec/festival-search.md）。種類 → 季節 → 地域 → その他の希望 の順に聞き、
// 探した祭りを見比べて1つ決めるまでを、ストアの値からストアの値への純粋な関数にする。
// 祭りの有無と並びはサーバーが決める。ここでは条件を組み立て、届いた結果を積むだけ。

export const FESTIVAL_SEARCH_STEPS = ["kinds", "season", "area", "wish"] as const;
export type FestivalSearchStep = (typeof FESTIVAL_SEARCH_STEPS)[number];

/** asking 聞いている / searching 探している / results 結果を見ている / decide 決めた祭りをどうするか / finished ここで終えた */
export type FestivalSearchPhase = "asking" | "searching" | "results" | "decide" | "finished";

export type SeasonAnswer = Season | typeof AUTO;

export interface FestivalSearchAnswers {
  /** 種類（いくつでも）。AUTO は「おまかせ」 */
  kinds: string[];
  /** 季節（1つ）。AUTO は「おまかせ」、null はまだ答えていない */
  season: SeasonAnswer | null;
  /** 地域（いくつでも）。地方と都道府県（prefecturePick の値）。AUTO は全国 */
  area: string[];
  wish: string;
}

export interface FestivalSearchState {
  phase: FestivalSearchPhase;
  step: FestivalSearchStep;
  answers: FestivalSearchAnswers;
  /** 見せた祭り（出した順）。別の祭りを提案してもらうたびに、後ろに足す */
  results: FestivalSearchResult[];
  /** 条件にすべて合う祭りのうち、まだ見せていない数 */
  remaining: number;
  nearMatches: FestivalNearMatch[];
  next: FestivalSearchNext[];
  reading: FestivalWishReading | null;
  /** 結果を出したまま、続きを探しているか */
  loadingMore: boolean;
  /** 結果の一覧を開いているか。閉じても、会話の窓からまた開ける */
  resultsOpen: boolean;
  /** 選んだ祭り */
  chosen: FestivalSearchResult | null;
  error: ClientError | null;
}

export const INITIAL_FESTIVAL_SEARCH: FestivalSearchState = Object.freeze({
  phase: "asking",
  step: "kinds",
  answers: { kinds: [], season: null, area: [], wish: "" },
  results: [],
  remaining: 0,
  nearMatches: [],
  next: [],
  reading: null,
  loadingMore: false,
  resultsOpen: false,
  chosen: null,
  error: null,
}) as FestivalSearchState;

// ---------------------------------------------------------------------------
// 聞き取り

export function toggleKind(answers: FestivalSearchAnswers, pick: string): FestivalSearchAnswers {
  return { ...answers, kinds: togglePick(answers.kinds, pick) };
}

export function setSeason(
  answers: FestivalSearchAnswers,
  season: SeasonAnswer,
): FestivalSearchAnswers {
  return { ...answers, season };
}

export function toggleArea(answers: FestivalSearchAnswers, pick: string): FestivalSearchAnswers {
  return { ...answers, area: togglePick(answers.area, pick) };
}

export function setWish(answers: FestivalSearchAnswers, wish: string): FestivalSearchAnswers {
  return { ...answers, wish: wish.slice(0, MAX_FESTIVAL_WISH_LENGTH) };
}

/** その段階に答えたか。その他の希望は書かなくてもよい */
export function isFestivalStepDone(
  answers: FestivalSearchAnswers,
  step: FestivalSearchStep,
): boolean {
  switch (step) {
    case "kinds":
      return answers.kinds.length > 0;
    case "season":
      return answers.season !== null;
    case "area":
      return answers.area.length > 0;
    case "wish":
      return true;
  }
}

/** 進める段階の終わり。そこまでは ＜＞ で行き来できる */
export function furthestFestivalStep(answers: FestivalSearchAnswers): FestivalSearchStep {
  return FESTIVAL_SEARCH_STEPS.find((step) => !isFestivalStepDone(answers, step)) ?? "wish";
}

export function canReachFestivalStep(
  step: FestivalSearchStep,
  answers: FestivalSearchAnswers,
): boolean {
  return (
    FESTIVAL_SEARCH_STEPS.indexOf(step) <=
    FESTIVAL_SEARCH_STEPS.indexOf(furthestFestivalStep(answers))
  );
}

/** 次の段階。最後の段階なら null */
export function nextFestivalStep(step: FestivalSearchStep): FestivalSearchStep | null {
  return FESTIVAL_SEARCH_STEPS[FESTIVAL_SEARCH_STEPS.indexOf(step) + 1] ?? null;
}

/** 前の段階。最初の段階なら null（入口へ戻る） */
export function previousFestivalStep(step: FestivalSearchStep): FestivalSearchStep | null {
  return FESTIVAL_SEARCH_STEPS[FESTIVAL_SEARCH_STEPS.indexOf(step) - 1] ?? null;
}

// ---------------------------------------------------------------------------
// 条件

/** 都道府県のコードを、祭りのデータの名前にする（PREFECTURES はコードの順） */
export function prefectureName(code: Prefecture): (typeof PREFECTURES)[number] {
  return PREFECTURES[Number(code) - 1] as (typeof PREFECTURES)[number];
}

function regionPrefectures(region: Region): readonly Prefecture[] {
  return REGIONS[region];
}

/**
 * 地域の答えを、都道府県の名前の並びにする。都道府県まで選んだ地方はその県だけ、
 * 地方だけを選んだら地方のすべての県。おまかせは全国（空の並び）
 */
export function selectedPrefectures(area: readonly string[]): (typeof PREFECTURES)[number][] {
  if (area.includes(AUTO)) return [];
  return (Object.keys(REGIONS) as Region[]).flatMap((region) => {
    if (!area.includes(region)) return [];
    const codes = regionPrefectures(region);
    const picked = codes.filter((code) => area.includes(prefecturePick(code)));
    return (picked.length === 0 ? codes : picked).map(prefectureName);
  });
}

export function searchConditions(answers: FestivalSearchAnswers): FestivalSearchConditions {
  return {
    kinds: FESTIVAL_KINDS.filter((kind) => answers.kinds.includes(kind)),
    season: answers.season === null || answers.season === AUTO ? null : answers.season,
    prefectures: selectedPrefectures(answers.area),
  };
}

/** 探した条件を、聞き取りの答えの形に戻す。次の手で変えた条件を、選び直すときにそのまま見せる */
export function answersFromConditions(
  conditions: FestivalSearchConditions,
  wish: string,
): FestivalSearchAnswers {
  const chosen = new Set<string>(conditions.prefectures);
  const area = (Object.keys(REGIONS) as Region[]).flatMap((region) => {
    const codes = regionPrefectures(region);
    const picked = codes.filter((code) => chosen.has(prefectureName(code)));
    if (picked.length === 0) return [];
    return picked.length === codes.length ? [region] : [region, ...picked.map(prefecturePick)];
  });
  return {
    kinds: conditions.kinds.length === 0 ? [AUTO] : [...conditions.kinds],
    season: conditions.season ?? AUTO,
    area: area.length === 0 ? [AUTO] : area,
    wish,
  };
}

/** 見せた祭りの ID */
export function shownIds(state: Pick<FestivalSearchState, "results">): string[] {
  return state.results.map((result) => result.candidate.festivalId);
}

/** いまの答えと見せた祭りから、検索の本文を作る */
export function searchRequest(
  state: Pick<FestivalSearchState, "answers" | "results">,
  sessionId: string,
): FestivalSearchRequest {
  const wish = state.answers.wish.trim();
  return {
    sessionId,
    ...searchConditions(state.answers),
    ...(wish === "" ? {} : { wish }),
    excludeIds: shownIds(state).slice(-MAX_EXCLUDED_FESTIVALS),
  };
}

// ---------------------------------------------------------------------------
// 探す

/** 答えた条件で初めから探す。前の結果は消す */
export function beginSearch(state: FestivalSearchState): FestivalSearchState {
  return {
    ...INITIAL_FESTIVAL_SEARCH,
    phase: "searching",
    step: state.step,
    answers: state.answers,
  };
}

/** 別の祭りを提案してもらう。見せた祭りは残し、続きを足す */
export function beginMore(state: FestivalSearchState): FestivalSearchState {
  return { ...state, loadingMore: true, error: null };
}

/** 次の手で条件を変えて探す。見せた祭りは残し、まだ見せていない祭りを足す */
export function beginNext(
  state: FestivalSearchState,
  conditions: FestivalSearchConditions,
): FestivalSearchState {
  return {
    ...state,
    answers: answersFromConditions(conditions, state.answers.wish),
    loadingMore: true,
    error: null,
  };
}

/** 探している最中か（同じ検索を重ねて送らない） */
export function isSearching(state: Pick<FestivalSearchState, "phase" | "loadingMore">): boolean {
  return state.phase === "searching" || state.loadingMore;
}

export function applySearchResponse(
  state: FestivalSearchState,
  response: FestivalSearchResponse,
): FestivalSearchState {
  const seen = new Set(shownIds(state));
  return {
    ...state,
    phase: "results",
    results: [
      ...state.results,
      ...response.results.filter((result) => !seen.has(result.candidate.festivalId)),
    ],
    remaining: response.remaining,
    nearMatches: response.nearMatches,
    next: response.next,
    reading: response.reading,
    loadingMore: false,
    resultsOpen: true,
    error: null,
  };
}

/** 探すのに失敗した。初めの検索なら最後の段階に戻し、続きなら結果を残す */
export function failSearch(state: FestivalSearchState, error: ClientError): FestivalSearchState {
  return state.phase === "searching"
    ? { ...state, phase: "asking", step: "wish", error }
    : { ...state, loadingMore: false, error };
}

/** 条件を選び直す。答えは残し、最初の段階から聞く（step を渡せば、その段階から） */
export function editConditions(
  state: FestivalSearchState,
  step: FestivalSearchStep = "kinds",
): FestivalSearchState {
  return { ...state, phase: "asking", step, resultsOpen: false, chosen: null, error: null };
}

// ---------------------------------------------------------------------------
// 決める

export function chooseResult(
  state: FestivalSearchState,
  result: FestivalSearchResult,
): FestivalSearchState {
  return { ...state, phase: "decide", chosen: result, resultsOpen: false, error: null };
}

/** 「ほかの祭りを見る」：結果の一覧へ戻る */
export function backToResults(state: FestivalSearchState): FestivalSearchState {
  return { ...state, phase: "results", chosen: null, resultsOpen: true };
}

/** 「ここで終わる」：モデルを呼ばず、祭りの要点を出して終える */
export function finishHere(state: FestivalSearchState): FestivalSearchState {
  return state.chosen === null ? state : { ...state, phase: "finished" };
}

/** 選んだ祭りを、必ず行く場所の形にする。行く日は候補の開催日 */
export function anchorOf(result: FestivalSearchResult): TripAnchor {
  return { festivalId: result.candidate.festivalId, date: result.candidate.date };
}
