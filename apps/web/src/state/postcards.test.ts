import { type FestivalCandidate, FestivalSchema } from "@matsuri-ikoka/schema";
import { fictionalFestival, fictionalSource } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import {
  candidateArea,
  candidateMonth,
  candidateTags,
  filterCandidates,
  filterOptions,
  NO_FILTERS,
} from "./postcards";

const festival = FestivalSchema.parse(fictionalFestival());

const lantern: FestivalCandidate = {
  festivalId: festival.id,
  name: festival.name.ja,
  date: "2026-08-16",
  start: "18:30",
  end: "21:00",
  venueName: festival.venue.name,
  place: "滋賀県鈴鳴町",
  daysFromWish: 0,
  confidence: "official",
  confirmed: true,
  highlight: "川面に浮かぶ千の灯籠",
  source: fictionalSource("2026"),
};

const morning: FestivalCandidate = {
  ...lantern,
  festivalId: "kodama-asaichi",
  name: "こだま朝市まつり",
  date: "2026-09-05",
  start: "09:00",
  end: "12:00",
  place: "長野県こだま村",
  daysFromWish: 3,
};

describe("candidateTags", () => {
  it("候補の項目と祭りのデータから、目印のタグを出す", () => {
    const noKids = { ...festival, nearby: festival.nearby.map((spot) => ({ ...spot, tags: [] })) };
    expect(candidateTags(lantern, noKids)).toEqual([
      "wishDay",
      "night",
      "join",
      "hidden",
      "stalls",
    ]);
  });

  it("祭りのデータが届く前は、候補の項目から分かるものだけ", () => {
    expect(candidateTags(lantern, null)).toEqual(["wishDay", "night"]);
    expect(candidateTags(morning, null)).toEqual([]);
  });

  it("子連れで寄れる場所があれば家族向けのタグを付ける", () => {
    const spot = festival.nearby[0];
    if (spot === undefined) throw new Error("架空の祭りに周辺の場所がありません");
    const withKids = { ...festival, nearby: [{ ...spot, tags: ["kid_friendly" as const] }] };
    expect(candidateTags(morning, withKids)).toContain("family");
  });
});

describe("絞り込み", () => {
  it("開催地から都道府県、日付から月を取り出す", () => {
    expect(candidateArea("滋賀県鈴鳴町")).toBe("滋賀県");
    expect(candidateArea("東京都みなと区")).toBe("東京都");
    expect(candidateArea("鈴鳴町")).toBe("鈴鳴町");
    expect(candidateMonth("2026-09-05")).toBe(9);
  });

  it("エリア・時期・テーマで絞り込み、元の順を保つ", () => {
    const festivals = { [festival.id]: festival };
    const all = [lantern, morning];
    expect(filterCandidates(all, festivals, NO_FILTERS)).toEqual(all);
    expect(filterCandidates(all, festivals, { ...NO_FILTERS, area: "長野県" })).toEqual([morning]);
    expect(filterCandidates(all, festivals, { ...NO_FILTERS, month: 8 })).toEqual([lantern]);
    expect(filterCandidates(all, festivals, { ...NO_FILTERS, theme: "lantern" })).toEqual([
      lantern,
    ]);
    // データの届いていない祭りは「その他」として数える
    expect(filterCandidates(all, festivals, { ...NO_FILTERS, theme: "other" })).toEqual([morning]);
  });

  it("選択肢ごとの候補の数を、出てくる順に数える", () => {
    expect(filterOptions([lantern, morning, lantern], (c) => candidateMonth(c.date))).toEqual([
      { value: 8, count: 2 },
      { value: 9, count: 1 },
    ]);
  });
});
