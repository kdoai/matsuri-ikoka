import { DEFAULT_PREFERENCES, type FestivalCandidate, FestivalSchema } from "@matsuri-ikoka/schema";
import { fictionalFestival, fictionalSource } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { fitReasons } from "./reasons";

const festival = FestivalSchema.parse(fictionalFestival());

const candidate: FestivalCandidate = {
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

describe("候補カードの合う理由", () => {
  it("希望日・出発地からの所要時間・知名度・加われるかを、データから出す", () => {
    expect(
      fitReasons(candidate, festival, { origin: "みなと中央駅" }, { ...DEFAULT_PREFERENCES }),
    ).toEqual([
      { kind: "onWishDay" },
      { kind: "fromOrigin", hub: "みなと中央駅", min: 40, max: 50 },
      { kind: "local" },
    ]);
  });

  it("定番どころを選んだ人には、知名度の低さを理由にしない", () => {
    const reasons = fitReasons(
      { ...candidate, daysFromWish: 2 },
      festival,
      {},
      { ...DEFAULT_PREFERENCES, spot: "classic" },
    );
    expect(reasons).toEqual([{ kind: "canJoin" }]);
  });

  it("祭りのデータがまだなければ、候補だけから分かる理由にとどめる", () => {
    expect(fitReasons(candidate, null, {}, { ...DEFAULT_PREFERENCES })).toEqual([
      { kind: "onWishDay" },
    ]);
    expect(fitReasons({ ...candidate, daysFromWish: -1 }, null, {}, DEFAULT_PREFERENCES)).toEqual(
      [],
    );
  });
});
