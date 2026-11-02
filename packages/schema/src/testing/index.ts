// テスト用の架空の祭りと出典。実在の祭りや場所ではない。
// 呼ぶたびに新しいオブジェクトを返すので、テストの中で書き換えてよい。
import type { Confidence, Source } from "../common";
import type { FestivalInput } from "../festival";

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
