import { describe, expect, it } from "vitest";
import { MESSAGES } from "../i18n";
import {
  composeConsultMessage,
  hasAnyAnswer,
  isAnswered,
  nextStep,
  pickAnswer,
  previousStep,
  resolveWhen,
  setAnswerText,
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

  it("選び直しても、書いた文字は残す", () => {
    let answers = setAnswerText({}, "food", "そば");
    answers = pickAnswer(answers, "food", "other");
    expect(answers.food).toEqual({ picks: ["other"], text: "そば" });
  });
});

describe("isAnswered", () => {
  it("その他と日付を選ぶは、文字が入ってはじめて答えになる", () => {
    expect(isAnswered({ picks: ["other"], text: "" }, "party")).toBe(false);
    expect(isAnswered({ picks: ["other"], text: "祖父母と" }, "party")).toBe(true);
    expect(isAnswered({ picks: ["date"], text: "" }, "when")).toBe(false);
    expect(isAnswered({ picks: ["auto"], text: "" }, "when")).toBe(true);
  });

  it("出発の駅は、書いた駅名で答えになる", () => {
    expect(isAnswered({ picks: [], text: "  " }, "origin")).toBe(false);
    expect(isAnswered({ picks: [], text: "みなと中央駅" }, "origin")).toBe(true);
    expect(hasAnyAnswer({ origin: { picks: [], text: "みなと中央駅" } })).toBe(true);
    expect(hasAnyAnswer({ party: { picks: [], text: "" } })).toBe(false);
  });
});

describe("段階", () => {
  it("前後に移り、端では止まる", () => {
    expect(nextStep("party")).toBe("when");
    expect(nextStep("confirm")).toBe("confirm");
    expect(previousStep("party")).toBe("party");
    expect(previousStep("confirm")).toBe("style");
  });
});

describe("resolveWhen", () => {
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
    expect(resolveWhen("date", "2030-12-20")).toBeNull();
  });

  it("日本の今日は、日本の時刻で数える", () => {
    expect(todayInJapan(new Date("2030-06-05T15:30:00Z"))).toBe("2030-06-06");
    expect(todayInJapan(new Date("2030-06-05T14:59:00Z"))).toBe("2030-06-05");
  });
});

describe("composeConsultMessage", () => {
  it("答えた項目だけを、決まった順に1つの発言にまとめる", () => {
    let answers = pickAnswer({}, "food", "seafood");
    answers = pickAnswer(answers, "food", "other");
    answers = setAnswerText(answers, "food", "そば");
    answers = pickAnswer(answers, "party", "family");
    answers = pickAnswer(answers, "when", "thisWeekend");
    answers = setAnswerText(answers, "origin", "みなと中央駅");
    answers = pickAnswer(answers, "stay", "auto");
    answers = pickAnswer(answers, "budget", "other");
    const message = composeConsultMessage(answers, wording, "2030-06-05");
    expect(message).toBe(
      [
        "旅の相談です。選んだ条件はこちらです。",
        "・誰と：家族で",
        "・いつ：今週末（2030-06-08〜2030-06-09）",
        "・出発する駅：みなと中央駅",
        "・日帰り・泊まり：おまかせ",
        "・食べたいもの：海鮮、そば",
        "この条件に合う祭りを探してください。",
      ].join("\n"),
    );
  });

  it("日付を選んだときは、その日を書く", () => {
    let answers = pickAnswer({}, "when", "date");
    answers = setAnswerText(answers, "when", "2030-08-15");
    expect(composeConsultMessage(answers, wording, "2030-06-05")).toContain("・いつ：2030-08-15");
  });

  it("何も答えていなければ送らない", () => {
    expect(composeConsultMessage({}, wording, "2030-06-05")).toBeNull();
    expect(
      composeConsultMessage(pickAnswer({}, "party", "other"), wording, "2030-06-05"),
    ).toBeNull();
  });

  it("英語でもまとめられる", () => {
    const answers = pickAnswer({}, "pace", "relaxed");
    expect(composeConsultMessage(answers, MESSAGES.en.consult.wording, "2030-06-05")).toBe(
      [
        "Here is what I'm looking for:",
        "- Pace: Relaxed",
        "Please find festivals that match.",
      ].join("\n"),
    );
  });
});
