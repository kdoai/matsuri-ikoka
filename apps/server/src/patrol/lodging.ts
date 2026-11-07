import { createHash } from "node:crypto";
import {
  type CheckedChange,
  CheckedChangeSchema,
  type GuideNotice,
  type Itinerary,
  type LatLng,
  type NoticeContent,
} from "@matsuri-ikoka/schema";
import { daysBetween, nowInJapan, todayInJapan } from "../domain/calendar";
import { type LodgingService, MAX_OFFERS, MAX_SEARCH_RADIUS_KM } from "../tools/lodging";

// 宿の空きの見回り。モデルを使わず、今の空室検索の処理を呼ぶ。
// 旅ごとに人数と日付が違うので、祭りごとにはまとめない。
// 前の状態は、旅程の宿の候補と、その旅に届いた空きの通知から読むので、比べるための控えを増やさない。

const MAX_NAME_LENGTH = 60;
/** 楽天トラベルの宿の候補の ID（rakuten-施設番号） */
const RAKUTEN_OFFER_ID = /^rakuten-(\d{1,12})$/;

type Availability = Extract<NoticeContent, { kind: "availability" }>;

export interface LodgingBudget {
  /** このあと検索を呼んでよい回数。実際に呼んだときだけ減らす */
  remaining: number;
  /** 回数が足りずに飛ばした泊まりの数 */
  skipped: number;
}

function availabilityChange(input: {
  content: Availability;
  sequence: number;
  sourceUrl: string;
  now: number;
}): CheckedChange | null {
  const { content } = input;
  const now = new Date(input.now);
  // 泊まりの単位で状態の変わり目を数える。最安の宿の名前や料金は入れない
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        "availability",
        content.checkIn,
        content.checkOut,
        content.available,
        input.sequence,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  const parsed = CheckedChangeSchema.safeParse({
    fingerprint,
    content,
    sources: [{ url: input.sourceUrl, checkedAt: todayInJapan(now), confidence: "single" }],
    checkedAt: nowInJapan(now),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * 旅程の泊まりごとに空室検索を呼び、状態が変わったときだけ変化を返す。
 * - 旅程に候補の宿があれば、施設番号で絞って空室を確かめる。なくなったら空きなし、戻ったら空きあり
 * - 候補がなかった泊まりは、宿が出たら空きあり、また出なくなったら空きなし
 * 施設番号が分からない宿は周辺の検索で見る。検索は安い順の上位だけを返すので、結果が上限まであるときに
 * 候補が出ていなくても、空きがないとは言えない。その回は分からないものとして何もしない。
 * Web で調べた宿は、空きを確かめていないので比べない
 */
export async function checkTripLodging(input: {
  itinerary: Itinerary;
  lodging: LodgingService;
  /** 会場。宿の候補に場所がないときに使う */
  venue: LatLng | null;
  /** その旅に届いている通知 */
  notices: readonly GuideNotice[];
  now: number;
  budget: LodgingBudget;
  signal: AbortSignal;
}): Promise<CheckedChange[]> {
  const { itinerary, lodging, venue, notices, now, budget, signal } = input;
  const changes: CheckedChange[] = [];
  for (const day of itinerary.days) {
    const search = day.stay?.lodging;
    if (search === undefined || search.provider !== lodging.provider) continue;
    const planned = search.offers.find((offer) => offer.nightlyTotalYen !== null);
    const near = planned?.location ?? venue;
    if (near === null) continue;
    if (budget.remaining <= 0) {
      budget.skipped += 1;
      continue;
    }
    budget.remaining -= 1;
    const hotelNo = planned === undefined ? undefined : RAKUTEN_OFFER_ID.exec(planned.id)?.[1];
    const outcome = await lodging.search(
      {
        checkIn: search.checkIn,
        nights: daysBetween(search.checkIn, search.checkOut),
        party: itinerary.party,
        near,
        radiusKm: MAX_SEARCH_RADIUS_KM,
        ...(hotelNo === undefined ? {} : { hotelNos: [hotelNo] }),
      },
      signal,
    );
    if (outcome.status !== "ok") continue;
    const offers = outcome.search.offers;

    const past = notices
      .filter(
        (notice): notice is GuideNotice & { content: Availability } =>
          notice.content.kind === "availability" &&
          notice.content.checkIn === search.checkIn &&
          notice.content.checkOut === search.checkOut,
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    const last = past.at(-1);
    const before = last === undefined ? planned !== undefined : last.content.available;

    const plannedNow =
      planned === undefined ? undefined : offers.find((offer) => offer.id === planned.id);
    const available =
      planned === undefined
        ? offers.length > 0
        : plannedNow !== undefined
          ? true
          : hotelNo === undefined && offers.length >= MAX_OFFERS
            ? null
            : false;
    if (available === null || available === before) continue;

    const shown = plannedNow ?? (planned === undefined ? offers[0] : undefined);
    const name = shown?.name ?? planned?.name ?? last?.content.lodgingName;
    const sourceUrl = shown?.source.url ?? planned?.source.url ?? last?.sources[0]?.url;
    if (name === undefined || sourceUrl === undefined) continue;
    const change = availabilityChange({
      content: {
        kind: "availability",
        lodgingName: name.slice(0, MAX_NAME_LENGTH),
        checkIn: search.checkIn,
        checkOut: search.checkOut,
        available,
        nightlyTotalYen: available ? (shown?.nightlyTotalYen ?? null) : null,
        bookingUrl: shown?.bookingUrl ?? planned?.bookingUrl ?? last?.content.bookingUrl ?? null,
      },
      sequence: past.length,
      sourceUrl,
      now,
    });
    if (change !== null) changes.push(change);
  }
  return changes;
}
