import { createHash } from "node:crypto";
import {
  type Festival,
  type GuideNotice,
  type GuideProposal,
  IsoDateSchema,
  type Itinerary,
  LastReturnSchema,
  LocalTimeSchema,
  MealPlanSchema,
  type PlanEvaluation,
  StayPlanSchema,
} from "@matsuri-ikoka/schema";
import { z } from "zod";
import { nowInJapan } from "../domain/calendar";
import { type ItineraryDraft, stableStringify } from "../domain/itinerary";
import type { ResearchedPlace } from "../domain/planCoverage";
import { ItineraryItemDraftSchema } from "../tools/matsuriTools";

// 組み直しの提案（docs/spec/guide.md の「組み直しの提案」）。提案は承認されるまで旅程を変えない。
// ガイドは影響する予定の直しだけを書き、コードが今の旅程に当てて、今の旅程と同じ検証と評価に通す。

/** 提案の期限。旅の最後の日を過ぎない */
export const PROPOSAL_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/** 提案した旅程の内容のハッシュ。承認のときに、見た提案と同じかを照らし合わせる */
export function proposalContentHash(itinerary: Itinerary): string {
  return createHash("sha256").update(JSON.stringify(itinerary)).digest("hex");
}

/** 提案の期限。作ってから3日か、旅の最後の日の終わりの、早いほう */
export function proposalExpiresAt(itinerary: Itinerary, now: string): string {
  const lastDay = itinerary.days.at(-1)?.date;
  const tripEnd = Date.parse(`${lastDay}T23:59:59+09:00`);
  return nowInJapan(new Date(Math.min(Date.parse(now) + PROPOSAL_TTL_MS, tripEnd)));
}

/** 承認を待てる提案か。期限を過ぎたものと、提案のあとに旅程が変わったものは、もう待てない */
export function isLivePendingProposal(
  proposal: GuideProposal,
  currentVersion: number,
  now: string,
): boolean {
  return (
    proposal.status === "pending" &&
    proposal.baseVersion === currentVersion &&
    Date.parse(proposal.expiresAt) > Date.parse(now)
  );
}

const ItemIdSchema = z.string().trim().min(1).max(100);

/** ガイドが書く直し。予定の ID で指し、変えない予定には触れない */
export const GuideEditSchema = z.discriminatedUnion("op", [
  z
    .strictObject({
      op: z.literal("retime"),
      itemId: ItemIdSchema,
      start: LocalTimeSchema,
      end: LocalTimeSchema,
    })
    .describe("予定の時刻を変える"),
  z.strictObject({ op: z.literal("remove"), itemId: ItemIdSchema }).describe("予定を外す"),
  z
    .strictObject({
      op: z.literal("replace"),
      itemId: ItemIdSchema,
      item: ItineraryItemDraftSchema,
    })
    .describe("予定を置き換える。read_trip の detail の形で書く"),
  z
    .strictObject({ op: z.literal("add"), date: IsoDateSchema, item: ItineraryItemDraftSchema })
    .describe("その日に予定を足す。新しい id を付ける"),
  z
    .strictObject({
      op: z.literal("set_day"),
      date: IsoDateSchema,
      stay: StayPlanSchema.nullable().optional(),
      lastReturn: LastReturnSchema.nullable().optional(),
      meals: z.array(MealPlanSchema).max(4).optional(),
    })
    .describe("その日の泊まり・帰りの最終・食事の案を直す"),
]);
export type GuideEdit = z.infer<typeof GuideEditSchema>;

export type ApplyEditsResult =
  | { ok: true; draft: ItineraryDraft }
  | { ok: false; errors: { code: string; itemId: string | null; message: string }[] };

/**
 * 直しを今の旅程の下書きに当てる。ない予定やない日を指す直しは当てずに断る。
 * 変えた日の予定は、始まる時刻の順に並べ直す
 */
export function applyGuideEdits(
  draft: ItineraryDraft,
  edits: readonly GuideEdit[],
): ApplyEditsResult {
  const days = draft.days.map((day) => ({ ...day, items: [...day.items] }));
  const touched = new Set<string>();
  const errors: { code: string; itemId: string | null; message: string }[] = [];
  const findItem = (itemId: string) => {
    for (const day of days) {
      const index = day.items.findIndex((item) => item.id === itemId);
      if (index !== -1) return { day, index };
    }
    errors.push({ code: "unknown_item", itemId, message: `予定「${itemId}」は旅程にありません` });
    return null;
  };
  const findDay = (date: string) => {
    const day = days.find((entry) => entry.date === date);
    if (day === undefined) {
      errors.push({
        code: "unknown_day",
        itemId: null,
        message: `${date} は旅程の日ではありません。旅の日を増やす変更は、ガイドでは提案できません`,
      });
    }
    return day;
  };
  for (const edit of edits) {
    switch (edit.op) {
      case "retime": {
        const found = findItem(edit.itemId);
        const item = found?.day.items[found.index];
        if (found === null || item === undefined) break;
        found.day.items[found.index] = { ...item, start: edit.start, end: edit.end };
        touched.add(found.day.date);
        break;
      }
      case "remove": {
        const found = findItem(edit.itemId);
        if (found === null) break;
        found.day.items.splice(found.index, 1);
        touched.add(found.day.date);
        break;
      }
      case "replace": {
        const found = findItem(edit.itemId);
        if (found === null) break;
        found.day.items[found.index] = edit.item;
        touched.add(found.day.date);
        break;
      }
      case "add": {
        const day = findDay(edit.date);
        if (day === undefined) break;
        if (days.some((entry) => entry.items.some((item) => item.id === edit.item.id))) {
          errors.push({
            code: "duplicate_item",
            itemId: edit.item.id,
            message: `予定の ID「${edit.item.id}」はもう使われています`,
          });
          break;
        }
        day.items.push(edit.item);
        touched.add(day.date);
        break;
      }
      case "set_day": {
        const day = findDay(edit.date);
        if (day === undefined) break;
        if (edit.stay !== undefined) day.stay = edit.stay;
        if (edit.lastReturn !== undefined) day.lastReturn = edit.lastReturn;
        if (edit.meals !== undefined) day.meals = edit.meals;
        break;
      }
    }
  }
  for (const day of days) {
    if (!touched.has(day.date)) continue;
    if (day.items.length === 0) {
      errors.push({
        code: "empty_day",
        itemId: null,
        message: `${day.date} の予定がなくなります。旅の日を減らす変更は、ガイドでは提案できません`,
      });
    }
    day.items.sort((a, b) => a.start.localeCompare(b.start));
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, draft: { ...draft, days } };
}

/**
 * 通知で分かった開催の変更を、祭りのデータに重ねる。データの更新は週に1回なので、変更の案を
 * 今のデータだけで照らすと、新しい時刻の案が断られる。重ねるのは検問を通った通知の値だけ
 */
export function festivalWithNotices(festival: Festival, notices: readonly GuideNotice[]): Festival {
  const relevant = notices.flatMap((notice) =>
    notice.content.kind === "schedule_change" && notice.content.festivalId === festival.id
      ? [notice.content]
      : [],
  );
  if (relevant.length === 0) return festival;
  return {
    ...festival,
    occurrences: festival.occurrences.map((occurrence) => {
      const content = relevant.find((entry) => entry.date === occurrence.date);
      if (content === undefined) return occurrence;
      let next = occurrence;
      for (const change of content.changes) {
        if (change.field === "start") next = { ...next, start: change.after };
        if (change.field === "end") next = { ...next, end: change.after };
        if (change.field === "date" && change.after !== null) {
          next = { ...next, date: change.after };
        }
      }
      return next;
    }),
  };
}

/** 調べた場所の採否を残せる数（スキーマの上限と同じ） */
const MAX_CONSIDERED = 40;
/** 調べたけれど案に入れなかった場所の理由 */
export const NOT_USED_REASON = "相談の中で調べた場所。この案の予定には入れなかった";
/** 前の版で採っていて、この案で外した場所の理由 */
export const REMOVED_REASON = "この案で予定から外した";

/**
 * 調べた場所の採否を、提案のために決め直す。
 * - 新しい相談では調べた場所の控えが空なので、前の版の採否を引き継ぐ
 * - ガイドは採否を書かない（影響する予定だけを直す）。採らなかった場所の理由はコードが補い、
 *   調べただけで「未判断」にして、直しと関係なく評価を下げないようにする
 */
export function carryConsidered(
  draft: ItineraryDraft,
  previous: Itinerary,
  found: readonly ResearchedPlace[],
): { draft: ItineraryDraft; researched: ResearchedPlace[] } {
  const adopted = new Set(
    draft.days.flatMap((day) => [
      ...day.items.flatMap((item) => (item.spotId === undefined ? [] : [item.spotId])),
      ...(day.stay?.lodging?.offers.map((offer) => offer.id) ?? []),
    ]),
  );
  const before = new Map((previous.considered ?? []).map((place) => [place.id, place]));
  const places = new Map<string, ResearchedPlace>();
  for (const { id, name, from } of before.values()) places.set(id, { id, name, from });
  for (const place of found) if (!places.has(place.id)) places.set(place.id, place);
  // 上限を超えたら、案に入っている場所を残す
  const researched = [...places.values()]
    .sort((a, b) => Number(adopted.has(b.id)) - Number(adopted.has(a.id)))
    .slice(0, MAX_CONSIDERED);
  const considered = researched.flatMap((place) => {
    const was = before.get(place.id);
    // 採った場所で理由がなければ、その予定の理由を使う（reconcileConsidered）
    if (adopted.has(place.id))
      return was === undefined ? [] : [{ id: place.id, reason: was.reason }];
    if (was === undefined) return [{ id: place.id, reason: NOT_USED_REASON }];
    return [{ id: place.id, reason: was.adopted ? REMOVED_REASON : was.reason }];
  });
  return { draft: { ...draft, considered }, researched };
}

/**
 * 案が今の旅程と同じ計画か。予定・泊まり・食事の案・帰りの最終を比べる。
 * 採否の理由・不足・評価・天気は計画の変更ではないので比べない。
 * 予定の差分だけでは決めない（帰りの最終だけの直しは、予定の差分が空でも正しい案）
 */
export function samePlan(a: Itinerary, b: Itinerary): boolean {
  const plan = (itinerary: Itinerary) =>
    itinerary.days.map(({ weather: _weather, items, ...day }) => ({
      ...day,
      items: items.map(({ changedInVersion: _changed, ...item }) => item),
    }));
  return stableStringify(plan(a)) === stableStringify(plan(b));
}

/**
 * 案を見せてよい評価か。基準に届いていればよい。届いていなくても、今の旅程より悪くならない案は見せる
 * （今の旅程がもともと基準に届いていないとき、直せる案まで止めないため）。今の旅程に評価がなければ、点検だけで決める
 */
export function acceptableEvaluation(
  next: PlanEvaluation,
  base: PlanEvaluation | undefined,
): boolean {
  if (next.passed || base === undefined) return true;
  return next.scores.every((score) => {
    const before = base.scores.find((entry) => entry.criterion === score.criterion);
    return before === undefined || score.score >= before.score;
  });
}
