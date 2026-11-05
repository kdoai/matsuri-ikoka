import {
  type Festival,
  FestivalSchema,
  type IsoDate,
  type ItineraryItem,
  type Weather,
} from "@matsuri-ikoka/schema";
import {
  FICTIONAL_FESTIVAL_ID,
  fictionalFestival,
  fictionalItinerary,
  fictionalSource,
} from "@matsuri-ikoka/schema/testing";
import { addDays } from "../domain/calendar";
import type { ShioriTrip, TripDay } from "./trip";

// テスト用の架空の旅（半日のお出かけ・週末の1泊・6泊7日）。実在の祭りや場所ではない。

export const SECOND_FESTIVAL_ID = "hoshimi-hanabi";

/** 架空の祭り2つ（鈴鳴灯籠まつりと、近くの町の架空の花火） */
export function fictionalFestivals(): Festival[] {
  const second = fictionalFestival();
  second.id = SECOND_FESTIVAL_ID;
  second.name = { ja: "星見浜の花火", en: "Hoshimi Beach Fireworks" };
  second.category = "fireworks";
  second.municipalities = [{ prefecture: "滋賀県", name: "星見町" }];
  second.venue = { name: "星見浜", lat: 35.2, lng: 136.1 };
  second.highlights = ["湖の上に開く尺玉", "浜に並ぶ手づくりの行灯"];
  second.etiquette = {
    participation: "watch_only",
    howToJoin: null,
    rules: ["打ち上げの場所の近くには入らない"],
    dress: "unknown",
    bring: ["敷物"],
    risk: "unknown",
    photo: "unknown",
    sources: [fictionalSource("hoshimi-etiquette")],
  };
  second.occurrences = [
    {
      date: "2026-08-19",
      start: "19:30",
      end: "20:30",
      status: "announced",
      rainPolicy: null,
      sources: [fictionalSource("hoshimi-2026")],
    },
  ];
  second.nearby = [];
  second.trivia = [];
  second.food = { stalls: "unknown", local: [] };
  return [FestivalSchema.parse(fictionalFestival()), FestivalSchema.parse(second)];
}

export function lookupOf(festivals: readonly Festival[]) {
  return (id: string) => festivals.find((f) => f.id === id);
}

function item(
  id: string,
  start: string,
  end: string,
  type: ItineraryItem["type"],
  name: string,
  reason: string,
  extra: Partial<ItineraryItem> = {},
): ItineraryItem {
  return {
    id,
    start,
    end,
    type,
    name,
    location: null,
    reason,
    move: null,
    hours: null,
    cost: null,
    sources: [],
    changedInVersion: 1,
    ...extra,
  };
}

const train = (minutes: [number, number], note?: string): ItineraryItem["move"] => ({
  means: "train",
  minutes,
  estimate: true,
  ...(note ? { note } : {}),
});
const walk = (minutes: [number, number]): ItineraryItem["move"] => ({
  means: "walk",
  minutes,
  estimate: true,
});

function festivalItem(id: string, start: string, end: string, festivalId: string, name: string) {
  return item(id, start, end, "festival", name, "主役の祭り", {
    festivalId,
    move: walk([10, 15]),
    cost: "無料",
    location: { lat: 35.12, lng: 136.08 },
    sources: [fictionalSource(festivalId === FICTIONAL_FESTIVAL_ID ? "2026" : "hoshimi-2026")],
  });
}

const forecast = (summary: string, rain: number): Weather => ({
  status: "forecast",
  summary,
  precipitationPercent: rain,
  highC: 31,
  lowC: 24,
  source: fictionalSource("weather"),
});

function baseTrip(days: TripDay[]): ShioriTrip {
  const it = fictionalItinerary();
  return {
    id: it.id,
    version: 2,
    title: it.title,
    origin: it.origin,
    returnTo: it.returnTo,
    party: it.party,
    preferences: it.preferences,
    mainFestivalId: FICTIONAL_FESTIVAL_ID,
    verification: {
      status: "as_planned",
      checkedAt: "2026-08-14T10:00:00+09:00",
      sources: [fictionalSource("2026")],
    },
    days,
    notes: [...it.notes],
    alternatives: [...it.alternatives],
    style: {},
  };
}

/** 半日のお出かけ（夕方から夜まで） */
export function fictionalOuting(): ShioriTrip {
  return baseTrip([
    {
      date: "2026-08-16",
      weather: forecast("晴れ時々くもり", 20),
      stay: null,
      items: [
        item(
          "go",
          "16:00",
          "16:50",
          "move",
          "みなと中央駅から鈴鳴駅へ",
          "鈴鳴線で乗り換えなしで行ける",
          {
            move: train([40, 50], "鈴鳴線"),
            sources: [fictionalSource("access")],
          },
        ),
        item("dinner", "17:00", "18:00", "meal", "鈴鳴そば", "町内のそば店で、地元の味を先に", {
          move: walk([5, 10]),
          cost: "1000円前後",
        }),
        festivalItem("festival", "18:30", "21:00", FICTIONAL_FESTIVAL_ID, "鈴鳴灯籠まつり"),
        item("back", "21:10", "22:00", "move", "鈴鳴駅からみなと中央駅へ", "混む前に帰る", {
          move: train([40, 50]),
        }),
      ],
    },
  ]);
}

const CRAFT_HALL = (id: string, start: string, end: string) =>
  item(id, start, end, "sightseeing", "鈴鳴和紙の館", "灯籠に使う和紙の作り方が分かる", {
    spotId: "suzunari-craft-hall",
    move: walk([5, 10]),
    hours: { open: "10:00", close: "17:00", lastEntry: "16:30" },
    cost: "和紙すき体験 600円",
    location: { lat: 35.121, lng: 136.083 },
    sources: [fictionalSource("craft-hall", "corroborated")],
  });

/** 週末の1泊（祭りの夜に泊まり、次の日に帰る） */
export function fictionalWeekend(): ShioriTrip {
  const trip = baseTrip([
    {
      date: "2026-08-16",
      weather: forecast("くもり", 30),
      stay: null,
      items: [
        item(
          "go",
          "13:00",
          "13:50",
          "move",
          "みなと中央駅から鈴鳴駅へ",
          "鈴鳴線で乗り換えなしで行ける",
          {
            move: train([40, 50], "鈴鳴線"),
            sources: [fictionalSource("access")],
          },
        ),
        CRAFT_HALL("craft-hall", "14:10", "15:30"),
        item("rest", "15:40", "16:30", "rest", "川べりの休憩所", "夜に備えて一息つく", {
          move: walk([5, 10]),
        }),
        item(
          "prep",
          "17:30",
          "18:00",
          "festival_prep",
          "河原の受付で灯籠を申し込む",
          "16時までの申し込みに間に合わせる",
          {
            move: walk([10, 15]),
          },
        ),
        festivalItem("festival", "18:30", "21:00", FICTIONAL_FESTIVAL_ID, "鈴鳴灯籠まつり"),
      ],
    },
    {
      date: "2026-08-17",
      weather: forecast("雨のち晴れ", 60),
      stay: null,
      items: [
        item("breakfast", "08:00", "09:00", "meal", "宿の近くで朝ごはん", "ゆっくり起きて朝ごはん"),
        item(
          "walk",
          "09:30",
          "11:00",
          "sightseeing",
          "鈴鳴川の朝さんぽ",
          "灯籠を流した川を朝の光で見る",
          {
            move: walk([10, 15]),
          },
        ),
        item("lunch", "11:30", "12:30", "meal", "鈴鳴そば", "町内のそば店で地元の味", {
          move: walk([5, 10]),
          cost: "1000円前後",
        }),
        item("back", "13:00", "13:50", "move", "鈴鳴駅からみなと中央駅へ", "お昼のあとに帰る", {
          move: train([40, 50]),
        }),
      ],
    },
  ]);
  (trip.days[0] as TripDay).stay = {
    area: "鈴鳴駅の周り",
    note: "祭りの夜は混むので、早めに予約を",
  };
  return trip;
}

/** 6泊7日（3日目に主役の祭り、6日目に別の祭り） */
export function fictionalWeek(): ShioriTrip {
  const start: IsoDate = "2026-08-14";
  const areas = [
    "鈴鳴駅の周り",
    "鈴鳴駅の周り",
    "鈴鳴の温泉街",
    "星見町の浜の近く",
    "星見町の浜の近く",
    "星見町の駅前",
  ];
  const days: TripDay[] = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(start, i);
    const weather: Weather =
      i < 3 ? forecast(i === 1 ? "晴れ" : "くもり時々晴れ", 10 + i * 10) : { status: "not_yet" };
    let items: ItineraryItem[];
    if (i === 0) {
      items = [
        item(
          "d1-go",
          "10:00",
          "10:50",
          "move",
          "みなと中央駅から鈴鳴駅へ",
          "鈴鳴線で乗り換えなしで行ける",
          {
            move: train([40, 50], "鈴鳴線"),
            sources: [fictionalSource("access")],
          },
        ),
        item("d1-lunch", "11:30", "12:30", "meal", "鈴鳴そば", "まずは町の名物で腹ごしらえ", {
          move: walk([5, 10]),
        }),
        CRAFT_HALL("d1-craft", "13:00", "15:00"),
      ];
    } else if (i === 2) {
      items = [
        item("d3-rest", "10:00", "12:00", "rest", "宿でのんびり", "夜の祭りに備えて体を休める"),
        item(
          "d3-prep",
          "16:00",
          "16:30",
          "festival_prep",
          "河原の受付で灯籠を申し込む",
          "受付は16時まで",
          {
            move: walk([10, 15]),
          },
        ),
        festivalItem("d3-festival", "18:30", "21:00", FICTIONAL_FESTIVAL_ID, "鈴鳴灯籠まつり"),
      ];
    } else if (i === 5) {
      items = [
        item(
          "d6-beach",
          "15:00",
          "17:00",
          "sightseeing",
          "星見浜の散歩",
          "花火の前に浜の様子を見ておく",
        ),
        item("d6-dinner", "17:30", "18:30", "meal", "浜の近くで夕ごはん", "混む前に早めの夕食"),
        festivalItem("d6-festival", "19:30", "20:30", SECOND_FESTIVAL_ID, "星見浜の花火"),
      ];
    } else if (i === 6) {
      items = [
        item("d7-souvenir", "10:00", "11:00", "sightseeing", "星見町の朝市", "おみやげを選ぶ"),
        item(
          "d7-back",
          "12:00",
          "13:30",
          "move",
          "星見駅からみなと中央駅へ",
          "お昼すぎに家に着く",
          {
            move: train([80, 90]),
          },
        ),
      ];
    } else {
      items = [
        item(
          `d${i + 1}-am`,
          "09:30",
          "12:00",
          "sightseeing",
          `町歩き ${i + 1}日目`,
          "気になったところをゆっくり歩く",
        ),
        item(`d${i + 1}-lunch`, "12:00", "13:00", "meal", "地元の食堂", "その日の気分で選ぶ"),
        item(
          `d${i + 1}-pm`,
          "14:00",
          "16:00",
          "rest",
          "宿の近くで休憩",
          "長い旅なので、休む時間も予定に入れる",
        ),
      ];
    }
    return { date, weather, items, stay: i < 6 ? { area: areas[i] as string } : null };
  });
  const trip = baseTrip(days);
  trip.title = "灯籠と花火をめぐる湖の一週間";
  trip.style = { pace: "relaxed", interests: ["onsen", "food"] };
  return trip;
}

/**
 * 予定の多い日帰り（車で朝から夜まで）。理由の文も長く、1ページに入りきらない日を確かめるのに使う。
 * シニアと一緒の旅にして、文字をひとまわり大きくする
 */
export function fictionalCrowdedDay(): ShioriTrip {
  const long =
    "会場の近くは駐車場が少ないので、早めに町に入って車を停め、子どもが休めるよう屋根のある場所を間にはさむ";
  const car = (minutes: [number, number]): ItineraryItem["move"] => ({
    means: "car",
    minutes,
    estimate: true,
    note: "会場の近くは夕方から交通規制",
  });
  const spots = ["鈴鳴和紙の館", "鈴鳴川の遊歩道", "鈴鳴の古い町並み", "鈴鳴の郷土資料館"];
  const trip = baseTrip([
    {
      date: "2026-08-16",
      weather: forecast("晴れ時々くもり", 20),
      stay: null,
      items: [
        item("go", "08:30", "09:30", "move", "みなと中央市から鈴鳴町へ（車）", long, {
          move: car([50, 60]),
        }),
        ...spots.map((name, i) =>
          item(`spot-${i}`, `${10 + i}:00`, `${10 + i}:50`, "sightseeing", name, long, {
            move: walk([5, 10]),
            hours: { open: "09:00", close: "17:00", lastEntry: "16:30" },
            cost: "大人 500円・子ども 200円",
          }),
        ),
        item("lunch", "14:00", "15:00", "meal", "鈴鳴そば", long, { cost: "1000円前後" }),
        item("rest", "15:10", "16:00", "rest", "川べりの休憩所", long, { move: walk([5, 10]) }),
        item("dinner", "16:10", "17:00", "meal", "河原の屋台で夕食", long),
        item("prep", "17:10", "18:00", "festival_prep", "観覧の場所で待つ", long, {
          move: walk([10, 15]),
        }),
        festivalItem("festival", "18:30", "21:00", FICTIONAL_FESTIVAL_ID, "鈴鳴灯籠まつり"),
        item("wait", "21:00", "21:40", "rest", "混雑が引くまで休む", long),
        item("back", "21:40", "22:40", "move", "鈴鳴町からみなと中央市へ（車）", long, {
          move: car([50, 60]),
        }),
      ],
    },
  ]);
  trip.party = { adults: 2, children: 1 };
  trip.preferences = { ...trip.preferences, party: "seniors" };
  return trip;
}
