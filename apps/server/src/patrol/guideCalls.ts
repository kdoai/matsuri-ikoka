import { createHash } from "node:crypto";
import {
  type CheckedSource,
  type Festival,
  type GuideNotice,
  GuideNoticeSchema,
  type Itinerary,
  type Source,
  type Weather,
} from "@matsuri-ikoka/schema";
import { nowInJapan, todayInJapan } from "../domain/calendar";
import { dueGuideCalls, type GuideCall } from "../domain/guideCalls";
import { errorForLog } from "../log";
import type { WeatherService } from "../tools/weather";
import { noticeExpiresAt } from "./notices";
import type { PatrolStore } from "./store";
import type { WatchedTrip } from "./types";

// 旅程の時刻に合わせた声かけを、旅の通知として届ける。定期の起動のたびに、来た分だけを確かめる。
// 実行済みの記録は通知そのもの：同じ旅の同じ声かけは同じ ID なので、起動が2回届いても、
// 再起動のあとでも、通知は1つだけ作られる（保存の口の addNotice は、同じ ID があれば足さない）。
// 文は旅程・天気の予報・未読の通知の数から、コードが決まった型で作る。

const MAX_SUMMARY_LENGTH = 200;

export interface GuideCallDeps {
  store: Pick<PatrolStore, "addNotice" | "listNotices">;
  festivals: { get(id: string): Pick<Festival, "municipalities"> | undefined };
  /** 天気の予報。なければ天気を添えない */
  weather?: Pick<WeatherService, "forecast"> | undefined;
  now: () => number;
}

/** 声かけの通知の指紋。旅と声かけの値から決まる */
export function guideCallFingerprint(tripId: string, call: Pick<GuideCall, "key">): string {
  return createHash("sha256").update(`${tripId}\n${call.key}`).digest("hex").slice(0, 32);
}

/** 声かけの通知の ID。実行済みの記録を兼ねる */
export function guideCallNoticeId(tripId: string, call: Pick<GuideCall, "key">): string {
  return `n-r-${guideCallFingerprint(tripId, call)}`;
}

type Item = Itinerary["days"][number]["items"][number];

function findItem(itinerary: Itinerary, id: string | null): Item | undefined {
  if (id === null) return undefined;
  return itinerary.days.flatMap((day) => day.items).find((item) => item.id === id);
}

function checked(sources: readonly Source[]): CheckedSource[] {
  return sources
    .filter((source) => source.confidence !== "inferred")
    .map(({ url, checkedAt, confidence }) => ({ url, checkedAt, confidence }));
}

function weatherLine(weather: Weather | null): string {
  if (weather?.status !== "forecast") return "";
  const rain =
    weather.precipitationPercent === null ? "" : `（降水確率${weather.precipitationPercent}%）`;
  return `天気は${weather.summary}${rain}。`;
}

function callLine(itinerary: Itinerary, call: GuideCall, item: Item | undefined): string {
  switch (call.slot) {
    case "eve":
      return item === undefined
        ? `明日から「${itinerary.title}」の旅です。`
        : `明日から「${itinerary.title}」の旅です。最初の予定は ${item.start}「${item.name}」です。`;
    case "morning":
      return item === undefined
        ? "今日の予定を確かめましょう。"
        : `今日の最初の予定は ${item.start}「${item.name}」です。`;
    case "depart": {
      if (item === undefined) return "そろそろ会場へ向かう時刻です。";
      const move =
        item.move?.from === undefined ? "" : `（${item.move.from}から約${item.move.minutes[1]}分）`;
      return `${item.start}からの「${item.name}」に向けて、そろそろ会場へ向かう時刻です${move}。`;
    }
    case "last_return": {
      const last = itinerary.days.find((day) => day.date === call.date)?.lastReturn;
      return last?.departBy === null || last?.departBy === undefined
        ? "そろそろ帰りの電車に向かいましょう。"
        : `帰りの最終の目安は ${last.station} を ${last.departBy} です。乗り遅れないよう、そろそろ向かいましょう。`;
    }
  }
}

function callSources(itinerary: Itinerary, call: GuideCall, item: Item | undefined): Source[] {
  if (call.slot === "last_return") {
    return itinerary.days.find((day) => day.date === call.date)?.lastReturn?.sources ?? [];
  }
  const festival = itinerary.days
    .flatMap((day) => day.items)
    .find((entry) => entry.festivalId === itinerary.mainFestivalId);
  return [...(item?.sources ?? []), ...(festival?.sources ?? [])];
}

/** 声かけの通知を作る。確かめた出典が1つもなければ null（出典のない知らせは出さない） */
export function guideCallNotice(input: {
  tripId: string;
  itinerary: Itinerary;
  call: GuideCall;
  weather: Weather | null;
  unread: number;
  now: number;
}): GuideNotice | null {
  const { itinerary, call } = input;
  const item = findItem(itinerary, call.itemId);
  const weatherSource =
    input.weather?.status === "forecast" && (call.slot === "eve" || call.slot === "morning")
      ? [input.weather.source]
      : [];
  const byUrl = new Map<string, CheckedSource>();
  for (const source of checked([...callSources(itinerary, call, item), ...weatherSource])) {
    if (!byUrl.has(source.url)) byUrl.set(source.url, source);
  }
  const sources = [...byUrl.values()];
  if (sources.length === 0) return null;
  const summary = [
    callLine(itinerary, call, item),
    call.slot === "eve" || call.slot === "morning" ? weatherLine(input.weather) : "",
    input.unread > 0 ? `まだ読んでいないお知らせが${input.unread}件あります。` : "",
  ]
    .join("")
    .slice(0, MAX_SUMMARY_LENGTH);
  const fingerprint = guideCallFingerprint(input.tripId, call);
  const at = nowInJapan(new Date(input.now));
  return GuideNoticeSchema.parse({
    fingerprint,
    content: {
      kind: "reminder",
      slot: call.slot,
      date: call.date,
      at: call.at,
      itemId: call.itemId === null ? null : call.itemId.slice(0, 100),
    },
    sources: sources.slice(0, 8),
    checkedAt: at,
    id: guideCallNoticeId(input.tripId, call),
    tripId: input.tripId,
    summary,
    affectedItemIds: call.itemId === null ? [] : [call.itemId],
    proposalId: null,
    createdAt: at,
    readAt: null,
  });
}

async function forecastFor(
  deps: GuideCallDeps,
  itinerary: Itinerary,
  call: GuideCall,
): Promise<Weather | null> {
  if (deps.weather === undefined || (call.slot !== "eve" && call.slot !== "morning")) return null;
  const prefecture = deps.festivals.get(itinerary.mainFestivalId)?.municipalities[0]?.prefecture;
  if (prefecture === undefined) return null;
  try {
    const report = await deps.weather.forecast(
      prefecture,
      call.date,
      todayInJapan(new Date(deps.now())),
    );
    return report.weather;
  } catch {
    // 天気が読めなくても、声かけは天気なしで届ける
    return null;
  }
}

/**
 * 見回り中の旅に、来た声かけを届ける。利用者が声かけを止めている旅には届けない。
 * 1つの旅の失敗で、ほかの旅の声かけを止めない。届けた数を返す
 */
export async function deliverGuideCalls(
  deps: GuideCallDeps,
  entries: readonly { trip: WatchedTrip; itinerary: Itinerary }[],
): Promise<number> {
  let created = 0;
  for (const { trip, itinerary } of entries) {
    if (trip.watch.reminders === false) continue;
    const due = dueGuideCalls(itinerary, deps.now());
    if (due.length === 0) continue;
    try {
      const notices = await deps.store.listNotices(trip);
      const delivered = new Set(notices.map((notice) => notice.id));
      const unread = notices.filter(
        (notice) => notice.readAt === null && notice.content.kind !== "reminder",
      ).length;
      for (const call of due) {
        // 届けた声かけは天気を読み直さずに飛ばす。最後に重ならないようにするのは addNotice
        if (delivered.has(guideCallNoticeId(trip.watch.tripId, call))) continue;
        const notice = guideCallNotice({
          tripId: trip.watch.tripId,
          itinerary,
          call,
          weather: await forecastFor(deps, itinerary, call),
          unread,
          now: deps.now(),
        });
        if (notice === null) {
          console.log(JSON.stringify({ kind: "guide_call_no_source", slot: call.slot }));
          continue;
        }
        const result = await deps.store.addNotice(trip, notice, noticeExpiresAt(itinerary));
        if (result === "created") created += 1;
      }
    } catch (error) {
      console.error(JSON.stringify({ kind: "guide_call_failed", ...errorForLog(error) }));
    }
  }
  return created;
}
