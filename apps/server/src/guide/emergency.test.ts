import { describe, expect, it } from "vitest";
import { emergencyEvent, isEmergencyMessage } from "./emergency";

describe("isEmergencyMessage", () => {
  it.each([
    "連れが倒れて、呼びかけても返事がありません",
    "息ができないと言っています",
    "血が止まりません",
    "階段で転んで頭を打ちました",
    "事故にあいました",
    "財布を盗まれたうえに襲われました",
    "子どもがいなくなってしまいました",
    "１１９に電話したほうがいいですか",
    "110番はどこにかければいいですか",
  ])("「%s」は緊急として扱う", (message) => {
    expect(isEmergencyMessage(message)).toBe(true);
  });

  it.each([
    "雨が降ったらどうすればいいですか",
    "電車が30分遅れました",
    "傘を忘れました",
    "1190円の席はありますか",
    "2110年の話ではありません",
    "祭りのない日の過ごし方を教えてください",
  ])("「%s」は緊急として扱わない", (message) => {
    expect(isEmergencyMessage(message)).toBe(false);
  });
});

describe("emergencyEvent", () => {
  it("公的な連絡先（119・110）を持つ", () => {
    expect(emergencyEvent().data.contacts.map((contact) => contact.number)).toEqual(["119", "110"]);
  });
});
