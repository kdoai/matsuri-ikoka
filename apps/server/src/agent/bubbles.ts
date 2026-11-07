import {
  type DateWish,
  DateWishSchema,
  type IsoDate,
  type Preferences,
  PreferencesSchema,
  type RedoSubject,
  type SseEventOf,
  type StaffId,
  type ToolName,
  type VerificationResult,
} from "@matsuri-ikoka/schema";
import { formatMonthDay } from "../domain/calendar";

// 吹き出しの文章。サーバーがツールの入力と結果から決まった型で作り、モデルには書かせない。
// 入力の形が崩れていても、決まった文に戻す。
// 吹き出し（bubble）は短く、店内のようすの窓に出す文（detail）は、見つけたものの件数と代表の1件まで言う。
// 店や祭りの名前などの集めた文字列は、信用しない入力として、長さを切った文字列としてだけ埋め込む。

export const STAFF_NAMES: Record<StaffId, string> = {
  concierge: "コンシェルジュ",
  researcher: "祭り調査係",
  scout: "周辺係",
  planner: "旅程係",
};

export const STAFF_TASK = {
  researcher: "find_festivals",
  scout: "find_nearby",
  planner: "plan_route",
} as const;

export type Staff = keyof typeof STAFF_TASK;

export function staffStartBubble(staff: Staff, options: { hasItinerary: boolean }): string {
  switch (staff) {
    case "researcher":
      return "調べてきますね";
    case "scout":
      return "寄り道を探してきます";
    case "planner":
      return options.hasItinerary ? "組み直します" : "道のりを調べます";
  }
}

function wishLabel(wish: DateWish): string {
  if (wish.kind === "date") return formatMonthDay(wish.date);
  return wish.from === wish.to
    ? formatMonthDay(wish.from)
    : `${formatMonthDay(wish.from)}から${formatMonthDay(wish.to)}`;
}

function field(input: unknown, key: string): unknown {
  return input !== null && typeof input === "object"
    ? (input as Record<string, unknown>)[key]
    : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isIsoDate(value: unknown): value is IsoDate {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** 文に埋め込む名前の長さの上限 */
const NAME_LIMIT = 20;

/** 集めた文字列を、文に埋め込める1行にする（空白を詰め、長ければ切る）。文字列でなければ null */
export function plainName(value: unknown, limit = NAME_LIMIT): string | null {
  if (typeof value !== "string") return null;
  const flat = value.replace(/[\s「」]+/g, " ").trim();
  if (flat === "") return null;
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** 「名前」の形。名前がなければ null */
function quoted(value: unknown): string | null {
  const name = plainName(value);
  return name === null ? null : `「${name}」`;
}

/** 分を「1時間40分」の形にする */
export function formatMinutes(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m}分`;
  return m % 60 === 0 ? `${m / 60}時間` : `${Math.floor(m / 60)}時間${m % 60}分`;
}

/** 分の幅（[最短, 最長]）。形が崩れていれば null */
function minuteRange(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [low, high] = value;
  if (typeof low !== "number" || typeof high !== "number") return null;
  if (!Number.isFinite(low) || !Number.isFinite(high) || low < 0 || high < low) return null;
  return [low, high];
}

/** 分の幅を「10〜15分」「約2時間」の形にする */
export function formatMinuteRange([low, high]: [number, number]): string {
  if (low === high) return `約${formatMinutes(low)}`;
  if (high < 60) return `${Math.round(low)}〜${Math.round(high)}分`;
  return `${formatMinutes(low)}〜${formatMinutes(high)}`;
}

/** 吹き出しの短い文と、店内のようすの窓に出す、くわしい文 */
export interface Lines {
  bubble: string;
  detail?: string;
}

/** 周辺の場所の種類の呼び方と数え方 */
const SPOT_KINDS = {
  food: { label: "食事どころ", unit: "軒" },
  sightseeing: { label: "見どころ", unit: "か所" },
  rest: { label: "休めるところ", unit: "か所" },
} as const;
type SpotKind = keyof typeof SPOT_KINDS;
const SPOT_ORDER = Object.keys(SPOT_KINDS) as SpotKind[];

function isSpotKind(value: unknown): value is SpotKind {
  return value === "food" || value === "sightseeing" || value === "rest";
}

/** 種類ごとの数（種類の分からない場所は数えない） */
function countKinds(spots: readonly unknown[]): Map<SpotKind, number> {
  const counts = new Map<SpotKind, number>();
  for (const spot of spots) {
    const kind = field(spot, "kind");
    if (isSpotKind(kind)) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return counts;
}

/** 種類ごとの数を「食事どころを3軒、見どころを1か所」の形にする */
function countByKind(counts: Map<SpotKind, number>): string {
  return [...counts]
    .sort(([a], [b]) => SPOT_ORDER.indexOf(a) - SPOT_ORDER.indexOf(b))
    .map(([kind, n]) => `${SPOT_KINDS[kind].label}を${n}${SPOT_KINDS[kind].unit}`)
    .join("、");
}

/** 吹き出しは短くするので、種類が混ざるときは、全体の数と食事どころの数だけを言う */
function nearbyBubble(counts: Map<SpotKind, number>, total: number): string {
  const [only] = counts;
  if (counts.size === 1 && only !== undefined && only[1] === total) {
    const [kind, n] = only;
    return `${SPOT_KINDS[kind].label}を${n}${SPOT_KINDS[kind].unit}見つけました`;
  }
  const food = counts.get("food") ?? 0;
  return food > 0
    ? `${total}か所見つけました。うち食事どころ${food}軒`
    : `${total}か所見つけました`;
}

/** search_nearby の吹き出しの「何を探すか」 */
function nearbyTargets(preferences: Preferences): string {
  const parts: string[] = [];
  if (preferences.food === "local") parts.push("地元の味");
  if (preferences.party === "kids") parts.push("子どもと楽しめる場所");
  else if (preferences.party === "seniors") parts.push("座って休める場所");
  if (preferences.spot === "hidden") parts.push("人の少ない場所");
  else if (preferences.spot === "classic") parts.push("定番の場所");
  return parts.length === 0 ? "寄れる場所" : parts.join("と");
}

export function toolStartBubble(
  tool: ToolName,
  input: unknown,
  state: { preferences: Preferences; hasItinerary: boolean },
): string {
  switch (tool) {
    case "search_festivals": {
      const wish = DateWishSchema.safeParse(field(input, "when"));
      const origin = field(input, "origin");
      const nights = field(input, "nights");
      const limit = field(input, "maxTravelMinutes");
      const dayTrip =
        typeof limit === "number" && Number.isInteger(limit) && limit > 0
          ? `片道${limit % 60 === 0 ? `${limit / 60}時間` : `${limit}分`}以内の日帰りで`
          : "日帰りで";
      const stay =
        nights === 0 ? dayTrip : typeof nights === "number" && nights > 0 ? `${nights}泊で` : "";
      if (!wish.success || typeof origin !== "string" || origin.trim() === "") {
        return "条件に合う祭りを探しています";
      }
      const widen = field(input, "widen");
      const names = field(input, "destinations");
      const place =
        widen === "nationwide"
          ? "日本全国で、"
          : widen === "neighbor"
            ? "隣の県まで広げて、"
            : Array.isArray(names) &&
                names.length > 0 &&
                names.every((n) => typeof n === "string" && n.trim() !== "")
              ? `${names
                  .map((n: string) => n.trim())
                  .join("・")
                  .slice(0, 20)}で、`
              : "";
      return `${wishLabel(wish.data)}に、${place}${origin.trim().slice(0, 20)}から${stay}行ける祭りを探しています`;
    }
    case "search_nearby": {
      const given = PreferencesSchema.safeParse(field(input, "preferences"));
      return `会場の近くで、${nearbyTargets(given.success ? given.data : state.preferences)}を探しています`;
    }
    case "get_access": {
      const move = field(input, "move") ?? state.preferences.move;
      return move === "car"
        ? "車の道のりと駐車場を確かめています"
        : "電車の所要時間を確かめています";
    }
    case "research_route": {
      const origin = plainName(field(input, "origin"));
      return origin === null
        ? "出発の駅からの乗り換えを調べています"
        : `${origin}からの乗り換えを調べています`;
    }
    case "get_weather": {
      const date = field(input, "date");
      return isIsoDate(date)
        ? `${formatMonthDay(date)}の天気を確かめています`
        : "当日の天気を確かめています";
    }
    case "search_lodging": {
      const checkIn = field(input, "checkIn");
      const nights = field(input, "nights");
      if (!isIsoDate(checkIn)) return "泊まる宿を探しています";
      return typeof nights === "number" && Number.isInteger(nights) && nights > 0
        ? `${formatMonthDay(checkIn)}から${nights}泊の宿を探しています`
        : `${formatMonthDay(checkIn)}に泊まる宿を探しています`;
    }
    case "update_itinerary": {
      const day = field(field(input, "addDay"), "day");
      const dayDate = field(day, "date");
      if (isIsoDate(dayDate)) {
        return `${formatMonthDay(dayDate)}の予定を書き込んでいます`;
      }
      return state.hasItinerary ? "旅程を書き直しています" : "旅程を書き込んでいます";
    }
    case "verify_festival":
      return "旅程を確定しています";
  }
}

const VERIFIED_BUBBLES: Record<VerificationResult, string> = {
  as_planned: "開催予定を公式情報で確認しました",
  needs_check: "開催の情報を見つけました（出発前に要確認）",
  changed: "開催の内容に変更がありました",
  cancelled: "中止が発表されていました",
  not_found: "開催の情報が見つかりませんでした",
};

/**
 * ツールが失敗したときの吹き出し。スタッフは理由を読んで続けるので、失敗で止まったようには言わない。
 * 旅程の保存は、書き方の誤りで断られたら直して保存し直す
 */
const RETRY_BUBBLES: Partial<Record<ToolName, string>> = {
  update_itinerary: "旅程を整えています",
  verify_festival: "開催の情報を確かめています",
};
const RETRY_BUBBLE = "もう少し調べています";

/** ツールの後の吹き出し・くわしい文・件数 */
export interface ToolEnd extends Lines {
  ok: boolean;
  count: number | null;
}

/** 文の部品をつなぐ。null は飛ばす */
function sentences(parts: readonly (string | null)[]): string {
  return parts.filter((part) => part !== null).join("。");
}

/** search_festivals の後。件数・希望の日に合う数・いちばん上の1件 */
function festivalsEnd(output: Record<string, unknown>): ToolEnd {
  const candidates = list(output.candidates);
  const count = candidates.length;
  const needsConsent = field(output.destination, "needsConsent");
  if (needsConsent === "neighbor" || needsConsent === "nationwide") {
    return {
      ok: true,
      bubble:
        needsConsent === "neighbor"
          ? "選んだ地域には見つかりませんでした。隣の県にはあります"
          : "選んだ地域と隣の県には見つかりませんでした",
      detail:
        needsConsent === "neighbor"
          ? "選んだ地域には、条件に合う祭りがありませんでした。隣の県まで広げて探してよいか、確かめます"
          : "選んだ地域と隣の県には、条件に合う祭りがありませんでした。日本全国から探してよいか、確かめます",
      count: 0,
    };
  }
  if (count === 0) {
    return {
      ok: true,
      bubble: "条件に合う祭りが見つかりませんでした",
      detail:
        "希望の日と出発地から行ける祭りが、データにありませんでした。日や条件を変えて探せます",
      count,
    };
  }
  const stage = field(output.destination, "stage");
  const where = stage === "neighbor" ? "隣の県で" : stage === "nationwide" ? "日本全国から" : "";
  const found =
    stage === "nationwide"
      ? `日本全国から${count}件選びました`
      : `${where}${count}件見つかりました`;
  const top = quoted(field(candidates[0], "name"));
  const onWish = candidates.filter((c) => field(c, "daysFromWish") === 0).length;
  const unconfirmed = candidates.filter((c) => field(c, "confirmed") === false).length;
  let about: string | null = null;
  if (top !== null) {
    const date = field(candidates[0], "date");
    const where = [
      isIsoDate(date) ? formatMonthDay(date) : null,
      plainName(field(candidates[0], "place")),
    ]
      .filter((v) => v !== null)
      .join("・");
    about = `いちばん上は${top}${where === "" ? "" : `（${where}）`}です`;
  }
  return {
    ok: true,
    bubble: top === null ? found : `${found}。いちばん上は${top}`,
    detail: sentences([
      onWish === count
        ? `${where}希望の日に開かれる祭りを${count}件見つけました`
        : onWish === 0
          ? `${where}希望の日の前後に開かれる祭りを${count}件見つけました`
          : `${where}希望の日に開かれる祭りを${onWish}件、前後の日を${count - onWish}件見つけました`,
      about,
      unconfirmed > 0 ? `うち${unconfirmed}件は、開催をまだ確かめられていません` : null,
    ]),
    count,
  };
}

/** search_nearby の後。種類ごとの数と、会場からいちばん近い1か所 */
function nearbyEnd(output: Record<string, unknown>): ToolEnd {
  const spots = list(output.spots);
  const count = spots.length;
  const foodMissed =
    field(output.research, "foodFound") === false
      ? "食べたいものに合う店は、調べても見つかりませんでした"
      : null;
  const area = plainName(output.area);
  if (count === 0) {
    return {
      ok: true,
      bubble: "寄れる場所が見つかりませんでした",
      detail: sentences([
        area === null
          ? "会場の近くに、条件に合う場所が見つかりませんでした"
          : `${area}に、寄れる場所がデータにありませんでした`,
        foodMissed,
        "その時間は、自由に過ごす時間にします",
      ]),
      count,
    };
  }
  // 種類の分からない場所しかなければ、数だけを言う
  const counts = countKinds(spots);
  const bubble = nearbyBubble(counts, count);
  const found = countByKind(counts) || `${count}か所を`;
  if (area !== null) {
    const onDate = list(output.festivalsOnDate).length;
    return {
      ok: true,
      bubble,
      detail: sentences([
        `${area}で、${found}見つけました`,
        onDate > 0 ? `その日に開かれる祭りも${onDate}件あります` : null,
      ]),
      count,
    };
  }
  const walks = spots.map((spot) => minuteRange(field(spot, "walkMinutesFromVenueEstimate")));
  const known = walks.filter((walk) => walk !== null);
  const within = known.length === walks.length ? Math.max(...known.map(([, high]) => high)) : null;
  // いちばん近いのは、歩く時間の目安の最短がいちばん短い場所
  let nearest: { name: string; walk: [number, number] } | null = null;
  for (const [index, spot] of spots.entries()) {
    const walk = walks[index] ?? null;
    const name = quoted(field(spot, "name"));
    if (walk === null || name === null) continue;
    if (nearest === null || walk[0] < nearest.walk[0]) nearest = { name, walk };
  }
  const needsCheck = spots.filter((spot) => field(spot, "openStatus") === "needs_check").length;
  return {
    ok: true,
    bubble,
    detail: sentences([
      within === null
        ? `会場の近くで、${found}見つけました`
        : `会場から歩いて${within}分以内に、${found}見つけました`,
      nearest === null
        ? null
        : `いちばん近いのは${nearest.name}（歩いて${formatMinuteRange(nearest.walk)}）です`,
      needsCheck > 0 ? `うち${needsCheck}か所は、行く日の営業を確かめられませんでした` : null,
      foodMissed,
    ]),
    count,
  };
}

/** get_access の後。出発の駅から会場までの目安と、最寄り駅からの歩き */
function accessEnd(output: Record<string, unknown>): ToolEnd {
  const door = minuteRange(field(output.fromOrigin, "doorToVenueMinutesEstimate"));
  const origin = plainName(field(output.fromOrigin, "origin")) ?? "出発の駅";
  const hub = plainName(field(output.fromOrigin, "hub"));
  const station = list(output.stations)[0];
  const stationName = plainName(field(station, "name"));
  const walk = minuteRange(field(station, "walkMinutesEstimate"));
  const parking =
    output.move !== "car"
      ? null
      : output.parking === "none"
        ? "会場の近くに駐車場はありません"
        : output.parking === "limited"
          ? "駐車場は限られています"
          : output.parking === "available"
            ? "駐車場があります"
            : null;
  const detail = sentences([
    door === null
      ? null
      : `${origin}から会場まで${formatMinuteRange(door)}の目安です${hub === null ? "" : `（${hub}経由）`}`,
    stationName === null
      ? null
      : walk === null
        ? `最寄りの駅は${stationName}です`
        : `最寄りの${stationName}から歩いて${formatMinuteRange(walk)}です`,
    parking,
  ]);
  return {
    ok: true,
    bubble: door === null ? "所要時間を確かめました" : `会場まで${formatMinuteRange(door)}です`,
    ...(detail === "" ? {} : { detail }),
    count: null,
  };
}

/** research_route の後。乗り換えの回数と所要時間、駅から会場までの歩き */
function routeEnd(output: Record<string, unknown>): ToolEnd {
  const origin = plainName(output.origin) ?? "出発の駅";
  const to = plainName(output.destinationStation) ?? "会場の最寄り駅";
  const walk = minuteRange(output.walkMinutesFromStationEstimate);
  const lastMile = walk === null ? null : `${to}から会場まで歩いて${formatMinuteRange(walk)}です`;
  const minutes = minuteRange(field(output.researched, "minutes"));
  if (output.status === "researched" && minutes !== null) {
    const given = field(output.researched, "transfers");
    const transfers =
      typeof given === "number" && Number.isInteger(given) && given >= 0 ? given : null;
    const time = formatMinuteRange(minutes);
    return {
      ok: true,
      bubble:
        transfers === null
          ? `${time}で行けます`
          : transfers === 0
            ? `乗り換えなしで、${time}です`
            : `乗り換えは${transfers}回、${time}です`,
      detail: sentences([
        `${origin}から${to}まで、${
          transfers === null ? "" : transfers === 0 ? "乗り換えなしで" : `乗り換え${transfers}回で`
        }${time}です`,
        lastMile,
      ]),
      count: null,
    };
  }
  const estimate = minuteRange(field(output.estimate, "minutes"));
  return {
    ok: true,
    bubble: estimate === null ? "行き方は分かりませんでした" : "行き方は見積もりで組みます",
    detail: sentences([
      output.status === "rejected"
        ? "調べた所要時間が駅の位置からの見積もりと合わなかったので、見積もりを使います"
        : output.status === "not_found"
          ? "行き方を調べきれなかったので、駅の位置からの見積もりを使います"
          : "駅の位置からの見積もりで組みます",
      estimate === null ? null : `${origin}から${to}まで${formatMinuteRange(estimate)}の目安です`,
      lastMile,
    ]),
    count: null,
  };
}

/** get_weather の後。予報の空模様と降水確率 */
function weatherEnd(output: Record<string, unknown>): ToolEnd {
  const weather = output.weather;
  const status = field(weather, "status");
  if (status !== "forecast") {
    return {
      ok: true,
      bubble: status === "not_yet" ? "まだ予報が出ていない日でした" : "予報を取得できませんでした",
      detail:
        status === "not_yet"
          ? "予報が出るのは1週間ほど前からです。近くなったら確かめ直してください"
          : "予報を読めませんでした。出発の前に天気を確かめてください",
      count: null,
    };
  }
  const summary = plainName(field(weather, "summary"));
  const rain = field(weather, "precipitationPercent");
  const high = field(weather, "highC");
  const date = output.date;
  return {
    ok: true,
    bubble: summary === null ? "予報を確かめました" : `予報は${summary}です`,
    detail: [
      `${isIsoDate(date) ? `${formatMonthDay(date)}は` : ""}${summary ?? "予報が出ています"}`,
      typeof rain === "number" ? `降水確率${rain}%` : null,
      typeof high === "number" ? `最高${high}℃` : null,
    ]
      .filter((part) => part !== null)
      .join("・"),
    count: null,
  };
}

/** search_lodging の後。見つけた軒数と、会場にいちばん近い宿 */
function lodgingEnd(output: Record<string, unknown>): ToolEnd {
  if (output.status !== "ok") {
    return {
      ok: true,
      bubble: "宿の空きは調べられませんでした",
      detail: "宿の名前は挙げず、泊まる地域だけを案内します",
      count: 0,
    };
  }
  const offers = list(output.offers);
  const count = offers.length;
  const checkIn = output.checkIn;
  const when = isIsoDate(checkIn) ? `${formatMonthDay(checkIn)}に泊まれる` : "泊まれる";
  if (count === 0) {
    return {
      ok: true,
      bubble: "空きのある宿が見つかりませんでした",
      detail: `${when}宿は見つかりませんでした。泊まる地域だけを案内します`,
      count,
    };
  }
  let nearest: {
    name: string;
    km: number;
    walk: boolean;
    minutes: [number, number] | null;
  } | null = null;
  for (const offer of offers) {
    const name = quoted(field(offer, "name"));
    const fromVenue = field(offer, "fromVenue");
    const km = field(fromVenue, "distanceKm");
    if (name === null || typeof km !== "number" || !Number.isFinite(km)) continue;
    if (nearest === null || km < nearest.km) {
      nearest = {
        name,
        km,
        walk: field(fromVenue, "mode") === "walk",
        minutes: minuteRange(field(fromVenue, "minutes")),
      };
    }
  }
  return {
    ok: true,
    bubble: `宿を${count}軒見つけました`,
    detail: sentences([
      `${when}宿を${count}軒見つけました`,
      nearest === null
        ? null
        : `会場にいちばん近いのは${nearest.name}（${
            nearest.minutes === null
              ? ""
              : `${nearest.walk ? "歩いて" : "乗り物で"}${formatMinuteRange(nearest.minutes)}・`
          }${Math.round(nearest.km * 10) / 10}km）です`,
      output.provider === "fictional" ? "いまは見本の宿です" : null,
      "空きと料金は変わるので、予約のページで確かめてください",
    ]),
    count,
  };
}

/** ツールの後の吹き出しと件数。output は失敗のとき null */
export function toolEndBubble(tool: ToolName, output: Record<string, unknown> | null): ToolEnd {
  const retry = RETRY_BUBBLES[tool] ?? RETRY_BUBBLE;
  if (output === null) return { ok: false, bubble: retry, count: null };
  switch (tool) {
    case "search_festivals":
      return festivalsEnd(output);
    case "search_nearby":
      return nearbyEnd(output);
    case "get_access":
      return accessEnd(output);
    case "research_route":
      return routeEnd(output);
    case "get_weather":
      return weatherEnd(output);
    case "search_lodging":
      return lodgingEnd(output);
    case "update_itinerary": {
      if (output.saved !== true) {
        return output.unchanged === true
          ? { ok: true, bubble: "旅程はそのままです", count: null }
          : {
              ok: false,
              bubble: "旅程に直すところがありました",
              detail: `点検で${list(output.errors).length}か所、直すところが見つかりました。直してから保存し直します`,
              count: null,
            };
      }
      const first = field(output.diff, "fromVersion") === 0;
      return { ok: true, bubble: first ? "旅程ができました" : "旅程を直しました", count: null };
    }
    case "verify_festival": {
      const result = output.result as VerificationResult;
      // 候補を出す前に確かめた結果で確定したときは、調べ直していないので「確定した」とだけ言う
      if (output.reused === true && (result === "as_planned" || result === "needs_check")) {
        return {
          ok: true,
          bubble:
            result === "as_planned"
              ? "旅程を確定しました"
              : "旅程を確定しました（出発前に開催を要確認）",
          detail: "候補を出す前に確かめた開催の情報で、旅程を確定しました",
          count: null,
        };
      }
      // 「公式情報で確認」と言うのは、公式の出典があるときだけ
      const sources = list(output.sources);
      const official = sources.find((s) => field(s, "confidence") === "official");
      const bubble =
        result === "as_planned" && official === undefined
          ? "開催予定を確かめました"
          : (VERIFIED_BUBBLES[result] ?? retry);
      const title = quoted(field(official ?? sources[0], "title"));
      return {
        ok: true,
        bubble,
        ...(title === null ? {} : { detail: `${title}で確かめました` }),
        count: null,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// 調べ直しの頼みと受け

/** 調べ直しを頼む中身の呼び方 */
const REDO_ITEMS: Record<RedoSubject, string> = {
  lunch: "昼ごはんの店",
  dinner: "夕ごはんの店",
  sightseeing: "寄り道の場所",
  route: "乗り換えの行き方",
  last_mile: "駅から会場までの行き方",
  lodging: "泊まる宿",
};

/**
 * 調べ直しを頼む（request：from が to に頼む）・受ける（accept：from が to の頼みを受ける）セリフ。
 * 足りないものの種類だけから作り、評価の文などは入れない
 */
export function redoLines(kind: "request" | "accept", to: StaffId, subject: RedoSubject): Lines {
  const item = REDO_ITEMS[subject];
  return kind === "request"
    ? {
        bubble: `${item}がまだです。もう一度探してもらえますか`,
        detail: `旅程に${item}が入っていません。${STAFF_NAMES[to]}に調べ直しを頼みます`,
      }
    : {
        bubble: `${item}ですね。もう一度探してきます`,
        detail: `${STAFF_NAMES[to]}から頼まれた${item}を、もう一度探します`,
      };
}

/** 調べ直しの頼み・受けの SSE のイベント */
export function redoEvent(
  kind: "request" | "accept",
  from: StaffId,
  to: StaffId,
  subject: RedoSubject,
): SseEventOf<"staff.redo"> {
  return { type: "staff.redo", data: { kind, from, to, subject, ...redoLines(kind, to, subject) } };
}

export function isStaff(value: unknown): value is Staff {
  return value === "researcher" || value === "scout" || value === "planner";
}

/** フックの agent_type（サブエージェントの名前）から、スタッフを決める。本体はコンシェルジュ */
export function staffOf(agentType: string | undefined): StaffId | null {
  if (agentType === undefined || agentType === "") return "concierge";
  return isStaff(agentType) ? agentType : null;
}
