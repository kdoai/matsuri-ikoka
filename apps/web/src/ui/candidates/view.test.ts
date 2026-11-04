import type { FestivalCandidate } from "@matsuri-ikoka/schema";
import { fictionalSource } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { MESSAGES } from "../../i18n";
import { chooseBlock, faceTags, parseCandidateView } from "./view";

const candidate = (confirmed: boolean): FestivalCandidate => ({
  festivalId: "fictional-lantern",
  name: "架空灯籠まつり",
  date: "2026-08-16",
  start: "18:30",
  end: "21:00",
  confirmed,
  daysFromWish: 0,
  place: "架空県架空町",
  venueName: "架空川の河原",
  highlight: "川面に浮かぶ灯籠",
  confidence: confirmed ? "official" : "single",
  source: fictionalSource("2026"),
});

describe("候補の表示の切り替え", () => {
  it("覚えておいた表示を読む", () => {
    expect(parseCandidateView("list")).toBe("list");
    expect(parseCandidateView("cards")).toBe("cards");
  });

  it("覚えていない・知らない値なら、カード表示", () => {
    expect(parseCandidateView(null)).toBe("cards");
    expect(parseCandidateView("table")).toBe("cards");
  });
});

describe("「この祭りにする」を押せるか", () => {
  it("開催が確認できていれば押せる", () => {
    expect(chooseBlock(candidate(true), false)).toBeNull();
  });

  it("開催が確認できていなければ、返答の途中でなくても押せない", () => {
    expect(chooseBlock(candidate(false), false)).toBe("unconfirmed");
    expect(chooseBlock(candidate(false), true)).toBe("unconfirmed");
  });

  it("要事前確認（公式以外の情報源などで確かめた）の祭りは、確認済みでなくても押せる", () => {
    const needsCheck = {
      ...candidate(false),
      check: { result: "needs_check" as const, checkedAt: "2026-08-03T10:00:00+09:00" },
    };
    expect(chooseBlock(needsCheck, false)).toBeNull();
    expect(chooseBlock(needsCheck, true)).toBe("busy");
  });

  it("返答の途中は押せない", () => {
    expect(chooseBlock(candidate(true), true)).toBe("busy");
  });
});

describe("カードの面のタグ", () => {
  it("「ご希望の日」は日付の札で出すので、タグからは外す", () => {
    expect(faceTags(["wishDay", "night", "stalls"])).toEqual(["night", "stalls"]);
  });
});

describe("候補の画面の文言", () => {
  it("絞り込みの選択肢に、合う候補の数を添える", () => {
    expect(MESSAGES.ja.candidates.filters.option("8月", 2)).toBe("8月（2）");
    expect(MESSAGES.en.candidates.filters.option("Aug", 2)).toBe("Aug (2)");
  });
});
