import { createHash } from "node:crypto";
import {
  type CheckedChange,
  type GuideNotice,
  GuideNoticeSchema,
  type IsoDate,
  type Itinerary,
  type NoticeContent,
  type NoticeTopic,
} from "@matsuri-ikoka/schema";
import { addDays, formatMonthDay, nowInJapan } from "../domain/calendar";
import { MAX_CALL_DELAY_MS } from "../domain/guideCalls";

// 検問を通った変化を、旅の通知にする。一覧の短い文は、通知の中身から決まった型で作る（ページの文章を使わない）。

/** 通知を残す期間（旅の最終日から） */
const NOTICE_RETENTION_DAYS = 30;
const MAX_SUMMARY_LENGTH = 200;

const TOPIC_LABELS: Record<NoticeTopic, string> = {
  traffic: "交通規制",
  venue: "会場",
  program: "内容",
  reception: "受付",
  rain: "雨のとき",
  other: "そのほか",
};

const FIELD_LABELS = { start: "開始", end: "終了" } as const;

export function noticeSummary(content: NoticeContent, festivalName: string): string {
  switch (content.kind) {
    case "schedule_change": {
      const parts = content.changes.map((change) => {
        if (change.field === "date") {
          return change.after === null
            ? `${formatMonthDay(change.before)}の開催は延期になりました。新しい日はまだ分かりません`
            : `開催日が ${formatMonthDay(change.before)} から ${formatMonthDay(change.after)} に変わりました`;
        }
        const label = FIELD_LABELS[change.field];
        return change.before === null
          ? `${label}が ${change.after ?? "未定"} と分かりました`
          : `${label}が ${change.before} から ${change.after ?? "未定"} に変わりました`;
      });
      return `${festivalName}：${parts.join("。")}`.slice(0, MAX_SUMMARY_LENGTH);
    }
    case "cancellation":
      return `${festivalName}（${formatMonthDay(content.date)}）は中止になりました`;
    case "announcement":
      return `${festivalName}に主催者のお知らせ（${TOPIC_LABELS[content.topic]}）があります。くわしくは出典のページをご覧ください`;
    case "availability":
      return content.available
        ? `${formatMonthDay(content.checkIn)}の宿「${content.lodgingName}」に空きがあります`
        : `${formatMonthDay(content.checkIn)}の宿「${content.lodgingName}」の空きが見つからなくなりました`;
    case "weather":
      return `${formatMonthDay(content.date)}の天気にご注意ください`;
    case "reminder":
      // 声かけの文は旅程から作る（patrol/guideCalls.ts）。ここでは短い見出しだけ
      return `${formatMonthDay(content.date)} ${content.at}のガイドからの声かけ`;
  }
}

/** 影響する予定：その祭りの予定だけ（どの予定を組み直すかは、ガイドの提案で決める） */
function affectedItems(itinerary: Itinerary, content: NoticeContent): string[] {
  if (!("festivalId" in content)) return [];
  return itinerary.days
    .flatMap((day) => day.items)
    .filter((item) => item.festivalId === content.festivalId)
    .map((item) => item.id)
    .slice(0, 40);
}

/**
 * 通知の ID。同じ変化からは同じ ID になるので、同じ旅に2度届かない。
 * お知らせは祭りと開催日と種類ごとに1つに畳む（同じサイトの更新で通知の上限が埋まらないように）
 */
export function noticeId(change: CheckedChange): string {
  const { content } = change;
  if (content.kind !== "announcement") return `n-${change.fingerprint}`;
  const key = createHash("sha256")
    .update(JSON.stringify([content.festivalId, content.date, content.topic]))
    .digest("hex")
    .slice(0, 32);
  return `n-a-${key}`;
}

/** 通知の形を確かめて作る */
export function noticeFor(input: {
  change: CheckedChange;
  tripId: string;
  itinerary: Itinerary;
  festivalName: string;
  now: number;
}): GuideNotice {
  const { change, itinerary } = input;
  return GuideNoticeSchema.parse({
    ...change,
    id: noticeId(change),
    tripId: input.tripId,
    summary: noticeSummary(change.content, input.festivalName),
    affectedItemIds: affectedItems(itinerary, change.content),
    proposalId: null,
    createdAt: nowInJapan(new Date(input.now)),
    readAt: null,
  });
}

/** 通知を消す時刻（旅の最終日から30日） */
export function noticeExpiresAt(itinerary: Itinerary): number {
  const last: IsoDate = itinerary.days.at(-1)?.date ?? "1970-01-01";
  return Date.parse(`${addDays(last, NOTICE_RETENTION_DAYS)}T00:00:00+09:00`);
}

/** 上限に達しても残す通知（開催の変更と中止） */
export function isFirmNotice(notice: Pick<GuideNotice, "content">): boolean {
  return notice.content.kind === "schedule_change" || notice.content.kind === "cancellation";
}

/**
 * 役目を終えた声かけ。届けてから声をかけてよい時間（MAX_CALL_DELAY_MS）が過ぎたもので、
 * 未読でも、上限のときに押し出してよい
 */
export function isSpentReminder(notice: { kind: string; createdAt: string }, now: number): boolean {
  const created = Date.parse(notice.createdAt);
  return (
    notice.kind === "reminder" && Number.isFinite(created) && created + MAX_CALL_DELAY_MS <= now
  );
}

/**
 * 上限に達したときに押し出す通知の ID。役目を終えた声かけ、古いお知らせ、読んだ古い通知の順に選ぶ。
 * 未読の開催の変更と中止は押し出さない。onlySpentReminders なら、役目を終えた声かけだけから選ぶ
 * （新しい声かけのために、ほかの通知を押し出さない）。選べなければ null
 */
export function noticeToEvict(
  notices: readonly { id: string; kind: string; createdAt: string; readAt: string | null }[],
  now: number,
  options: { onlySpentReminders?: boolean } = {},
): string | null {
  const oldest = (items: readonly { id: string; createdAt: string }[]) =>
    [...items].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0]?.id ?? null;
  const spent = oldest(notices.filter((notice) => isSpentReminder(notice, now)));
  if (options.onlySpentReminders === true) return spent;
  return (
    spent ??
    oldest(notices.filter((notice) => notice.kind === "announcement")) ??
    oldest(notices.filter((notice) => notice.readAt !== null))
  );
}

/** 上限に達したときに、押し出してでも足す通知か。開催の変更と中止は何を押し出してもよく、声かけは役目を終えた声かけだけを押し出せる */
export function evictionFor(
  notice: Pick<GuideNotice, "content">,
): "any" | "spent_reminders" | null {
  if (isFirmNotice(notice)) return "any";
  return notice.content.kind === "reminder" ? "spent_reminders" : null;
}
