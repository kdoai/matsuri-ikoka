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
    "大けがをしました",
    "怪我をしました",
    "けがをしました",
    "血が出ています",
    "ちがでています",
    "具合が悪くて立てません",
    "気分が悪くて吐きました",
    "苦しいです",
    "くるしいです",
    "父が胸が苦しいと言っています",
    "気を失いました",
    "ぐったりしています",
    "息苦しそうです",
    "助けて",
    "たすけて",
    "殴られた",
    "なぐられました",
    "死にたい",
    "しにたい",
    "たおれました",
    "いしきがありません",
    "じこにあいました",
    "子どもが迷子です",
    "Help!",
    "please call an ambulance",
    "My friend collapsed",
    "she is bleeding",
    "I can't breathe",
    "he is unconscious",
    "EMERGENCY",
    "I want to die",
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
    "連れだけが甘いものが好きです",
    "おでかけが楽しみです",
    "時刻表（じこくひょう）を見たいです",
    "fireworks are at seven",
    "迷子になりました。駅への道を教えてください",
  ])("「%s」は緊急として扱わない", (message) => {
    expect(isEmergencyMessage(message)).toBe(false);
  });
});

describe("emergencyEvent", () => {
  it("公的な連絡先（119・110）を持つ", () => {
    expect(emergencyEvent().data.contacts.map((contact) => contact.number)).toEqual(["119", "110"]);
  });
});
