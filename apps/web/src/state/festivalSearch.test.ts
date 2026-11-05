import {
  FestivalSearchRequestSchema,
  type FestivalSearchResponse,
  type FestivalSearchResult,
  MAX_EXCLUDED_FESTIVALS,
  MAX_FESTIVAL_WISH_LENGTH,
  PREFECTURES,
} from "@matsuri-ikoka/schema";
import { fictionalSource } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { ja } from "../i18n/ja";
import { AUTO, type Prefecture, REGIONS, type Region } from "./consult";
import { clientError } from "./errors";
import {
  anchorOf,
  answersFromConditions,
  applySearchResponse,
  backToResults,
  beginMore,
  beginNext,
  beginSearch,
  canReachFestivalStep,
  chooseResult,
  editConditions,
  type FestivalSearchAnswers,
  type FestivalSearchState,
  failSearch,
  finishHere,
  furthestFestivalStep,
  INITIAL_FESTIVAL_SEARCH,
  isSearching,
  nextFestivalStep,
  prefectureName,
  previousFestivalStep,
  searchConditions,
  searchRequest,
  selectedPrefectures,
  setSeason,
  setWish,
  shownIds,
  toggleArea,
  toggleKind,
} from "./festivalSearch";

function result(index: number): FestivalSearchResult {
  return {
    candidate: {
      festivalId: `kasou-matsuri-${index}`,
      name: `架空の祭り${index}`,
      date: "2030-08-16",
      start: null,
      end: null,
      venueName: "架空の広場",
      place: "架空県架空町",
      daysFromWish: 0,
      confidence: "official",
      confirmed: false,
      highlight: "灯籠が川を流れる",
      source: fictionalSource("kasou"),
    },
    matchedKinds: [],
    reasons: [],
    wishFit: null,
  };
}

function reply(overrides: Partial<FestivalSearchResponse> = {}): FestivalSearchResponse {
  return { results: [], remaining: 0, nearMatches: [], next: [], reading: null, ...overrides };
}

const EMPTY: FestivalSearchAnswers = INITIAL_FESTIVAL_SEARCH.answers;

describe("聞き取りの答え", () => {
  it("種類はいくつでも選べ、おまかせはほかと同時に選ばない", () => {
    let answers = toggleKind(EMPTY, "fireworks");
    answers = toggleKind(answers, "hidden");
    expect(answers.kinds).toEqual(["fireworks", "hidden"]);
    answers = toggleKind(answers, "fireworks");
    expect(answers.kinds).toEqual(["hidden"]);
    answers = toggleKind(answers, AUTO);
    expect(answers.kinds).toEqual([AUTO]);
    expect(toggleKind(answers, "famous").kinds).toEqual(["famous"]);
  });

  it("地方を外すと、その中の都道府県も外す", () => {
    let answers = toggleArea(EMPTY, "shikoku");
    answers = toggleArea(answers, "p37");
    answers = toggleArea(answers, "kyushu");
    expect(toggleArea(answers, "shikoku").area).toEqual(["kyushu"]);
  });

  it("自由記述は上限で切る", () => {
    const long = "あ".repeat(MAX_FESTIVAL_WISH_LENGTH + 10);
    expect(setWish(EMPTY, long).wish).toHaveLength(MAX_FESTIVAL_WISH_LENGTH);
  });

  it("答えた段階までしか進めない。その他の希望は書かなくてもよい", () => {
    expect(furthestFestivalStep(EMPTY)).toBe("kinds");
    expect(canReachFestivalStep("season", EMPTY)).toBe(false);
    let answers = toggleKind(EMPTY, AUTO);
    expect(furthestFestivalStep(answers)).toBe("season");
    answers = setSeason(answers, "autumn");
    expect(furthestFestivalStep(answers)).toBe("area");
    answers = toggleArea(answers, AUTO);
    expect(furthestFestivalStep(answers)).toBe("wish");
    expect(canReachFestivalStep("wish", answers)).toBe(true);
  });

  it("段階の前後。端では null", () => {
    expect(previousFestivalStep("kinds")).toBeNull();
    expect(previousFestivalStep("season")).toBe("kinds");
    expect(nextFestivalStep("area")).toBe("wish");
    expect(nextFestivalStep("wish")).toBeNull();
  });
});

describe("条件", () => {
  it("都道府県のコードは、祭りのデータの名前と同じ順に並ぶ", () => {
    const codes = (Object.keys(REGIONS) as Region[]).flatMap(
      (region) => REGIONS[region] as readonly Prefecture[],
    );
    expect(codes).toHaveLength(PREFECTURES.length);
    for (const code of codes) {
      expect(prefectureName(code)).toBe(ja.consult.prefectures[code]);
    }
  });

  it("地方だけならすべての県、都道府県まで選べばその県だけ、おまかせは全国", () => {
    expect(selectedPrefectures(["shikoku"])).toEqual(["徳島県", "香川県", "愛媛県", "高知県"]);
    expect(selectedPrefectures(["shikoku", "p37", "hokkaido"])).toEqual(["北海道", "香川県"]);
    expect(selectedPrefectures([AUTO])).toEqual([]);
  });

  it("おまかせは条件にしない。種類はスキーマの順に並べる", () => {
    expect(
      searchConditions({
        kinds: ["famous", "fireworks"],
        season: "winter",
        area: ["hokkaido"],
        wish: "",
      }),
    ).toEqual({ kinds: ["fireworks", "famous"], season: "winter", prefectures: ["北海道"] });
    expect(searchConditions({ kinds: [AUTO], season: AUTO, area: [AUTO], wish: "" })).toEqual({
      kinds: [],
      season: null,
      prefectures: [],
    });
  });

  it("検索の本文はスキーマに合い、自由記述は書いたときだけ付ける", () => {
    const answers: FestivalSearchAnswers = {
      kinds: ["community"],
      season: "summer",
      area: ["tohoku", "p05"],
      wish: "  夜の灯り  ",
    };
    const state = { answers, results: [result(1)] };
    const request = searchRequest(state, "s-1");
    expect(FestivalSearchRequestSchema.parse(request)).toEqual(request);
    expect(request).toMatchObject({
      prefectures: ["秋田県"],
      wish: "夜の灯り",
      excludeIds: ["kasou-matsuri-1"],
    });
    expect(
      searchRequest({ answers: { ...answers, wish: " " }, results: [] }, "s-1"),
    ).not.toHaveProperty("wish");
  });

  it("出さない祭りは上限までしか送らない", () => {
    const results = Array.from({ length: MAX_EXCLUDED_FESTIVALS + 5 }, (_, index) => result(index));
    const { excludeIds } = searchRequest({ answers: EMPTY, results }, "s-1");
    expect(excludeIds).toHaveLength(MAX_EXCLUDED_FESTIVALS);
    expect(excludeIds.at(-1)).toBe(`kasou-matsuri-${MAX_EXCLUDED_FESTIVALS + 4}`);
  });

  it("条件を答えの形に戻せる", () => {
    const answers = answersFromConditions(
      {
        kinds: [],
        season: null,
        prefectures: ["北海道", "徳島県", "香川県", "愛媛県", "高知県", "秋田県"],
      },
      "夜",
    );
    expect(answers).toEqual({
      kinds: [AUTO],
      season: AUTO,
      area: ["hokkaido", "tohoku", "p05", "shikoku"],
      wish: "夜",
    });
    expect(searchConditions(answers).prefectures.sort()).toEqual(
      ["北海道", "徳島県", "香川県", "愛媛県", "高知県", "秋田県"].sort(),
    );
    expect(
      answersFromConditions({ kinds: [], season: "spring", prefectures: [] }, "").area,
    ).toEqual([AUTO]);
  });
});

describe("探す", () => {
  const asked: FestivalSearchState = {
    ...INITIAL_FESTIVAL_SEARCH,
    step: "wish",
    answers: { kinds: [AUTO], season: AUTO, area: [AUTO], wish: "" },
  };

  it("初めの検索は前の結果を消し、結果が届いたら一覧を開く", () => {
    const stale = { ...asked, results: [result(9)], error: clientError("timeout") };
    const searching = beginSearch(stale);
    expect(searching).toMatchObject({ phase: "searching", results: [], error: null });
    expect(isSearching(searching)).toBe(true);

    const shown = applySearchResponse(searching, reply({ results: [result(1)], remaining: 2 }));
    expect(shown).toMatchObject({ phase: "results", resultsOpen: true, remaining: 2 });
    expect(shownIds(shown)).toEqual(["kasou-matsuri-1"]);
    expect(isSearching(shown)).toBe(false);
  });

  it("続きは後ろに足し、同じ祭りは重ねない", () => {
    const first = applySearchResponse(beginSearch(asked), reply({ results: [result(1)] }));
    const more = beginMore(first);
    expect(isSearching(more)).toBe(true);
    const shown = applySearchResponse(more, reply({ results: [result(1), result(2)] }));
    expect(shownIds(shown)).toEqual(["kasou-matsuri-1", "kasou-matsuri-2"]);
    expect(shown.loadingMore).toBe(false);
  });

  it("0件なら、外れている点つきの祭りと次の手を持つ", () => {
    const shown = applySearchResponse(
      beginSearch(asked),
      reply({
        nearMatches: [{ result: result(1), miss: "夏の開催です" }],
        next: [{ kind: "edit_conditions", label: "条件を選び直す", conditions: null, found: null }],
      }),
    );
    expect(shown.results).toEqual([]);
    expect(shown.nearMatches).toHaveLength(1);
    expect(shown.next).toHaveLength(1);
    // 外れている祭りは見せた祭りに数えない（次の手の数え方と合わせる）
    expect(shownIds(shown)).toEqual([]);
  });

  it("次の手は条件を答えに移し、見せた祭りを残す", () => {
    const first = applySearchResponse(beginSearch(asked), reply({ results: [result(1)] }));
    const next = beginNext(first, { kinds: ["hidden"], season: "autumn", prefectures: [] });
    expect(next.answers).toMatchObject({ kinds: ["hidden"], season: "autumn", area: [AUTO] });
    expect(next.results).toHaveLength(1);
    expect(next.loadingMore).toBe(true);
  });

  it("失敗：初めの検索は最後の段階へ、続きは結果を残す", () => {
    const failure = clientError("timeout");
    expect(failSearch(beginSearch(asked), failure)).toMatchObject({
      phase: "asking",
      step: "wish",
      error: failure,
    });
    const first = applySearchResponse(beginSearch(asked), reply({ results: [result(1)] }));
    expect(failSearch(beginMore(first), failure)).toMatchObject({
      phase: "results",
      loadingMore: false,
      error: failure,
    });
  });

  it("条件を選び直すと、答えを残して段階へ戻る", () => {
    const first = applySearchResponse(beginSearch(asked), reply({ results: [result(1)] }));
    expect(editConditions(first)).toMatchObject({
      phase: "asking",
      step: "kinds",
      resultsOpen: false,
      answers: asked.answers,
    });
    expect(editConditions(first, "wish").step).toBe("wish");
  });
});

describe("決める", () => {
  const shown = applySearchResponse(
    beginSearch(INITIAL_FESTIVAL_SEARCH),
    reply({ results: [result(1), result(2)] }),
  );

  it("選ぶと一覧を閉じ、ほかの祭りを見ると結果を残したまま戻る", () => {
    const chosen = chooseResult(shown, result(2));
    expect(chosen).toMatchObject({ phase: "decide", resultsOpen: false });
    expect(chosen.chosen?.candidate.festivalId).toBe("kasou-matsuri-2");
    const back = backToResults(chosen);
    expect(back).toMatchObject({ phase: "results", resultsOpen: true, chosen: null });
    expect(back.results).toHaveLength(2);
  });

  it("ここで終えるのは、祭りを選んでいるときだけ", () => {
    expect(finishHere(shown).phase).toBe("results");
    expect(finishHere(chooseResult(shown, result(1))).phase).toBe("finished");
  });

  it("選んだ祭りは、祭りの ID と開催日の形で残す", () => {
    expect(anchorOf(result(3))).toEqual({ festivalId: "kasou-matsuri-3", date: "2030-08-16" });
  });
});
