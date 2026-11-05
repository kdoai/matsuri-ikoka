import { type AnchorPlan, AnchorPlanRequestSchema, MAX_ROUTE_AREAS } from "@matsuri-ikoka/schema";
import { fictionalFestival } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { ja } from "../i18n/ja";
import {
  anchorDays,
  anchorMessage,
  anchorPlanRequest,
  anchorPreviewKey,
  anchorToSend,
  anchorWishes,
  applyPreview,
  beginAnchoredHearing,
  chooseAnchorDay,
  currentPreview,
  failPreview,
  leaveAnchor,
  planDatesDiffer,
  selectableAnchorDay,
  setAnchorNights,
  setAnchorRange,
  tooManyWishes,
  underMinNights,
  visitsByStatus,
} from "./anchorTrip";
import {
  type ConsultState,
  canReach,
  composeConsultMessage,
  furthestStep,
  hearingSteps,
  INITIAL_CONSULT,
  leaveHearing,
  nextStep,
  pickAnswer,
  previousStep,
  setAnswerText,
  setRange,
  setStay,
  stepAfterAnswer,
} from "./consult";
import { clientError } from "./errors";
import { returnToResults } from "./festivalSearch";

const ANCHOR = { festivalId: "kasou-matsuri", date: "2030-08-16" };
const wording = ja.consult.wording;

function occurrence(date: string, over: Record<string, unknown> = {}) {
  return {
    date,
    start: "18:00",
    end: "21:00",
    status: "announced" as const,
    rainPolicy: null,
    sources: [],
    ...over,
  };
}

function festivalOf(...occurrences: ReturnType<typeof occurrence>[]) {
  return { ...fictionalFestival(), occurrences } as Parameters<typeof anchorDays>[0];
}

function anchored(over: Partial<ConsultState> = {}): ConsultState {
  return {
    ...beginAnchoredHearing({ ...INITIAL_CONSULT, answers: {} }, ANCHOR),
    ...over,
  };
}

function plan(over: Partial<AnchorPlan> = {}): AnchorPlan {
  return {
    anchor: ANCHOR,
    festivalName: "架空の祭り",
    mustPrefectures: ["香川県"],
    visits: [],
    order: ["みなと中央駅", "架空の祭り", "みなと中央駅"],
    startDate: "2030-08-16",
    endDate: "2030-08-17",
    minNights: 1,
    warnings: [],
    ...over,
  };
}

/** 出発地と泊数まで答えた聞き取り */
function answered(nights = 1): ConsultState {
  const state = setAnchorNights(anchored(), nights);
  return { ...state, answers: setAnswerText(state.answers, "origin", "みなと中央駅") };
}

describe("行く日の候補", () => {
  it("今日以降の、中止と延期でない回の日だけを、早い順に出す", () => {
    const festival = festivalOf(
      occurrence("2031-08-16"),
      occurrence("2029-08-16"),
      occurrence("2030-08-16"),
      occurrence("2030-09-01", { status: "cancelled" }),
      occurrence("2030-09-02", { status: "postponed" }),
    );
    expect(anchorDays(festival, "2030-01-01", ANCHOR.date).map((day) => day.date)).toEqual([
      "2030-08-16",
      "2031-08-16",
    ]);
  });

  it("何日かにまたがる開催は、今日以降の日を1日ずつ選べる", () => {
    const festival = festivalOf(occurrence("2030-08-14", { endDate: "2030-08-17" }));
    expect(anchorDays(festival, "2030-08-15", ANCHOR.date).map((day) => day.date)).toEqual([
      "2030-08-15",
      "2030-08-16",
      "2030-08-17",
    ]);
  });

  it("例年の見込みの回には印を付ける", () => {
    const festival = festivalOf(occurrence("2030-08-16", { status: "expected" }));
    expect(anchorDays(festival, "2030-01-01", ANCHOR.date)[0]).toMatchObject({ expected: true });
  });

  it("祭りのデータがない・候補がないときは、決まっている日だけを出す", () => {
    const only = [{ date: ANCHOR.date, start: null, end: null, expected: false }];
    expect(anchorDays(undefined, "2030-01-01", ANCHOR.date)).toEqual(only);
    expect(
      anchorDays(
        festivalOf(occurrence("2030-08-16", { status: "cancelled" })),
        "2030-01-01",
        ANCHOR.date,
      ),
    ).toEqual(only);
  });
});

describe("祭りを固定した聞き取りの始まりと終わり", () => {
  it("祭りと矛盾しうる日程と行き先の答えは消し、ほかの答えは残す", () => {
    const answers = pickAnswer(
      pickAnswer(setStay(pickAnswer({}, "schedule", "thisWeekend"), "oneNight"), "party", "solo"),
      "destination",
      "kanto",
    );
    const state = beginAnchoredHearing({ ...INITIAL_CONSULT, answers }, ANCHOR);
    expect(state).toMatchObject({ entry: "trip", step: "party", anchor: ANCHOR });
    expect(state.answers.schedule).toBeUndefined();
    expect(state.answers.destination).toBeUndefined();
    expect(state.answers.party?.picks).toEqual(["solo"]);
  });

  it("戻るときは固定と確認の結果を外す", () => {
    const state = anchored({ preview: applyPreview("k", plan()), anchorCancelled: true });
    for (const left of [leaveAnchor(state), leaveHearing(state)]) {
      expect(left).toMatchObject({ entry: "festival", anchor: null, anchorCancelled: false });
      expect(left.preview.status).toBe("idle");
    }
    expect(leaveAnchor({ ...state, active: false }).active).toBe(true);
  });

  it("中止と分かった祭りだけを結果の一覧から外す", () => {
    const of = (festivalId: string) => ({ candidate: { festivalId } }) as never;
    const search = {
      phase: "decide",
      chosen: of("a"),
      resultsOpen: false,
      results: [of("a"), of("b")],
      nearMatches: [{ result: of("a"), miss: "夏です" }],
    } as never;
    const opened = returnToResults(search, "a");
    expect(opened).toMatchObject({ phase: "results", chosen: null, resultsOpen: true });
    expect(opened.results).toHaveLength(1);
    expect(opened.nearMatches).toHaveLength(0);
    expect(returnToResults(search, null).results).toHaveLength(2);
  });
});

describe("日程", () => {
  it("泊数は行く日を初日にする", () => {
    expect(setAnchorNights(anchored(), 2).answers.schedule?.range).toEqual({
      from: "2030-08-16",
      to: "2030-08-18",
    });
    expect(setAnchorNights(anchored(), 0).answers.schedule?.range).toEqual({
      from: "2030-08-16",
      to: "2030-08-16",
    });
  });

  it("行く日を含まない期間は受けない", () => {
    const state = anchored();
    expect(setAnchorRange(state, "2030-08-10", "2030-08-15")).toBe(state);
    expect(setAnchorRange(state, "2030-08-17", "2030-08-18")).toBe(state);
    expect(setAnchorRange(state, "2030-08-14", "2030-08-17").answers.schedule?.range).toEqual({
      from: "2030-08-14",
      to: "2030-08-17",
    });
  });

  it("逆の順に選んでも早い日を行きにし、泊数の上限を超える期間は受けない", () => {
    const state = anchored();
    expect(setAnchorRange(state, "2030-08-17", "2030-08-15").answers.schedule?.range).toEqual({
      from: "2030-08-15",
      to: "2030-08-17",
    });
    expect(setAnchorRange(state, "2030-08-10", "2030-08-17")).toBe(state);
  });

  it("カレンダーでは、行きは行く日まで、帰りは行く日からだけを選べる", () => {
    const can = (date: string, start: string | null) =>
      selectableAnchorDay(date, "2030-08-01", start, ANCHOR.date);
    expect(can("2030-08-16", null)).toBe(true);
    expect(can("2030-08-14", null)).toBe(true);
    expect(can("2030-08-17", null)).toBe(false);
    // 泊数の上限より前は、行きにできない
    expect(can("2030-08-09", null)).toBe(false);
    expect(can("2030-08-10", null)).toBe(true);
    // 行きを選んだあと：行く日より前は帰りにできない。行きとその前は、行きの選び直し
    expect(can("2030-08-15", "2030-08-14")).toBe(false);
    expect(can("2030-08-16", "2030-08-14")).toBe(true);
    expect(can("2030-08-20", "2030-08-14")).toBe(true);
    expect(can("2030-08-21", "2030-08-14")).toBe(false);
    expect(can("2030-08-14", "2030-08-14")).toBe(true);
    expect(can("2030-08-13", "2030-08-14")).toBe(true);
    // 今日より前は選べない
    expect(selectableAnchorDay("2030-08-14", "2030-08-15", null, ANCHOR.date)).toBe(false);
  });

  it("行く日を変えると、その日を含む期間だけを残す", () => {
    const state = setAnchorRange(anchored(), "2030-08-15", "2030-08-17");
    const inside = chooseAnchorDay(state, "2030-08-17");
    expect(inside.anchor?.date).toBe("2030-08-17");
    expect(inside.answers.schedule?.range).toEqual({ from: "2030-08-15", to: "2030-08-17" });
    const outside = chooseAnchorDay(state, "2030-08-18");
    expect(outside.anchor?.date).toBe("2030-08-18");
    expect(outside.answers.schedule?.range).toBeUndefined();
    expect(furthestStep(outside.answers, outside.anchor)).toBe("party");
  });

  it("泊数のボタンで選んだ期間は、泊数を保って新しい行く日へ動かす", () => {
    const moved = chooseAnchorDay(setAnchorNights(anchored(), 2), "2030-08-17");
    expect(moved.answers.schedule?.range).toEqual({ from: "2030-08-17", to: "2030-08-19" });
  });
});

describe("段階の飛ばし方", () => {
  const withParty = (state: ConsultState) => ({
    ...state,
    answers: pickAnswer(state.answers, "party", "solo"),
  });

  it("日帰りでは行き先を飛ばす。泊まりでは聞く", () => {
    const day = setAnchorNights(anchored(), 0);
    expect(hearingSteps(day)).not.toContain("destination");
    expect(nextStep("origin", day)).toBe("activities");
    expect(previousStep("activities", day)).toBe("origin");
    expect(stepAfterAnswer({ step: "origin", editing: false }, day)).toBe("activities");
    const night = setAnchorNights(anchored(), 1);
    expect(hearingSteps(night)).toContain("destination");
    expect(nextStep("origin", night)).toBe("destination");
  });

  it("旅行計画から探す相談は、日帰りでも行き先を聞く", () => {
    const answers = setRange({}, "2030-08-16", "2030-08-16");
    const flow = { answers, anchor: null };
    expect(hearingSteps(flow)).toContain("destination");
    expect(nextStep("origin", flow)).toBe("destination");
    expect(nextStep("origin")).toBe("destination");
    expect(furthestStep(setAnswerText(answers, "origin", "みなと中央駅"))).toBe("party");
  });

  it("行き先は選ばなくても先へ進めるが、日程は行く日を含む期間を選ぶまで進めない", () => {
    const state = withParty(anchored());
    expect(furthestStep(state.answers, state.anchor)).toBe("schedule");
    const other = setRange(state.answers, "2030-09-01", "2030-09-02");
    expect(furthestStep(other, state.anchor)).toBe("schedule");
    const chosen = withParty(answered());
    expect(furthestStep(chosen.answers, chosen.anchor)).toBe("activities");
    expect(canReach("destination", chosen.answers, chosen.anchor)).toBe(true);
    expect(canReach("food", chosen.answers, chosen.anchor)).toBe(false);
  });

  it("旅行計画から探す相談では、行き先に答えるまで進めない", () => {
    const answers = setAnswerText(
      setRange(pickAnswer({}, "party", "solo"), "2030-08-16", "2030-08-17"),
      "origin",
      "みなと中央駅",
    );
    expect(furthestStep(answers)).toBe("destination");
  });
});

describe("寄りたい場所", () => {
  const withPicks = (...picks: string[]) =>
    picks.reduce((answers, pick) => pickAnswer(answers, "destination", pick), {
      schedule: { picks: ["dates"], text: "", range: { from: "2030-08-16", to: "2030-08-17" } },
    } as ConsultState["answers"]);

  it("都道府県まで選んだ地方はその県、地方だけならサーバーの読める地方の名前にする", () => {
    expect(anchorWishes(withPicks("kanto", "kyushu", "chubu", "p16"))).toEqual([
      "関東",
      "九州沖縄",
      "富山県",
    ]);
  });

  it("「その他」の地名を1か所ずつに分け、同じ名前は1つにする", () => {
    const answers = setAnswerText(withPicks("other"), "destination", "A市、B町, A市");
    expect(anchorWishes(answers)).toEqual(["A市", "B町"]);
  });

  it("日帰りでは寄りたい場所を聞かないので、残っていても使わない", () => {
    const answers = setRange(withPicks("kanto"), "2030-08-16", "2030-08-16");
    expect(anchorWishes(answers)).toEqual([]);
  });

  it("確かめられる数を超えたら、先に選んだ分だけにして知らせる", () => {
    const answers = withPicks("hokkaido", "tohoku", "kanto", "chubu", "kinki", "shikoku");
    expect(anchorWishes(answers)).toHaveLength(MAX_ROUTE_AREAS);
    expect(tooManyWishes(answers)).toBe(true);
    expect(tooManyWishes(withPicks("kanto"))).toBe(false);
  });
});

describe("確認の要求", () => {
  it("出発地と泊数がそろったら、スキーマに合う形で組み立てる", () => {
    const base = answered(2);
    const state = {
      ...base,
      answers: pickAnswer(pickAnswer(base.answers, "destination", "shikoku"), "pace", "relaxed"),
    };
    const request = anchorPlanRequest(state, "s-1");
    expect(request).toEqual({
      sessionId: "s-1",
      anchor: ANCHOR,
      origin: "みなと中央駅",
      nights: 2,
      wishes: ["四国"],
      pace: "relaxed",
    });
    expect(AnchorPlanRequestSchema.safeParse(request).success).toBe(true);
  });

  it("おまかせのペースは送り、その他は送らない", () => {
    const base = answered();
    const auto = { ...base, answers: pickAnswer(base.answers, "pace", "auto") };
    expect(anchorPlanRequest(auto, "s")?.pace).toBe("auto");
    const other = { ...base, answers: pickAnswer(base.answers, "pace", "other") };
    expect(anchorPlanRequest(other, "s")).not.toHaveProperty("pace");
  });

  it("カレンダーで選んだ期間は初日を添え、泊数のボタンでは添えない", () => {
    const base = answered();
    const calendar = setAnchorRange(base, "2030-08-15", "2030-08-17");
    expect(anchorPlanRequest(calendar, "s")?.anchor).toEqual({
      ...ANCHOR,
      startDate: "2030-08-15",
    });
    expect(anchorToSend(calendar)).toEqual({ ...ANCHOR, startDate: "2030-08-15" });

    const buttons = setAnchorNights(calendar, 2);
    expect(anchorPlanRequest(buttons, "s")?.anchor).toEqual(ANCHOR);
    expect(anchorToSend(buttons)).toEqual(ANCHOR);
  });

  it("出発地か泊数がなければ作らない", () => {
    expect(anchorPlanRequest(anchored(), "s")).toBeNull();
    expect(anchorPlanRequest(setAnchorNights(anchored(), 1), "s")).toBeNull();
    expect(anchorPlanRequest({ ...answered(), anchor: null }, "s")).toBeNull();
    expect(anchorPreviewKey(answered(), null)).toBeNull();
  });

  it("答えを変えると、前の結果は使わない", () => {
    const state = answered();
    const key = anchorPreviewKey(state, "s") as string;
    const ready = { ...state, preview: applyPreview(key, plan()) };
    expect(currentPreview(ready, "s").status).toBe("ready");
    const changed = setAnchorNights(ready, 2);
    expect(currentPreview(changed, "s").status).toBe("idle");
    const failed = { ...state, preview: failPreview(key, clientError("internal")) };
    expect(currentPreview(failed, "s")).toMatchObject({ status: "failed", plan: null });
  });
});

describe("確認の結果の読み方", () => {
  it("泊数が足りないときだけ、見直しを勧める", () => {
    expect(underMinNights(plan({ endDate: "2030-08-16", minNights: 1 }))).toBe(true);
    expect(underMinNights(plan({ minNights: 1 }))).toBe(false);
    expect(underMinNights(plan({ endDate: "2030-08-16", minNights: null }))).toBe(false);
  });

  it("入れる・余裕があれば入れる・今回は外すに分ける", () => {
    const visit = (name: string, status: "included" | "maybe" | "dropped") => ({
      name,
      prefecture: null,
      status,
      reason: status === "included" ? null : "遠いため",
    });
    const groups = visitsByStatus(
      plan({ visits: [visit("A県", "included"), visit("B県", "dropped"), visit("C県", "maybe")] }),
    );
    expect(groups.included.map((v) => v.name)).toEqual(["A県"]);
    expect(groups.maybe.map((v) => v.name)).toEqual(["C県"]);
    expect(groups.dropped.map((v) => v.name)).toEqual(["B県"]);
  });

  it("選んだ期間と組み立ての日付が違うかを見分ける", () => {
    const { answers } = setAnchorNights(anchored(), 1);
    expect(planDatesDiffer(answers, plan())).toBe(false);
    expect(planDatesDiffer(answers, plan({ startDate: "2030-08-15", endDate: "2030-08-16" }))).toBe(
      true,
    );
  });
});

describe("送る一文", () => {
  const chosen = { name: "架空の祭り", place: "架空県架空町", venueName: "架空の広場" };

  it("祭りを探し直さない発言にし、必ず行く場所と寄りたい場所を入れる", () => {
    const base = answered();
    const state = { ...base, answers: pickAnswer(base.answers, "destination", "shikoku") };
    const message = composeConsultMessage(
      state.answers,
      wording,
      "2030-08-01",
      anchorMessage(state, chosen, "s"),
    );
    expect(message).toContain("「架空の祭り」（2030-08-16）");
    expect(message).toContain("必ず行く：架空県架空町・架空の広場");
    expect(message).toContain("寄りたい場所：四国");
    expect(message).toContain("祭りは探し直さず");
    expect(message).not.toContain(wording.outro);
  });

  it("日帰りでは、残っている寄りたい場所を入れない", () => {
    const base = answered(0);
    const answers = pickAnswer(base.answers, "destination", "shikoku");
    const message = composeConsultMessage(
      answers,
      wording,
      "2030-08-01",
      anchorMessage({ ...base, answers }, chosen, "s"),
    );
    expect(message).toContain("必ず行く");
    expect(message).not.toContain("寄りたい場所");
    expect(message).toContain("日帰り");
  });

  it("確かめられた組み立てがあれば、その日付で伝える", () => {
    const state = answered();
    const key = anchorPreviewKey(state, "s") as string;
    const ready = {
      ...state,
      preview: applyPreview(key, plan({ startDate: "2030-08-15", endDate: "2030-08-16" })),
    };
    const message = composeConsultMessage(
      ready.answers,
      wording,
      "2030-08-01",
      anchorMessage(ready, chosen, "s"),
    );
    expect(message).toContain("2030-08-15〜2030-08-16");
  });

  it("固定がなければ、今までの一文のまま", () => {
    const answers = pickAnswer({}, "party", "solo");
    const state = { ...INITIAL_CONSULT, answers };
    expect(anchorMessage(state, chosen, "s")).toBeNull();
    const message = composeConsultMessage(answers, wording, "2030-08-01");
    expect(message).toContain(wording.intro);
    expect(message).toContain(wording.outro);
  });
});
