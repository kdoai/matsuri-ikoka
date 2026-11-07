import { checkPublicWebUrl } from "@matsuri-ikoka/agent-kit";
import type {
  IsoDate,
  LatLng,
  LodgingOffer,
  LodgingSearch,
  Party,
  Source,
} from "@matsuri-ikoka/schema";
import { z } from "zod";
import { addDays } from "../domain/calendar";
import { lodgingHeadcount } from "../domain/lodging";

// 宿の空きを調べる。キーがあれば楽天トラベルの空室検索 API、なければ架空の宿で動く（ADR 0006）。
// API の返す文字列と URL は信用しない入力として扱い、使う項目だけを検証して取り出す。

/** 楽天トラベルの空室検索 API（版は URL に入る） */
export const RAKUTEN_VACANT_HOTEL_URL =
  "https://openapi.rakuten.co.jp/engine/api/Travel/VacantHotelSearch/20170426";
/** 楽天ウェブサービスの利用で表示するクレジット */
export const RAKUTEN_CREDIT = "Supported by Rakuten Developers";
/** 予約のページとして受け付けるホスト（楽天のドメインの下だけ） */
const RAKUTEN_HOST = /(^|\.)rakuten\.co\.jp$/;

export const LODGING_TIMEOUT_MS = 8_000;
/** 呼び出しの間隔の下限。短い時間に続けて呼ぶと、しばらく使えなくなることがある */
export const LODGING_MIN_INTERVAL_MS = 1_500;
/** 同じ条件の結果を使い回す時間。空きと料金は変わるので短くする */
export const LODGING_CACHE_MS = 5 * 60 * 1000;
/** API の検索の半径の上限（km） */
export const MAX_SEARCH_RADIUS_KM = 3;
/** 1回に返す宿の数の上限（LodgingSearchSchema と同じ） */
export const MAX_OFFERS = 5;
/** API で1回に指定できる施設番号の数の上限 */
const MAX_HOTEL_NOS = 15;
/** API の人数の上限（大人・小学生・幼児のそれぞれ） */
const MAX_GUESTS_PER_KIND = 10;

export interface LodgingQuery {
  checkIn: IsoDate;
  nights: number;
  party: Party;
  near: LatLng;
  radiusKm: number;
  /** 宿を施設番号で絞る（15件まで）。指定すると near と radiusKm は使わない */
  hotelNos?: readonly string[];
}

export type LodgingOutcome =
  | { status: "ok"; search: LodgingSearch }
  | { status: "unavailable"; reason: string };

export interface LodgingService {
  /** rakuten：楽天トラベル / fictional：架空の宿（キーがないとき） */
  readonly provider: "rakuten" | "fictional";
  search(query: LodgingQuery, signal: AbortSignal): Promise<LodgingOutcome>;
}

// ---------------------------------------------------------------------------
// 楽天トラベルの返答の読み取り

// 外から来る JSON なので、使う部分だけを検証する
const HotelBasicInfoSchema = z
  .object({
    hotelNo: z.union([z.number().int(), z.string().regex(/^\d{1,12}$/)]),
    hotelName: z.string(),
    hotelInformationUrl: z.string().optional(),
    planListUrl: z.string().optional(),
    hotelMinCharge: z.number().nullish(),
    latitude: z.number().nullish(),
    longitude: z.number().nullish(),
  })
  .loose();
const RoomBasicInfoSchema = z.object({ reserveUrl: z.string().optional() }).loose();
const DailyChargeSchema = z.object({ total: z.number().nullish() }).loose();

/** オブジェクトの木の中から、key の値をすべて集める（返答の入れ子の形に頼らない） */
function collect(node: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, key, out);
  } else if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === key) out.push(v);
      else collect(v, key, out);
    }
  }
  return out;
}

/** 木の中に key がいくつあるか */
function countKey(node: unknown, key: string): number {
  return collect(node, key).length;
}

/**
 * プランの単位を取り出す。roomBasicInfo と dailyCharge をちょうど1つずつ含む、いちばん小さい入れ子を1プランとする。
 * 並びの順で組にしないので、片方が欠けたプランの料金を別のプランの予約のページと取り違えない
 */
function planUnits(node: unknown): unknown[] {
  if (node === null || typeof node !== "object") return [];
  const rooms = countKey(node, "roomBasicInfo");
  const charges = countKey(node, "dailyCharge");
  if (rooms === 0 || charges === 0) return [];
  const children = Array.isArray(node) ? node : Object.values(node);
  const inner = children.flatMap(planUnits);
  if (inner.length > 0) return inner;
  return rooms === 1 && charges === 1 ? [node] : [];
}

/** 名前に使う文字列。空白（改行を含む）を1つに詰め、制御文字を除き、長さを切る */
function cleanText(text: string, max: number): string | null {
  const cleaned = Array.from(text.replace(/[\s　]+/g, " "))
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
    })
    .join("")
    .trim();
  return cleaned === "" ? null : cleaned.slice(0, max);
}

/** 楽天のドメインの https の URL だけを受け付ける */
function rakutenUrl(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const check = checkPublicWebUrl(raw, { httpsOnly: true });
  return check.ok && RAKUTEN_HOST.test(check.url.hostname) ? check.url.toString() : null;
}

function yen(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 10_000_000
    ? value
    : null;
}

/** 日本の範囲の緯度・経度だけを使う（測地系の取り違えで、違う場所に打たないため） */
function japanLatLng(
  lat: number | null | undefined,
  lng: number | null | undefined,
): LatLng | null {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  return lat >= 20 && lat <= 46 && lng >= 122 && lng <= 154 ? { lat, lng } : null;
}

/** 空室検索の返答から、宿の候補を料金の安い順に取り出す */
export function readVacantHotels(
  json: unknown,
  options: { checkedAt: string; checkedOn: IsoDate },
): LodgingOffer[] {
  const hotels = (json as { hotels?: unknown })?.hotels;
  if (!Array.isArray(hotels)) return [];
  const offers = hotels.flatMap((hotel): LodgingOffer[] => {
    const basic = HotelBasicInfoSchema.safeParse(collect(hotel, "hotelBasicInfo")[0]);
    if (!basic.success) return [];
    const info = basic.data;
    const name = cleanText(info.hotelName, 100);
    const pageUrl = rakutenUrl(info.hotelInformationUrl);
    if (name === null || pageUrl === null) return [];

    // プランごとの1泊目の合計。いちばん安いプランの予約のページを使う
    const plans = planUnits(hotel).map((unit) => ({
      total: yen(DailyChargeSchema.safeParse(collect(unit, "dailyCharge")[0]).data?.total),
      reserveUrl: rakutenUrl(
        RoomBasicInfoSchema.safeParse(collect(unit, "roomBasicInfo")[0]).data?.reserveUrl,
      ),
    }));
    const cheapest = plans
      .filter((plan): plan is { total: number; reserveUrl: string | null } => plan.total !== null)
      .sort((a, b) => a.total - b.total)[0];
    // プランの料金がなければ、宿の最安値の目安（1部屋1泊、税・サービス料込み）を使う
    const nightlyTotalYen = cheapest?.total ?? yen(info.hotelMinCharge);
    if (nightlyTotalYen === null) return [];
    const source: Source = {
      url: pageUrl,
      title: `楽天トラベル（${RAKUTEN_CREDIT}）`,
      checkedAt: options.checkedOn,
      confidence: "single",
    };
    return [
      {
        id: `rakuten-${info.hotelNo}`,
        name,
        nightlyTotalYen,
        bookingUrl: cheapest?.reserveUrl ?? rakutenUrl(info.planListUrl) ?? pageUrl,
        location: japanLatLng(info.latitude, info.longitude),
        checkedAt: options.checkedAt,
        source,
      },
    ];
  });
  return offers
    .sort((a, b) => (a.nightlyTotalYen ?? 0) - (b.nightlyTotalYen ?? 0))
    .slice(0, MAX_OFFERS);
}

/** 人数を API の入力にする。小学生は高学年として、幼児は食事と布団なしとして数える */
export function rakutenGuestParams(party: Party): Record<string, string> | null {
  const { adults, elementary, infants } = lodgingHeadcount(party);
  if ([adults, elementary, infants].some((n) => n > MAX_GUESTS_PER_KIND)) return null;
  return {
    adultNum: String(adults),
    upClassNum: String(elementary),
    infantWithoutMBNum: String(infants),
    roomNum: "1",
  };
}

export interface RakutenLodgingOptions {
  applicationId: string;
  accessKey: string;
  /** アプリに登録した「許可されたWebサイト」。あれば Referer と Origin に入れる */
  allowedSite?: string | undefined;
  fetch?: typeof fetch;
  /** 日本の今の日時（ISO 8601） */
  now: () => string;
  clock?: () => number;
  minIntervalMs?: number;
  cacheMs?: number;
  timeoutMs?: number;
}

/** 楽天トラベルの空室検索。呼び出しは1本ずつ間隔を空けて流し、同じ条件の結果は短い間だけ使い回す */
export function createRakutenLodging(options: RakutenLodgingOptions): LodgingService {
  const fetchFn = options.fetch ?? fetch;
  const clock = options.clock ?? Date.now;
  const minIntervalMs = options.minIntervalMs ?? LODGING_MIN_INTERVAL_MS;
  const cacheMs = options.cacheMs ?? LODGING_CACHE_MS;
  const timeoutMs = options.timeoutMs ?? LODGING_TIMEOUT_MS;
  const cache = new Map<string, { at: number; search: LodgingSearch }>();
  let queue: Promise<unknown> = Promise.resolve();
  let lastCallAt = Number.NEGATIVE_INFINITY;

  const headers: Record<string, string> = {
    accept: "application/json",
    accessKey: options.accessKey,
  };
  if (options.allowedSite !== undefined) {
    headers.referer = options.allowedSite;
    headers.origin = new URL(options.allowedSite).origin;
  }

  /** 前の呼び出しから間隔を空けて、1本ずつ呼ぶ */
  const throttled = <T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> => {
    const run = queue.then(async () => {
      const wait = lastCallAt + minIntervalMs - clock();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      signal.throwIfAborted();
      lastCallAt = clock();
      return task();
    });
    queue = run.catch(() => {});
    return run;
  };

  return {
    provider: "rakuten",
    async search(query, signal) {
      const guests = rakutenGuestParams(query.party);
      if (guests === null) {
        return {
          status: "unavailable",
          reason: "人数が多く、空室検索の上限（それぞれ10人）を超えます",
        };
      }
      const checkOut = addDays(query.checkIn, query.nights);
      const params = new URLSearchParams({
        applicationId: options.applicationId,
        format: "json",
        checkinDate: query.checkIn,
        checkoutDate: checkOut,
        ...(query.hotelNos !== undefined && query.hotelNos.length > 0
          ? { hotelNo: query.hotelNos.slice(0, MAX_HOTEL_NOS).join(",") }
          : {
              datumType: "1",
              latitude: query.near.lat.toFixed(6),
              longitude: query.near.lng.toFixed(6),
              searchRadius: Math.min(MAX_SEARCH_RADIUS_KM, Math.max(0.1, query.radiusKm)).toFixed(
                1,
              ),
            }),
        sort: "+roomCharge",
        hits: "10",
        responseType: "large",
        ...guests,
      });
      const url = `${RAKUTEN_VACANT_HOTEL_URL}?${params}`;
      const hit = cache.get(url);
      if (hit !== undefined && clock() - hit.at < cacheMs)
        return { status: "ok", search: hit.search };

      try {
        const response = await throttled(
          () =>
            fetchFn(url, {
              headers,
              signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
            }),
          signal,
        );
        const searchedAt = options.now();
        // 404 は「条件に合う宿がない」
        if (response.status === 404) {
          const search: LodgingSearch = {
            checkIn: query.checkIn,
            checkOut,
            searchedAt,
            provider: "rakuten",
            offers: [],
          };
          cache.set(url, { at: clock(), search });
          return { status: "ok", search };
        }
        if (!response.ok) {
          return {
            status: "unavailable",
            reason:
              response.status === 429
                ? "空室検索が混み合っていて、いまは調べられません"
                : `空室検索から返事がありません（${response.status}）`,
          };
        }
        const offers = readVacantHotels(await response.json(), {
          checkedAt: searchedAt,
          checkedOn: searchedAt.slice(0, 10),
        });
        const search: LodgingSearch = {
          checkIn: query.checkIn,
          checkOut,
          searchedAt,
          provider: "rakuten",
          offers,
        };
        cache.set(url, { at: clock(), search });
        return { status: "ok", search };
      } catch {
        return { status: "unavailable", reason: "空室検索に接続できませんでした" };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 架空の宿（キーがないとき）

const FICTIONAL_INNS = [
  { slug: "kawabe", name: "（架空）川べりの宿", perPersonYen: 9800, offset: [0.004, 0.002] },
  { slug: "ekimae", name: "（架空）駅前ホテル", perPersonYen: 7600, offset: [-0.006, 0.005] },
  { slug: "yamate", name: "（架空）山手の湯宿", perPersonYen: 16500, offset: [0.009, -0.007] },
] as const;

/** キーがないときの架空の宿。名前に（架空）と付け、URL は example.com にする */
export function createFictionalLodging(options: { now: () => string }): LodgingService {
  return {
    provider: "fictional",
    async search(query) {
      const searchedAt = options.now();
      const { payers } = lodgingHeadcount(query.party);
      const offers: LodgingOffer[] = FICTIONAL_INNS.map((inn) => ({
        id: `fictional-${inn.slug}`,
        name: inn.name,
        nightlyTotalYen: inn.perPersonYen * Math.max(1, payers),
        bookingUrl: `https://example.com/lodging/${inn.slug}?checkin=${query.checkIn}`,
        location: { lat: query.near.lat + inn.offset[0], lng: query.near.lng + inn.offset[1] },
        checkedAt: searchedAt,
        source: {
          url: "https://example.com/lodging",
          title: "架空の宿（空室検索のキーがないときの見本）",
          checkedAt: searchedAt.slice(0, 10),
          confidence: "single",
        },
      }));
      return {
        status: "ok",
        search: {
          checkIn: query.checkIn,
          checkOut: addDays(query.checkIn, query.nights),
          searchedAt,
          provider: "fictional",
          offers: offers.sort((a, b) => (a.nightlyTotalYen ?? 0) - (b.nightlyTotalYen ?? 0)),
        },
      };
    },
  };
}

/** 本番でキーがないとき。架空の宿を本物と取り違えないよう、調べられないと返す */
export function createUnavailableLodging(): LodgingService {
  return {
    provider: "fictional",
    async search() {
      return { status: "unavailable", reason: "宿の空きを調べる設定がありません" };
    },
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * 環境変数から宿の空きの調べ方を決める。RAKUTEN_APPLICATION_ID と RAKUTEN_ACCESS_KEY がそろえば楽天トラベル、
 * なければ開発では架空の宿、本番では「調べられない」
 */
export function createLodgingService(
  env: NodeJS.ProcessEnv,
  options: { production: boolean; now: () => string; fetch?: typeof fetch },
): LodgingService {
  const applicationId = nonEmpty(env.RAKUTEN_APPLICATION_ID);
  const accessKey = nonEmpty(env.RAKUTEN_ACCESS_KEY);
  const allowedSite = nonEmpty(env.RAKUTEN_ALLOWED_SITE);
  if (allowedSite !== undefined && !checkPublicWebUrl(allowedSite, { httpsOnly: true }).ok) {
    throw new Error("RAKUTEN_ALLOWED_SITE は https の公開の URL にしてください");
  }
  if (applicationId !== undefined && accessKey !== undefined) {
    return createRakutenLodging({
      applicationId,
      accessKey,
      allowedSite,
      now: options.now,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }
  return options.production
    ? createUnavailableLodging()
    : createFictionalLodging({ now: options.now });
}
