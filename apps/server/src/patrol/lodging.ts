import { createHash } from "node:crypto";
import {
  type CheckedChange,
  CheckedChangeSchema,
  type Itinerary,
  type LatLng,
  type LodgingOffer,
  type NoticeContent,
} from "@matsuri-ikoka/schema";
import { daysBetween, nowInJapan, todayInJapan } from "../domain/calendar";
import { type LodgingService, MAX_OFFERS, MAX_SEARCH_RADIUS_KM } from "../tools/lodging";

// 宿の空きの見回り。モデルを使わず、今の空室検索の処理を呼ぶ。
// 旅ごとに人数と日付が違うので、祭りごとにはまとめない。
// 前の結果は旅程の宿の候補にあるので、比べるための控えを増やさない。

const MAX_NAME_LENGTH = 60;

function availabilityChange(input: {
  content: Extract<NoticeContent, { kind: "availability" }>;
  source: LodgingOffer["source"];
  now: number;
}): CheckedChange | null {
  const { content, source } = input;
  const now = new Date(input.now);
  // 料金は調べるたびに変わるので、同じ変化かどうかの判定には入れない
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        "availability",
        content.lodgingName,
        content.checkIn,
        content.checkOut,
        content.available,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  const parsed = CheckedChangeSchema.safeParse({
    fingerprint,
    content,
    sources: [{ url: source.url, checkedAt: todayInJapan(now), confidence: "single" }],
    checkedAt: nowInJapan(now),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * 旅程の泊まりごとに空室検索を呼び、変化を返す。
 * - 旅程の宿の候補が検索に出なくなったら、空きがなくなった変化にする
 * - 候補がなかった泊まりで宿が出たら、空きが出た変化にする
 * 検索は安い順の上位だけを返すので、より安い宿に押し出されただけのときは、変化にしない。
 * Web で調べた宿は、空きを確かめていないので比べない
 */
export async function checkTripLodging(input: {
  itinerary: Itinerary;
  lodging: LodgingService;
  /** 会場。宿の候補に場所がないときに使う */
  venue: LatLng | null;
  now: number;
  signal: AbortSignal;
}): Promise<CheckedChange[]> {
  const { itinerary, lodging, venue, now, signal } = input;
  const changes: CheckedChange[] = [];
  for (const day of itinerary.days) {
    const search = day.stay?.lodging;
    if (search === undefined || search.provider !== lodging.provider) continue;
    const planned = search.offers.find((offer) => offer.nightlyTotalYen !== null);
    const near = planned?.location ?? venue;
    if (near === null) continue;
    const outcome = await lodging.search(
      {
        checkIn: search.checkIn,
        nights: daysBetween(search.checkIn, search.checkOut),
        party: itinerary.party,
        near,
        radiusKm: MAX_SEARCH_RADIUS_KM,
      },
      signal,
    );
    if (outcome.status !== "ok") continue;
    const offers = outcome.search.offers;
    const stay = { checkIn: search.checkIn, checkOut: search.checkOut };
    let change: CheckedChange | null = null;
    if (planned === undefined) {
      const opened = offers[0];
      if (opened !== undefined) {
        change = availabilityChange({
          content: {
            kind: "availability",
            lodgingName: opened.name.slice(0, MAX_NAME_LENGTH),
            ...stay,
            available: true,
            nightlyTotalYen: opened.nightlyTotalYen,
            bookingUrl: opened.bookingUrl,
          },
          source: opened.source,
          now,
        });
      }
    } else if (!offers.some((offer) => offer.id === planned.id)) {
      const pushedOut =
        offers.length >= MAX_OFFERS &&
        offers.every((offer) => (offer.nightlyTotalYen ?? 0) <= (planned.nightlyTotalYen ?? 0));
      if (!pushedOut) {
        change = availabilityChange({
          content: {
            kind: "availability",
            lodgingName: planned.name.slice(0, MAX_NAME_LENGTH),
            ...stay,
            available: false,
            nightlyTotalYen: null,
            bookingUrl: planned.bookingUrl,
          },
          source: planned.source,
          now,
        });
      }
    }
    if (change !== null) changes.push(change);
  }
  return changes;
}
