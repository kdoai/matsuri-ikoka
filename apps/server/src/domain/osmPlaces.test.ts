import { describe, expect, it } from "vitest";
import {
  createOsmPlaceIndex,
  OSM_ATTRIBUTION,
  type OsmPlace,
  osmFoods,
  osmLodgingOffers,
  osmPageUrl,
  osmSpotReport,
  parseOpeningHours,
} from "./osmPlaces";

// 店と宿はすべて架空。2026-08-16 は日曜、2026-08-17 は月曜
const SUNDAY = "2026-08-16";
const MONDAY = "2026-08-17";
const venue = { lat: 35.12, lng: 136.08 };

function place(edit: Partial<OsmPlace> = {}): OsmPlace {
  return {
    type: "node",
    id: 101,
    name: "鈴鳴食堂",
    location: { lat: 35.121, lng: 136.081 },
    tags: { amenity: "restaurant" },
    ...edit,
  };
}

describe("createOsmPlaceIndex", () => {
  const index = createOsmPlaceIndex([
    place({ id: 1, name: "遠い店", location: { lat: 35.2, lng: 136.08 } }),
    place({ id: 2, name: "二番目の店", location: { lat: 35.13, lng: 136.08 } }),
    place({ id: 3, name: "近い店", location: { lat: 35.121, lng: 136.08 } }),
    place({
      id: 4,
      name: "宿",
      location: { lat: 35.121, lng: 136.08 },
      tags: { tourism: "hotel" },
    }),
  ]);

  it("種類と半径で絞り、近い順に返す", () => {
    expect(index.find("food", venue, 3).map((p) => p.name)).toEqual(["近い店", "二番目の店"]);
    expect(index.find("lodging", venue, 3).map((p) => p.name)).toEqual(["宿"]);
    expect(index.find("food", { lat: 40, lng: 140 }, 3)).toEqual([]);
  });
});

describe("osmFoods", () => {
  it("cuisine のタグと、店の名前の料理の言葉から決める", () => {
    expect(osmFoods(place({ tags: { cuisine: "ramen;sushi" } }))).toEqual(["noodles", "seafood"]);
    expect(osmFoods(place({ name: "炭火焼肉 鈴鳴", tags: {} }))).toEqual(["meat"]);
    expect(osmFoods(place({ name: "鈴鳴亭", tags: { amenity: "cafe" } }))).toEqual(["sweets"]);
  });

  it("分からない店には料理を足さない", () => {
    expect(osmFoods(place({ tags: { cuisine: "unknown_style" } }))).toEqual([]);
  });
});

describe("parseOpeningHours", () => {
  it("曜日と時刻を読み、書かれていない曜日と off を定休日にする", () => {
    const opening = parseOpeningHours("Mo-We,Fr-Su 11:00-15:00,17:30-21:30", SUNDAY);
    expect(opening).toEqual({
      hours: { open: "11:00", close: "21:30" },
      closedDays: ["thu"],
      openOnDate: "unconfirmed",
    });
    expect(parseOpeningHours("Tu-Su 10:00-20:00; Mo off", MONDAY)).toEqual({
      hours: null,
      closedDays: ["mon"],
      openOnDate: "closed",
    });
  });

  it("曜日のない時刻は毎日。あとの決まりが前の決まりを上書きする", () => {
    expect(parseOpeningHours("10:00-20:00; Su off", MONDAY).hours).toEqual({
      open: "10:00",
      close: "20:00",
    });
    expect(parseOpeningHours("10:00-20:00; Su off", SUNDAY).openOnDate).toBe("closed");
  });

  it("日をまたぐ営業と 24/7 を読む", () => {
    expect(parseOpeningHours("Mo-Su 18:00-02:00", SUNDAY).hours).toEqual({
      open: "18:00",
      close: "02:00",
    });
    expect(parseOpeningHours("24/7", SUNDAY)).toEqual({
      hours: null,
      closedDays: [],
      openOnDate: "unconfirmed",
    });
  });

  it("読めない書き方は、分からないとして扱う（休みと決めつけない）", () => {
    for (const value of [undefined, "Jan-Mar 10:00-17:00", "sunrise-sunset", "by appointment"]) {
      expect(parseOpeningHours(value, SUNDAY)).toEqual({
        hours: null,
        closedDays: null,
        openOnDate: "unconfirmed",
      });
    }
  });

  it("営業中と読めても、臨時休業は分からないので確かめ済みにしない", () => {
    expect(parseOpeningHours("Mo-Su 11:00-20:00", SUNDAY).openOnDate).toBe("unconfirmed");
  });
});

describe("osmSpotReport", () => {
  it("出典は元のページで、題名に帰属の表示を入れ、料金は書かない", () => {
    const report = osmSpotReport(place({ tags: { cuisine: "soba", "diet:vegan": "yes" } }), SUNDAY);
    expect(report).toMatchObject({
      name: "鈴鳴食堂",
      kind: "food",
      foods: ["noodles"],
      dietaryOk: ["vegan"],
      pricePerPersonYen: null,
      openOnDate: "unconfirmed",
    });
    expect(report.summary).toContain("OpenStreetMap");
    expect(report.sources).toEqual([
      { url: "https://www.openstreetmap.org/node/101", title: OSM_ATTRIBUTION },
    ]);
  });
});

describe("osmLodgingOffers", () => {
  const options = { venue, checkedAt: "2026-08-03T10:15:00+09:00", today: "2026-08-03" };
  const hotel = (name: string, lat: number, tags: Record<string, string> = {}) =>
    place({
      name,
      id: lat * 1000,
      location: { lat, lng: 136.08 },
      tags: { tourism: "hotel", ...tags },
    });

  it("会場に近い順に3件まで。遠い宿と、泊まれない場所は除く", () => {
    const offers = osmLodgingOffers(
      [
        hotel("遠い宿", 35.4),
        hotel("鈴鳴社員寮", 35.121),
        hotel("二番目の宿", 35.13),
        hotel("近い宿", 35.122),
        hotel("三番目の宿", 35.135),
        hotel("四番目の宿", 35.14),
      ],
      options,
    );
    expect(offers.map((o) => o.name)).toEqual(["近い宿", "二番目の宿", "三番目の宿"]);
  });

  it("空きと料金は書かず、出典に帰属の表示を入れる", () => {
    const [offer] = osmLodgingOffers(
      [hotel("鈴鳴の宿", 35.122, { website: "https://example.com/inn" })],
      options,
    );
    expect(offer).toMatchObject({
      nightlyTotalYen: null,
      bookingUrl: "https://example.com/inn",
      source: { title: OSM_ATTRIBUTION, confidence: "single" },
    });
    expect(offer?.source?.url).toBe(osmPageUrl({ type: "node", id: 35122 }));
  });

  it("宿のページがないか、http でないときは、Google マップの検索へ案内する", () => {
    const offers = osmLodgingOffers(
      [
        hotel("ページなし", 35.122),
        hotel("危ないページ", 35.123, { website: "javascript:alert(1)" }),
      ],
      options,
    );
    for (const offer of offers) {
      expect(offer.bookingUrl.startsWith("https://www.google.com/maps/search/")).toBe(true);
    }
  });
});
