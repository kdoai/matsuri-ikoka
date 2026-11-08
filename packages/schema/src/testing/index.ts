// テスト用の架空の祭り・旅程・出典。実在の祭りや場所ではない。
// 呼ぶたびに新しいオブジェクトを返すので、テストの中で書き換えてよい。
import type { Confidence, Source } from "../common";
import type { FestivalCandidate } from "../events";
import type { FestivalInput } from "../festival";
import type {
  CheckedChange,
  GuideMemoItem,
  GuideNotice,
  GuidePhoto,
  GuidePhotoType,
  GuideProposal,
  PatrolReport,
  PatrolRequest,
  TripWatch,
} from "../guide";
import type { Itinerary, LodgingSearch } from "../itinerary";

export const FICTIONAL_FESTIVAL_ID = "suzunari-toro";

/** 架空の出典。URL は例示用のドメイン（example.com）にする */
export function fictionalSource(path: string, confidence: Confidence = "official"): Source {
  return { url: `https://example.com/suzunari/${path}`, checkedAt: "2026-04-01", confidence };
}

/** 架空の祭りの候補カード */
export function fictionalCandidate(): FestivalCandidate {
  return {
    festivalId: FICTIONAL_FESTIVAL_ID,
    name: "鈴鳴灯籠まつり",
    date: "2026-08-15",
    start: "18:00",
    end: "21:00",
    venueName: "鈴鳴川の河原",
    place: "滋賀県鈴鳴町",
    daysFromWish: 0,
    confidence: "official",
    confirmed: true,
    highlight: "川面に浮かぶ千の灯籠",
    source: fictionalSource("schedule"),
  };
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
        meals: [
          {
            slot: "dinner",
            kind: "stalls",
            name: "会場の屋台",
            itemId: "festival",
            sources: [fictionalSource("2026")],
          },
        ],
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
 * 架空の祭りへ行く日帰りの旅程のうち、そろっているべきもの（移動の区間・乗り換え・最後の移動・帰り・
 * 帰りの最終・夜の食事・調べた場所の採否）がそろったもの
 */
export function fictionalPlannedItinerary(): Itinerary {
  const itinerary = fictionalItinerary();
  const day = itinerary.days[0] as Itinerary["days"][number];
  const [go, craftHall, festival] = day.items as [
    Itinerary["days"][number]["items"][number],
    Itinerary["days"][number]["items"][number],
    Itinerary["days"][number]["items"][number],
  ];
  go.move = {
    means: "train",
    minutes: [40, 50],
    estimate: true,
    note: "鈴鳴線",
    from: "みなと中央駅",
    to: "鈴鳴駅",
    purpose: "outbound",
    legs: [
      { means: "train", from: "みなと中央駅", to: "川辺駅", line: "みなと線", minutes: [15, 20] },
      { means: "train", from: "川辺駅", to: "鈴鳴駅", line: "鈴鳴線", minutes: [20, 25] },
    ],
  };
  craftHall.move = {
    means: "walk",
    minutes: [5, 10],
    estimate: true,
    from: "鈴鳴駅",
    to: "鈴鳴和紙の館",
    purpose: "between",
  };
  festival.move = {
    means: "walk",
    minutes: [10, 15],
    estimate: true,
    from: "鈴鳴和紙の館",
    to: "鈴鳴川の河原",
    purpose: "last_mile",
  };
  day.items.push({
    id: "back",
    start: "21:20",
    end: "22:20",
    type: "move",
    name: "鈴鳴駅からみなと中央駅へ",
    location: null,
    reason: "終わってすぐの電車は混むので、20分ほどずらして乗る",
    move: {
      means: "train",
      minutes: [50, 60],
      estimate: true,
      from: "鈴鳴川の河原",
      to: "みなと中央駅",
      purpose: "return",
      legs: [
        { means: "walk", from: "鈴鳴川の河原", to: "鈴鳴駅", line: null, minutes: [8, 12] },
        { means: "train", from: "鈴鳴駅", to: "川辺駅", line: "鈴鳴線", minutes: [20, 25] },
        { means: "train", from: "川辺駅", to: "みなと中央駅", line: "みなと線", minutes: [15, 20] },
      ],
    },
    hours: null,
    cost: null,
    sources: [fictionalSource("access")],
    changedInVersion: 1,
  });
  day.lastReturn = {
    station: "鈴鳴駅",
    departBy: "22:40",
    sources: [fictionalSource("access")],
  };
  itinerary.considered = [
    {
      id: "suzunari-craft-hall",
      name: "鈴鳴和紙の館",
      from: "nearby",
      adopted: true,
      reason: "灯籠に使う和紙の作り方が分かる",
    },
  ];
  return itinerary;
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

/** 架空の旅の見回りの依頼（旅の翌日に止まる） */
export function fictionalTripWatch(): TripWatch {
  return {
    tripId: "trip-suzunari",
    status: "active",
    startedAt: "2026-08-01T10:00:00+09:00",
    endsOn: "2026-08-17",
    stoppedAt: null,
    lastCheckedAt: "2026-08-10T06:00:00+09:00",
  };
}

/** 架空の祭りの見回りの依頼。公式のページの開始の時刻の行が変わった */
export function fictionalPatrolRequest(): PatrolRequest {
  return {
    patrolId: "patrol-0123456789abcdef",
    requestedAt: "2026-08-10T06:00:00+09:00",
    targets: [
      {
        festivalId: FICTIONAL_FESTIVAL_ID,
        festivalName: "鈴鳴灯籠まつり",
        date: "2026-08-16",
        pages: [
          {
            url: "https://example.com/suzunari/2026",
            reason: "changed",
            changedLines: ["開始 19:30 / 終了 21:30"],
          },
        ],
      },
    ],
  };
}

/** 架空の祭りの見回りの報告。公式のページで開始と終了の時刻が変わっていた */
export function fictionalPatrolReport(): PatrolReport {
  return {
    patrolId: "patrol-0123456789abcdef",
    findings: [
      {
        festivalId: FICTIONAL_FESTIVAL_ID,
        date: "2026-08-16",
        result: "changed",
        observed: { date: "2026-08-16", start: "19:30", end: "21:30" },
        topics: [],
        dateText: "令和8年8月16日 19時30分から",
        pages: ["https://example.com/suzunari/2026"],
      },
    ],
  };
}

/** 検問を通った架空の変化：開始と終了の時刻が1時間遅くなった */
export function fictionalCheckedChange(): CheckedChange {
  return {
    fingerprint: "0123456789abcdef",
    content: {
      kind: "schedule_change",
      festivalId: FICTIONAL_FESTIVAL_ID,
      date: "2026-08-16",
      changes: [
        { field: "start", before: "18:30", after: "19:30" },
        { field: "end", before: "21:00", after: "21:30" },
      ],
    },
    sources: [
      { url: "https://example.com/suzunari/2026", checkedAt: "2026-08-10", confidence: "official" },
    ],
    checkedAt: "2026-08-10T06:05:00+09:00",
  };
}

/** 架空の旅に届いた未読の通知 */
export function fictionalNotice(): GuideNotice {
  return {
    ...fictionalCheckedChange(),
    id: "notice-suzunari-1",
    tripId: "trip-suzunari",
    summary: "鈴鳴灯籠まつりの開始が 18:30 から 19:30 に変わりました",
    affectedItemIds: ["festival"],
    proposalId: "proposal-suzunari-1",
    createdAt: "2026-08-10T06:06:00+09:00",
    readAt: null,
  };
}

/** 架空の旅の組み直しの提案（第1版を、開始の時刻に合わせて第2版にする案）。承認を待っている */
export function fictionalProposal(): GuideProposal {
  const itinerary = fictionalItinerary();
  itinerary.version = 2;
  const festival = itinerary.days[0]?.items.find((item) => item.id === "festival");
  if (festival !== undefined) {
    festival.start = "19:30";
    festival.end = "21:30";
    festival.changedInVersion = 2;
  }
  return {
    id: "proposal-suzunari-1",
    tripId: itinerary.id,
    status: "pending",
    noticeIds: ["notice-suzunari-1"],
    summary: "祭りの時刻に合わせて、会場に着く時間を1時間遅らせます",
    baseVersion: 1,
    contentHash: "0123456789abcdef".repeat(4),
    itinerary,
    diff: { fromVersion: 1, toVersion: 2, added: [], changed: ["festival"], removed: [] },
    createdAt: "2026-08-10T06:06:00+09:00",
    expiresAt: "2026-08-16T00:00:00+09:00",
    decidedAt: null,
  };
}

/** ガイドの手帳の架空の項目 */
export function fictionalMemoItem(): GuideMemoItem {
  return {
    id: "memo-suzunari-1",
    kind: "pace",
    text: "連れは歩くのがゆっくり",
    createdAt: "2026-08-10T20:00:00+09:00",
    updatedAt: "2026-08-10T20:00:00+09:00",
  };
}

const PHOTO_HEADERS: Record<GuidePhotoType, number[]> = {
  "image/jpeg": [0xff, 0xd8, 0xff, 0xe0],
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/webp": [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
};

/**
 * 架空の写真。先頭のバイトだけ形式に合わせ、残りは埋め草（text を渡すと、その文字列の UTF-8 を入れる）。
 * 画像としては開けないが、形式と大きさの検証と、写真の中の文字を指示として扱わないことを確かめるのに使う
 */
export function fictionalPhoto(
  options: { mediaType?: GuidePhotoType; bytes?: number; text?: string } = {},
): GuidePhoto {
  const mediaType = options.mediaType ?? "image/jpeg";
  const header = PHOTO_HEADERS[mediaType];
  const text = Array.from(new TextEncoder().encode(options.text ?? ""));
  const size = Math.max(options.bytes ?? 300, header.length + text.length);
  const bytes = [...header, ...text];
  while (bytes.length < size) bytes.push(0x20);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { mediaType, data: btoa(binary) };
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
