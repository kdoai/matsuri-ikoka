// テスト用の架空の祭り・旅程・出典。実在の祭りや場所ではない。
// 呼ぶたびに新しいオブジェクトを返すので、テストの中で書き換えてよい。
import type { Confidence, Source } from "../common";
import type { FestivalInput } from "../festival";
import type { Itinerary, LodgingSearch } from "../itinerary";

export const FICTIONAL_FESTIVAL_ID = "suzunari-toro";

/** 架空の出典。URL は例示用のドメイン（example.com）にする */
export function fictionalSource(path: string, confidence: Confidence = "official"): Source {
  return { url: `https://example.com/suzunari/${path}`, checkedAt: "2026-04-01", confidence };
}

/** 架空の祭り「鈴鳴灯籠まつり」。スキーマのすべての必須項目を埋めてある */
export function fictionalFestival(): FestivalInput {
  return {
    id: FICTIONAL_FESTIVAL_ID,
    name: { ja: "鈴鳴灯籠まつり", en: "Suzunari Lantern Festival" },
    category: "lantern",
    municipalities: [{ prefecture: "滋賀県", name: "鈴鳴町" }],
    venue: { name: "鈴鳴川の河原", lat: 35.12, lng: 136.08 },
    scaleTier: "S",
    popularity: "local",
    listedIn: [],
    highlights: ["川面に浮かぶ千の灯籠", "宵の口の子ども囃子"],
    trivia: [
      {
        text: "灯籠の和紙は、町の小学生が毎年すいている",
        source: fictionalSource("history"),
      },
    ],
    etiquette: {
      participation: "join_by_application",
      howToJoin: "当日16時までに河原の受付で申し込む（灯籠1つ500円）",
      rules: ["灯籠は係の合図のあとに流す", "立入禁止の縄の内側に入らない"],
      dress: ["歩きやすい靴"],
      bring: ["懐中電灯"],
      risk: { level: "low", reason: "見学と灯籠流しだけ。夜の河原は足元が暗い" },
      photo: { policy: "restricted", note: "神事の間はフラッシュを使わない" },
      sources: [fictionalSource("etiquette")],
    },
    occurrences: [
      {
        date: "2026-08-16",
        start: "18:30",
        end: "21:00",
        status: "announced",
        rainPolicy: "小雨決行。荒天の場合は翌日に順延",
        sources: [fictionalSource("2026")],
      },
    ],
    access: {
      stations: [{ name: "鈴鳴駅", walkMinutes: [8, 12] }],
      fromHubs: [{ hub: "みなと中央駅", minutes: [40, 50], route: "鈴鳴線" }],
      parking: "none",
      trafficRestrictions: ["17時から22時まで、河原沿いの道は車両通行止め"],
      sources: [fictionalSource("access")],
    },
    food: {
      stalls: "yes",
      local: [
        { name: "鈴鳴そば", note: "町内のそば店で食べられる", sources: [fictionalSource("food")] },
      ],
    },
    nearby: [
      {
        id: "suzunari-craft-hall",
        name: "鈴鳴和紙の館",
        kind: "sightseeing",
        summary: "和紙すきを体験できる町の工房",
        location: { lat: 35.121, lng: 136.083 },
        walkMinutesFromVenue: [10, 15],
        hours: { open: "10:00", close: "17:00", lastEntry: "16:30" },
        closedDays: ["tue"],
        price: "和紙すき体験 600円",
        tags: ["kid_friendly", "indoor"],
        popularity: "local",
        sources: [fictionalSource("craft-hall", "corroborated")],
      },
    ],
    sources: [fictionalSource("about")],
    gaps: ["会場のトイレの数"],
  };
}

/** 架空の祭りへ行く日帰りの旅程（初版、1日） */
export function fictionalItinerary(): Itinerary {
  return {
    id: "trip-suzunari",
    version: 1,
    title: "鈴鳴の灯籠と川べりの夕べ",
    origin: "みなと中央駅",
    returnTo: "みなと中央駅",
    party: { adults: 2, children: 0 },
    preferences: { party: "adults", spot: "hidden", food: "local", move: "train" },
    mainFestivalId: FICTIONAL_FESTIVAL_ID,
    verification: { status: "pending" },
    days: [
      {
        date: "2026-08-16",
        weather: { status: "not_yet" },
        stay: null,
        items: [
          {
            id: "go",
            start: "14:30",
            end: "15:20",
            type: "move",
            name: "みなと中央駅から鈴鳴駅へ",
            location: null,
            reason: "鈴鳴線で乗り換えなしで行ける",
            move: { means: "train", minutes: [40, 50], estimate: true, note: "鈴鳴線" },
            hours: null,
            cost: null,
            sources: [fictionalSource("access")],
            changedInVersion: 1,
          },
          {
            id: "craft-hall",
            start: "15:30",
            end: "16:20",
            type: "sightseeing",
            name: "鈴鳴和紙の館",
            location: { lat: 35.121, lng: 136.083 },
            reason: "灯籠に使う和紙の作り方が分かる",
            move: { means: "walk", minutes: [5, 10], estimate: true },
            hours: { open: "10:00", close: "17:00", lastEntry: "16:30" },
            cost: "無料",
            spotId: "suzunari-craft-hall",
            sources: [fictionalSource("craft-hall", "corroborated")],
            changedInVersion: 1,
          },
          {
            id: "festival",
            start: "18:30",
            end: "21:00",
            type: "festival",
            name: "鈴鳴灯籠まつり",
            location: { lat: 35.12, lng: 136.08 },
            reason: "主役の祭り",
            move: { means: "walk", minutes: [10, 15], estimate: true },
            hours: null,
            cost: "無料",
            festivalId: FICTIONAL_FESTIVAL_ID,
            sources: [fictionalSource("2026")],
            changedInVersion: 1,
          },
        ],
      },
    ],
    notes: ["夜の河原は足元が暗いので、懐中電灯を持っていく"],
    alternatives: [{ kind: "rain", summary: "雨が強いときは、屋内の鈴鳴和紙の館を中心に過ごす" }],
  };
}

/**
 * 架空の宿を Web で調べた結果（鈴鳴町に1泊）。空きは調べていないので1泊の合計は null にし、
 * 宿のページの料金の目安・会場からの目安・挙がった観点を持つ。URL は example.com にする
 */
export function fictionalResearchedLodgingSearch(): LodgingSearch {
  const checkedAt = "2026-08-01T10:00:00+09:00";
  return {
    checkIn: "2026-08-15",
    checkOut: "2026-08-16",
    searchedAt: checkedAt,
    provider: "web",
    offers: [
      {
        id: "web-0123456789ab",
        name: "鈴鳴川の宿",
        nightlyTotalYen: null,
        perPersonNightYen: [8000, 11000],
        summary: "河原まで歩いてすぐの、和室のある宿",
        bookingUrl: "https://example.com/inn/kawa",
        location: { lat: 35.121, lng: 136.081 },
        fromVenue: { distanceKm: 0.1, mode: "walk", minutes: [1, 2] },
        perspectives: ["venue", "station"],
        checkedAt,
        source: {
          url: "https://example.com/inn/kawa",
          title: "鈴鳴川の宿",
          checkedAt: "2026-08-01",
          confidence: "corroborated",
        },
      },
      {
        id: "web-ba9876543210",
        name: "鈴鳴駅前ホテル",
        nightlyTotalYen: null,
        priceNote: "1室 12,000円から",
        bookingUrl: "https://example.com/inn/ekimae",
        location: { lat: 35.13, lng: 136.08 },
        fromVenue: { distanceKm: 1.1, mode: "walk", minutes: [13, 22] },
        perspectives: ["station"],
        checkedAt,
        source: {
          url: "https://example.com/inn/ekimae",
          checkedAt: "2026-08-01",
          confidence: "single",
        },
      },
    ],
  };
}

/** 架空の宿の空き（鈴鳴町に1泊、大人2人）。宿も予約のページも架空で、URL は example.com にする */
export function fictionalLodgingSearch(): LodgingSearch {
  const checkedAt = "2026-08-01T10:00:00+09:00";
  return {
    checkIn: "2026-08-15",
    checkOut: "2026-08-16",
    searchedAt: checkedAt,
    offers: [
      {
        id: "suzunari-kawabe-inn",
        name: "川べりの宿 すずなり",
        nightlyTotalYen: 24000,
        bookingUrl: "https://example.com/lodging/suzunari-kawabe-inn",
        location: { lat: 35.122, lng: 136.081 },
        checkedAt,
        source: {
          url: "https://example.com/lodging",
          checkedAt: "2026-08-01",
          confidence: "single",
        },
      },
    ],
  };
}
