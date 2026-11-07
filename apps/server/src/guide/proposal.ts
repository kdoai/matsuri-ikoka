import { createHash } from "node:crypto";
import type {
  Festival,
  GuideNotice,
  GuideProposal,
  Itinerary,
  LastReturn,
  MealPlan,
  PlanEvaluation,
  StayPlan,
} from "@matsuri-ikoka/schema";
import { nowInJapan } from "../domain/calendar";
import type { ItineraryDraft, ItineraryItemDraft } from "../domain/itinerary";

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

/** ガイドが書く直し。予定の ID で指し、変えない予定には触れない */
export type GuideEdit =
  | { op: "retime"; itemId: string; start: string; end: string }
  | { op: "remove"; itemId: string }
  | { op: "replace"; itemId: string; item: ItineraryItemDraft }
  | { op: "add"; date: string; item: ItineraryItemDraft }
  | {
      op: "set_day";
      date: string;
      stay?: StayPlan | null | undefined;
      lastReturn?: LastReturn | null | undefined;
      meals?: MealPlan[] | undefined;
    };

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
