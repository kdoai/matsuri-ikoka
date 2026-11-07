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

export function noticeId(change: CheckedChange): string {
  return `n-${change.fingerprint}`;
}

/** 通知の形を確かめて作る。同じ変化からは同じ ID になるので、同じ旅に2度届かない */
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
