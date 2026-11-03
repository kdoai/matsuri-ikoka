import { describe, expect, it } from "vitest";
import { MESSAGES } from "../i18n";
import {
  type ConsultAnswers,
  canReach,
  composeConsultMessage,
  effectiveAnswers,
  familyParty,
  furthestStep,
  hasAnyAnswer,
  isAnswered,
  isDayTrip,
  monthWeeks,
  nextStep,
  nightsBetween,
  partyCounts,
  partySize,
  pickAnswer,
  previousStep,
  resolveWhen,
  selectableDay,
  setAmount,
  setAnswerText,
  setRange,
  setStay,
  setTravel,
  shiftMonth,
  stepAfterAnswer,
  stepCount,
  todayInJapan,
} from "./consult";

const wording = MESSAGES.ja.consult.wording;

describe("pickAnswer", () => {
  it("1つだけの項目は入れ替え、同じものをもう一度選ぶと外す", () => {
    let answers = pickAnswer({}, "party", "family");
    answers = pickAnswer(answers, "party", "friends");
    expect(answers.party?.picks).toEqual(["friends"]);
    answers = pickAnswer(answers, "party", "friends");
    expect(answers.party?.picks).toEqual([]);
  });

  it("いくつでも選べる項目は付け外しし、おまかせはほかと同時に選ばない", () => {
    let answers = pickAnswer({}, "food", "seafood");
    answers = pickAnswer(answers, "food", "sweets");
    expect(answers.food?.picks).toEqual(["seafood", "sweets"]);
    answers = pickAnswer(answers, "food", "auto");
    expect(answers.food?.picks).toEqual(["auto"]);
    answers = pickAnswer(answers, "food", "stalls");
    expect(answers.food?.picks).toEqual(["stalls"]);
  });

  it("行き先で地方を外すと、その中の都道府県も外す", () => {
    let answers = pickAnswer({}, "destination", "kanto");
    answers = pickAnswer(answers, "destination", "p13");
    answers = pickAnswer(answers, "destination", "kinki");
    answers = pickAnswer(answers, "destination", "p26");
    answers = pickAnswer(answers, "destination", "kanto");
    expect(answers.destination?.picks).toEqual(["kinki", "p26"]);
  });

  it("選び直しても、書いた文字は残す", () => {
    let answers = setAnswerText({}, "food", "そば");
    answers = pickAnswer(answers, "food", "other");
    expect(answers.food).toEqual({ picks: ["other"], text: "そば" });
  });
});

describe("人数", () => {
  it("ひとりは1人、恋人は2人で決まる", () => {
    expect(partySize(pickAnswer({}, "party", "solo").party)).toBe(1);
    expect(partySize(pickAnswer({}, "party", "partner").party)).toBe(2);
    expect(partySize(pickAnswer({}, "party", "auto").party)).toBeNull();
  });

  it("家族は内訳の合計、友人は入れた人数。下限と上限で止まる", () => {
    let answers = pickAnswer({}, "party", "family");
    answers = stepCount(answers, "children", 1);
    answers = stepCount(answers, "infants", 1);
    answers = stepCount(answers, "infants", -1);
    answers = stepCount(answers, "infants", -1);
    expect(partySize(answers.party)).toBe(3);

    answers = pickAnswer(answers, "party", "friends");
    expect(partySize(answers.party)).toBe(2);
    answers = stepCount(answers, "friends", -1);
    expect(partySize(answers.party)).toBe(2);
    for (let i = 0; i < 30; i += 1) answers = stepCount(answers, "friends", 1);
    expect(partySize(answers.party)).toBe(20);
  });

  it("家族の人数は、シニアを大人の内数、幼児を子どもの内数にして伝える", () => {
    let answers = pickAnswer({}, "party", "family");
    answers = stepCount(answers, "seniors", 1);
    answers = stepCount(answers, "children", 1);
    answers = stepCount(answers, "infants", 1);
    expect(familyParty(partyCounts(answers.party))).toEqual({
      adults: 3,
      children: 2,
      seniors: 1,
      infants: 1,
    });
    expect(composeConsultMessage(answers, wording, "2030-06-05")).toContain(
      "・だれと：家族で（大人3人（うちシニア1人）、子ども2人（うち幼児1人）、計5人）",
    );
  });

  it("家族には、大人かシニアを1人は残す", () => {
    let answers: ConsultAnswers = pickAnswer({}, "party", "family");
    answers = stepCount(answers, "adults", -1);
    answers = stepCount(answers, "adults", -1);
    expect(answers.party?.counts?.adults).toBe(1);
    answers = stepCount(answers, "seniors", 1);
    answers = stepCount(answers, "adults", -1);
    expect(answers.party?.counts).toMatchObject({ adults: 0, seniors: 1 });
    expect(stepCount(answers, "seniors", -1)).toBe(answers);
  });
});

describe("isAnswered", () => {
  it("その他と日付を指定は、文字や期間が入ってはじめて答えになる", () => {
    expect(isAnswered({ picks: ["other"], text: "" }, "party")).toBe(false);
    expect(isAnswered({ picks: ["other"], text: "祖父母と" }, "party")).toBe(true);
    expect(isAnswered({ picks: ["dates"], text: "" }, "schedule")).toBe(false);
    expect(setRange({}, "2030-06-10", "2030-06-12").schedule).toMatchObject({
      picks: ["dates"],
      range: { from: "2030-06-10", to: "2030-06-12" },
    });
  });

  it("今週末などの範囲と日にちは未定は、日帰りか泊まりかまで選んで答えになる", () => {
    for (const pick of ["thisWeekend", "nextMonth", "undecided"]) {
      const answers = pickAnswer({}, "schedule", pick);
      expect(isAnswered(answers.schedule, "schedule")).toBe(false);
      expect(canReach("origin", { ...pickAnswer({}, "party", "solo"), ...answers })).toBe(false);
      expect(isAnswered(setStay(answers, "oneNight").schedule, "schedule")).toBe(true);
    }
    // 範囲を選び直しても、選んだ日帰り・泊まりは残る
    let answers = setStay(pickAnswer({}, "schedule", "thisWeekend"), "dayTrip");
    answers = pickAnswer(answers, "schedule", "nextWeekend");
    expect(isAnswered(answers.schedule, "schedule")).toBe(true);
  });

  it("出発の駅とひとことは、書いた文字で答えになる", () => {
    expect(isAnswered({ picks: [], text: "  " }, "origin")).toBe(false);
    expect(isAnswered({ picks: [], text: "みなと中央駅" }, "origin")).toBe(true);
    expect(hasAnyAnswer({ origin: { picks: [], text: "みなと中央駅" } })).toBe(true);
    expect(hasAnyAnswer({ note: { picks: [], text: "" } })).toBe(false);
  });

  it("予算は、選択肢か金額のどちらかで答えになる", () => {
    let answers = setAmount({}, 25_000);
    expect(isAnswered(answers.budget, "budget")).toBe(true);
    answers = pickAnswer(answers, "budget", "under30k");
    expect(answers.budget).toEqual({ picks: ["under30k"], text: "" });
    answers = setAmount(answers, 40_000);
    expect(answers.budget?.picks).toEqual([]);
    answers = setAmount(answers, null);
    expect(isAnswered(answers.budget, "budget")).toBe(false);
  });
});

describe("段階の行き来", () => {
  it("前後に移り、端では止まる", () => {
    expect(nextStep("party")).toBe("schedule");
    expect(nextStep("confirm")).toBe("confirm");
    expect(previousStep("party")).toBe("party");
    expect(previousStep("confirm")).toBe("note");
  });

  it("進めるのは、最初のまだ答えていない段階まで。ひとことは書かなくても進める", () => {
    expect(furthestStep({})).toBe("party");
    let answers = pickAnswer({}, "party", "solo");
    expect(furthestStep(answers)).toBe("schedule");
    expect(canReach("origin", answers)).toBe(false);
    for (const [question, pick] of [
      ["schedule", "undecided"],
      ["destination", "auto"],
      ["activities", "onsen"],
      ["food", "auto"],
      ["pace", "relaxed"],
      ["budget", "under10k"],
    ] as const) {
      answers = pickAnswer(answers, question, pick);
    }
    // 日にちは未定のままでは、日程で止まる
    expect(furthestStep(answers)).toBe("schedule");
    answers = setStay(answers, "dayTrip");
    expect(furthestStep(answers)).toBe("origin");
    answers = setAnswerText(answers, "origin", "みなと中央駅");
    expect(furthestStep(answers)).toBe("confirm");
    expect(canReach("confirm", answers)).toBe(true);
  });

  it("答えたら次へ。確認から直しに来たときは確認へ戻る", () => {
    expect(stepAfterAnswer({ step: "party", editing: false })).toBe("schedule");
    expect(stepAfterAnswer({ step: "party", editing: true })).toBe("confirm");
  });
});

describe("日付", () => {
  // 2030-06-05 は水曜日
  it("今週末と来週末は、土曜と日曜", () => {
    expect(resolveWhen("thisWeekend", "2030-06-05")).toEqual({
      from: "2030-06-08",
      to: "2030-06-09",
    });
    expect(resolveWhen("nextWeekend", "2030-06-05")).toEqual({
      from: "2030-06-15",
      to: "2030-06-16",
    });
  });

  it("土曜は今日から、日曜は今日だけを今週末にする", () => {
    expect(resolveWhen("thisWeekend", "2030-06-08")).toEqual({
      from: "2030-06-08",
      to: "2030-06-09",
    });
    expect(resolveWhen("thisWeekend", "2030-06-09")).toEqual({
      from: "2030-06-09",
      to: "2030-06-09",
    });
    expect(resolveWhen("nextWeekend", "2030-06-09")).toEqual({
      from: "2030-06-15",
      to: "2030-06-16",
    });
  });

  it("今月は今日から月末まで、来月は1日から月末まで（年をまたぐ）", () => {
    expect(resolveWhen("thisMonth", "2030-02-10")).toEqual({
      from: "2030-02-10",
      to: "2030-02-28",
    });
    expect(resolveWhen("nextMonth", "2030-12-20")).toEqual({
      from: "2031-01-01",
      to: "2031-01-31",
    });
    expect(resolveWhen("dates", "2030-12-20")).toBeNull();
    expect(resolveWhen("undecided", "2030-12-20")).toBeNull();
  });

  it("日本の今日は、日本の時刻で数える", () => {
    expect(todayInJapan(new Date("2030-06-05T15:30:00Z"))).toBe("2030-06-06");
    expect(todayInJapan(new Date("2030-06-05T14:59:00Z"))).toBe("2030-06-05");
  });

  it("泊数は2つの日の差。同じ日は日帰り、月や年をまたいでも数える", () => {
    expect(nightsBetween("2030-06-05", "2030-06-05")).toBe(0);
    expect(nightsBetween("2030-06-30", "2030-07-02")).toBe(2);
    expect(nightsBetween("2030-12-31", "2031-01-01")).toBe(1);
  });

  it("期間は逆の順に選んでも、早い日を行きにする", () => {
    expect(setRange({}, "2030-06-12", "2030-06-10").schedule?.range).toEqual({
      from: "2030-06-10",
      to: "2030-06-12",
    });
  });

  it("選べる日：今日より前は選べず、帰りは行きから6泊まで", () => {
    expect(selectableDay("2030-06-04", "2030-06-05", null)).toBe(false);
    expect(selectableDay("2030-06-05", "2030-06-05", null)).toBe(true);
    expect(selectableDay("2030-06-16", "2030-06-05", "2030-06-10")).toBe(true);
    expect(selectableDay("2030-06-17", "2030-06-05", "2030-06-10")).toBe(false);
    // 行きより前は、行きの選び直しとして押せる
    expect(selectableDay("2030-06-07", "2030-06-05", "2030-06-10")).toBe(true);
  });

  it("カレンダーの月は日曜はじまりの週で、月を前後に動かせる", () => {
    // 2030-06-01 は土曜日、2030-06-30 は日曜日
    const weeks = monthWeeks("2030-06");
    expect(weeks).toHaveLength(6);
    expect(weeks[0]?.[0]).toEqual({ date: "2030-05-26", inMonth: false });
    expect(weeks[0]?.[6]).toEqual({ date: "2030-06-01", inMonth: true });
    expect(weeks[5]?.[0]).toEqual({ date: "2030-06-30", inMonth: true });
    // 2026-02 は日曜はじまりで4週に収まる
    expect(monthWeeks("2026-02")).toHaveLength(4);
    expect(shiftMonth("2030-12", 1)).toBe("2031-01");
    expect(shiftMonth("2030-01", -1)).toBe("2029-12");
  });
});

describe("日帰りの所要時間の上限", () => {
  it("日帰りか：日帰りを選んだか、行きと帰りが同じ日", () => {
    expect(isDayTrip({})).toBe(false);
    expect(isDayTrip(setStay(pickAnswer({}, "schedule", "nextWeekend"), "dayTrip"))).toBe(true);
    expect(isDayTrip(setStay(pickAnswer({}, "schedule", "nextWeekend"), "oneNight"))).toBe(false);
    expect(isDayTrip(setRange({}, "2030-08-14", "2030-08-14"))).toBe(true);
    expect(isDayTrip(setRange({}, "2030-08-14", "2030-08-15"))).toBe(false);
  });

  it("選ぶと行き先の答えになり、押し直すと外す", () => {
    const answers = setTravel({}, 60);
    expect(answers.destination?.travel).toBe(60);
    expect(isAnswered(answers.destination, "destination")).toBe(true);
    expect(setTravel(answers, 120).destination?.travel).toBe(120);
    const cleared = setTravel(answers, 60);
    expect(cleared.destination?.travel).toBeUndefined();
    expect(isAnswered(cleared.destination, "destination")).toBe(false);
  });
});

describe("composeConsultMessage", () => {
  it("答えた項目だけを、段階の順に1つの発言にまとめる", () => {
    let answers = pickAnswer({}, "food", "seafood");
    answers = pickAnswer(answers, "food", "other");
    answers = setAnswerText(answers, "food", "そば");
    answers = pickAnswer(answers, "party", "family");
    answers = stepCount(answers, "children", 1);
    answers = pickAnswer(answers, "schedule", "thisWeekend");
    answers = setStay(answers, "dayTrip");
    answers = setAnswerText(answers, "origin", "みなと中央駅");
    answers = pickAnswer(answers, "destination", "kanto");
    answers = pickAnswer(answers, "destination", "p13");
    answers = pickAnswer(answers, "destination", "p14");
    answers = pickAnswer(answers, "destination", "kyushu");
    answers = setAmount(answers, 25_000);
    answers = setAnswerText(answers, "note", "子どもが歩き疲れないように");
    const message = composeConsultMessage(answers, wording, "2030-06-05");
    expect(message).toBe(
      [
        "旅の相談です。選んだ条件はこちらです。",
        "・だれと：家族で（大人2人、子ども1人、計3人）",
        "・日程：今週末（2030-06-08〜2030-06-09）、日帰り",
        "・出発する駅：みなと中央駅",
        "・行き先：関東（東京都・神奈川県）、九州・沖縄",
        "・食べたいもの：海鮮、そば",
        "・予算（1人あたり）：25,000円",
        "・ひとこと：子どもが歩き疲れないように",
        "この条件に合う祭りを探してください。",
      ].join("\n"),
    );
  });

  it("日付を指定したときは、期間と泊数を書く", () => {
    const answers = setRange(pickAnswer({}, "party", "friends"), "2030-08-14", "2030-08-16");
    const message = composeConsultMessage(answers, wording, "2030-06-05");
    expect(message).toContain("・だれと：友人と（計2人）");
    expect(message).toContain("・日程：2030-08-14〜2030-08-16（2泊3日）");
    expect(
      composeConsultMessage(setRange({}, "2030-08-14", "2030-08-14"), wording, "2030-06-05"),
    ).toContain("・日程：2030-08-14（日帰り）");
  });

  it("日帰りのときは、出発の駅からの所要時間の上限を行き先に書く", () => {
    let answers = setRange({}, "2030-08-14", "2030-08-14");
    answers = setTravel(answers, 120);
    answers = pickAnswer(answers, "destination", "kanto");
    expect(composeConsultMessage(answers, wording, "2030-06-05")).toContain(
      "・行き先：出発の駅から片道2時間以内、関東",
    );
    expect(composeConsultMessage(answers, MESSAGES.en.consult.wording, "2030-06-05")).toContain(
      "Within 2 hours one way from your station",
    );
  });

  it("泊まりの旅に変えたら、所要時間の上限は送らない", () => {
    let answers = setRange({}, "2030-08-14", "2030-08-14");
    answers = setTravel(answers, 60);
    answers = setRange(answers, "2030-08-14", "2030-08-15");
    expect(composeConsultMessage(answers, wording, "2030-06-05")).not.toContain("時間以内");
    expect(effectiveAnswers(answers).destination?.travel).toBeUndefined();
  });

  it("何も答えていなければ送らない", () => {
    expect(composeConsultMessage({}, wording, "2030-06-05")).toBeNull();
    expect(
      composeConsultMessage(pickAnswer({}, "party", "other"), wording, "2030-06-05"),
    ).toBeNull();
  });

  it("英語でもまとめられる", () => {
    let answers = pickAnswer({}, "pace", "relaxed");
    answers = setRange(answers, "2030-08-14", "2030-08-15");
    expect(composeConsultMessage(answers, MESSAGES.en.consult.wording, "2030-06-05")).toBe(
      [
        "Here is what I'm looking for:",
        "- Dates: 2030-08-14 to 2030-08-15 (1 night)",
        "- Pace: Relaxed",
        "Please find festivals that match.",
      ].join("\n"),
    );
  });
});
